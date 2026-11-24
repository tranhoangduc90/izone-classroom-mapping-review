import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {clockSchema, commitListeningClock, enrollListeningClock, parseClockOperation} from './listening-clock.mjs';

const {PGlite} = await import(process.env.TERM2_CLOCK_PGLITE_ENTRY
  ? pathToFileURL(process.env.TERM2_CLOCK_PGLITE_ENTRY).href : '@electric-sql/pglite');
const durationMs = 1824000;
const startMs = Date.parse('2026-11-24T01:00:00.000Z');
const at = delta => new Date(startMs + delta).toISOString();
const db = new PGlite();
const ready = db.exec(`
  CREATE SCHEMA assessment;
  CREATE TABLE assessment.term2_offline_run (attempt_id uuid PRIMARY KEY, state jsonb NOT NULL);
  ${clockSchema}
`);
test.after(async () => { await db.close(); });

async function enrolled() {
  await ready;
  const attemptId = randomUUID();
  const run = {attempt_id: attemptId, generation: 0, state:{listeningRecoveryVersion:1,listening:{startedAt:at(0)}}};
  await db.query('INSERT INTO assessment.term2_offline_run VALUES ($1,$2::jsonb)',[attemptId, JSON.stringify(run.state)]);
  const attempt = {attempt_token:attemptId,attempt_mode:'cbt',server_now:at(600000)};
  const commit = operation => db.transaction(async client => {
    await client.query('SELECT state FROM assessment.term2_offline_run WHERE attempt_id=$1 FOR UPDATE',[attemptId]);
    return commitListeningClock(client, {run,attempt,durationMs,operation:parseClockOperation(operation)});
  });
  return {attemptId, run, attempt, commit};
}
function operation(expectedRevision, phase, positionMs, observedAt, extra = {}) {
  return {operationId:randomUUID(),playerId:randomUUID(),expectedRevision,phase,positionMs,observedAt,resumeCount:0,
    interruptionId:null,recoverable:null,...extra};
}
const hold = interruptionId => ({interruptionId,recoverable:true});

test('a lost acknowledgement resends the exact receipt without advancing time twice', async () => {
  const {attemptId,commit} = await enrolled();
  const id=randomUUID();
  const paused=operation(0,'paused',53122,at(53200),hold(id));
  const stopped=await commit(paused);
  assert.equal(stopped.clock.remainingMs,durationMs-53122);
  assert.deepEqual(await commit(paused),stopped);
  await assert.rejects(commit({...paused,positionMs:53123}),{code:'LISTENING_CLOCK_OPERATION_CONFLICT'});
  const restarted=operation(1,'running',53242,at(68000),{resumeCount:1,interruptionId:id});
  const proof=await commit(restarted);
  assert.equal(proof.clock.remainingMs,durationMs-53242);
  assert.deepEqual(await commit(restarted),proof);
  const stored=(await db.query('SELECT revision,snapshot FROM assessment.term2_offline_listening_clock WHERE attempt_id=$1',[attemptId])).rows[0];
  assert.deepEqual(stored,{revision:2,snapshot:proof.clock});
  const count=(await db.query('SELECT count(*)::int AS count FROM assessment.term2_offline_listening_clock_operation WHERE attempt_id=$1',[attemptId])).rows[0].count;
  assert.equal(count,2);
});

test('uncorrelated movement and stale writes cannot overwrite the frozen checkpoint', async () => {
  const {commit} = await enrolled();
  const id=randomUUID();
  await assert.rejects(commit(operation(0,'progress',500,at(530),hold(id))),{code:'LISTENING_CLOCK_INVALID'});
  await assert.rejects(commit(operation(0,'running',500,at(530),{interruptionId:id,resumeCount:1})),{code:'LISTENING_CLOCK_RESUME_INVALID'});
  await assert.rejects(commit(operation(0,'paused',50000,at(270),hold(id))),{code:'LISTENING_CLOCK_TIME_CONFLICT'});
  await commit(operation(0,'paused',500,at(650),hold(id)));
  await assert.rejects(commit(operation(0,'running',600,at(1000),{interruptionId:id,resumeCount:1})),{code:'LISTENING_CLOCK_REVISION_CONFLICT'});
  await assert.rejects(commit(operation(1,'paused',500,at(1800),hold(id))),{code:'LISTENING_CLOCK_PAUSED'});
  await assert.rejects(commit(operation(1,'running',600,at(1800),{interruptionId:randomUUID(),resumeCount:1})),{code:'LISTENING_CLOCK_RESUME_INVALID'});
  await assert.rejects(commit(operation(1,'running',8000,at(20000),{interruptionId:id,resumeCount:1})),{code:'LISTENING_CLOCK_RESUME_INVALID'});
});

test('after two resumptions a freeze cannot become recoverable', async () => {
  const {commit} = await enrolled();
  const first=randomUUID(), second=randomUUID();
  await commit(operation(0,'paused',500,at(800),hold(first)));
  await commit(operation(1,'running',620,at(1800),{interruptionId:first,resumeCount:1}));
  await commit(operation(2,'paused',1000,at(2300),{...hold(second),resumeCount:1}));
  await commit(operation(3,'running',1120,at(3200),{interruptionId:second,resumeCount:2}));
  const id=randomUUID();
  await assert.rejects(commit(operation(4,'paused',1400,at(3700),{...hold(id),resumeCount:2})),{code:'LISTENING_CLOCK_CLOSED'});
  const stopped=await commit(operation(4,'paused',1400,at(3700),{interruptionId:id,recoverable:false,resumeCount:2}));
  assert.equal(stopped.clock.recoverable,false);
  await assert.rejects(commit(operation(5,'running',1580,at(4700),{interruptionId:id,resumeCount:2})),{code:'LISTENING_CLOCK_RESUME_INVALID'});
});

test('authorization is bound to opted-in CBT runs that have started', async () => {
  const {commit,run,attempt} = await enrolled();
  const first=operation(0,'paused',0,at(300),hold(randomUUID()));
  attempt.attempt_mode='answer_sheet';
  await assert.rejects(commit(first),{code:'LISTENING_CLOCK_NOT_ENABLED'});
  attempt.attempt_mode='cbt';
  delete run.state.listeningRecoveryVersion;
  await assert.rejects(commit(first),{code:'LISTENING_CLOCK_NOT_ENABLED'});
  run.state.listeningRecoveryVersion=1;
  delete run.state.listening;
  await assert.rejects(commit(first),{code:'LISTENING_CLOCK_START_REQUIRED'});
});

test('a release enrollment stays off for existing Listening, paper and an off flag', async () => {
  await ready;
  const newRun={attempt_id:randomUUID(),state:{}};
  await db.query('INSERT INTO assessment.term2_offline_run VALUES ($1,$2::jsonb)',[newRun.attempt_id, '{}']);
  assert.equal(await enrollListeningClock(db,newRun,{attempt_mode:'answer_sheet'},true),newRun);
  assert.equal(await enrollListeningClock(db,newRun,{attempt_mode:'cbt',listening_started_at:at(120)},true),newRun);
  assert.equal(await enrollListeningClock(db,newRun,{attempt_mode:'cbt'},false),newRun);
  const enrolledRun=await enrollListeningClock(db,newRun,{attempt_mode:'cbt'},true);
  assert.equal(enrolledRun.state.listeningRecoveryVersion,1);
});
