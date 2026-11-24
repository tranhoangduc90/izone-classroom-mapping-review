import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

const entry = process.env.TERM2_NATIVE_RECOVERY_FIXTURE;
const flag = 'TERM2_LISTENING_RECOVERY_V1';

test('native HTTP enables fresh attempts and drains enrolled attempts after flag rollback',
  {skip: !entry && 'Requires a captured K56 application with an isolated database'}, async () => {
    const {createNativeRecoveryFixture} = await import(pathToFileURL(entry).href);
    const previousFlag = process.env[flag];
    const app = await createNativeRecoveryFixture();
    const identity = {classCode:app.classCode,studentRef:app.student,mode:'lis_first',attemptMode:'cbt',
      identityConfirmed:true,term2ContinuationVersion:1};
    async function post(path, body, permit) {
      const response = await fetch(app.base + path, {method:'POST', headers:{'content-type':'application/json',
        ...(permit ? {'x-term2-permit':permit} : {})}, body:JSON.stringify(body)});
      return {status:response.status, json:await response.json()};
    }
    async function prepare(scope) {
      const result = await post('/offline/prepare',{classCode:identity.classCode,studentRef:identity.studentRef,
        mode:identity.mode,audioTransport:'r2-direct-v1', ...scope});
      assert.equal(result.status,200,JSON.stringify(result.json));
      return result.json.offline;
    }
    async function createAttempt() {
      const result = await post('/attempt/prepare',identity);
      assert.equal(result.status,200,JSON.stringify(result.json));
      const {attemptToken,examSessionToken,generation} = result.json;
      const scope = {attemptToken,examSessionToken,generation,ownerId:randomUUID()};
      return {scope,offline:await prepare(scope)};
    }
    async function startListening({scope,offline}) {
      const startedAt = new Date().toISOString();
      const result = await post('/offline/operation',{...scope,section:'listening',kind:'start',operationId:randomUUID(),
        dependency:null,revision:0,occurredAt:startedAt,payload:{startedAt,deadlineAt:null,timeValid:true,answers:{}}},offline.permit);
      assert.equal(result.json.receipt?.status,'accepted',JSON.stringify(result.json));
    }
    const operation = (phase, interruptionId, extra = {}) => ({phase,interruptionId,expectedRevision:0,positionMs:0,
      operationId:randomUUID(),playerId:randomUUID(),observedAt:new Date().toISOString(),resumeCount:0,recoverable:true,...extra});
    const send = (attempt, body) => post('/offline/listening-clock',{...attempt.scope,...body},attempt.offline.permit);

    try {
      process.env[flag] = 'false';
      const legacy = await createAttempt();
      assert.equal(legacy.offline.listeningRecoveryVersion,undefined);
      await startListening(legacy);

      process.env[flag] = 'true';
      assert.equal((await prepare(legacy.scope)).listeningRecoveryVersion,undefined);
      const rejected = await send(legacy,operation('paused',randomUUID()));
      assert.equal(rejected.status,403);
      assert.equal(rejected.json.error,'LISTENING_CLOCK_NOT_ENABLED');
      const enrolled = await createAttempt();
      assert.equal(enrolled.offline.listeningRecoveryVersion,1);
      assert.notEqual(enrolled.scope.attemptToken,legacy.scope.attemptToken);
      await startListening(enrolled);
      const interruption = randomUUID();
      const heldRequest = operation('paused',interruption);
      const held = await send(enrolled,heldRequest);
      assert.equal(held.status,200,JSON.stringify(held.json));

      process.env[flag] = 'false';
      const fresh = await createAttempt();
      assert.equal(fresh.offline.listeningRecoveryVersion,undefined);
      assert.equal((await prepare(enrolled.scope)).listeningRecoveryVersion,1);
      assert.deepEqual(await send(enrolled,heldRequest),held);
      const resumed = await send(enrolled,operation('running',interruption,{expectedRevision:1,positionMs:130,
        resumeCount:1,recoverable:null,playerId:heldRequest.playerId}));
      assert.equal(resumed.status,200,JSON.stringify(resumed.json));
      const stored = await app.read(enrolled.scope);
      assert.equal(stored.clock.revision,2);
      assert.equal(stored.events.length,2);
      assert.deepEqual(stored.events.map(row=>row.operationId),[held.json.operationId,resumed.json.operationId]);
      assert.equal(stored.session.listening_submitted_at,null);
      assert.equal((await app.read(legacy.scope)).events.length,0);
      assert.equal((await app.read(fresh.scope)).events.length,0);
      if (process.env.TERM2_ROLLOUT_EVIDENCE) await writeFile(process.env.TERM2_ROLLOUT_EVIDENCE,JSON.stringify({
        profile:app.classCode,isolatedDatabase:true,legacyDenied:rejected.status,enabledForFresh:true,
        stoppedEnrollment:true,drainedAfterRollback:true,receipts:stored.events.length,revision:stored.clock.revision,
      },null,2));
    } finally {
      if (previousFlag === undefined) delete process.env[flag];
      else process.env[flag] = previousFlag;
      await app.close();
    }
  });
