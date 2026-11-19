import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {resolve, sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {assembleEntry,assembleRecovery} from './assemble-overlay.mjs';
import {assembleWriting,writingFile} from './assemble-writing.mjs';

const [evidencePath] = process.argv.slice(2);
assert.ok(evidencePath, 'Pass the directory containing the pinned runtime and local test harness.');
const evidence = pathToFileURL(resolve(evidencePath) + sep);
const runtime = new URL('mini-k56-browser-api-runtime-fixture-74fa7a02/', evidence);
const fixtureFile = new URL('term1-k56-candidate/baseline/fixture.mjs', evidence);
const overlays = new Map();
const writingSql = await readFile(new URL('src/k56-term-writing-draft.js',runtime));
for (const [file, assemble] of [
  ['k56-exam-order.js',assembleEntry], ['term-online-submission.mjs',assembleRecovery],
  [writingFile,bytes=>assembleWriting(bytes,writingSql)],
]) {
  const url = new URL('src/' + file, runtime);
  overlays.set(url.href, assemble(await readFile(url)));
}
// Add the real transactional grading service to the small existing HTTP harness.
// The presentation adapter only exposes the fields asserted by this fixture.
let fixtureSource = (await readFile(fixtureFile,'utf8')).replaceAll('\r\n','\n');
const oldGrading = `   secret:'x'.repeat(40),readPortalSyncStatus:async()=>null,requestPortalSync:async()=>{},onWriting:async row=>{calls++;await grading.ensureSubmission({attemptToken:row.attempt_token,
    testSlug:mod.SLUG,task1:PRODUCT===2?row.writing_task_1:'',task2:PRODUCT===1?row.writing_task_2:'',taskDefinitions:content.writing.tasks});}});`;
assert.equal(fixtureSource.split(oldGrading).length,2,'Fixture grading adapter moved');
fixtureSource = fixtureSource.replace(oldGrading,`   secret:'x'.repeat(40),readPortalSyncStatus:async()=>null,requestPortalSync:async()=>{},
   serializeOnlineWriting: fixtureWriting,
   readOnlineWriting: async (client,row) => ({writing:fixtureWriting(row,await grading.getStatus(row.attempt_token,client))}),
   onWriting: async (row, client, options) => {
    calls++;
    return grading.ensureSubmission({attemptToken:row.attempt_token, testSlug:mod.SLUG,
      task1:row.writing_task_1, task2:row.writing_task_2, taskDefinitions:content.writing.tasks},client,options);
   }});
   registerPaperFixture(app);
   const drainRouter = express.Router();
   const previousPaperMode = process.env.K56_TERM2_PAPER_PARALLEL_ENTRY_MODE;
   try {
    process.env.K56_TERM2_PAPER_PARALLEL_ENTRY_MODE = 'drain';
    registerPaperFixture(drainRouter);
   } finally {
    process.env.K56_TERM2_PAPER_PARALLEL_ENTRY_MODE = previousPaperMode;
   }
   app.use('/drain', drainRouter);
   function fixtureWriting(row,grading) {
    return {task1:row.writing_task_1,task2:row.writing_task_2,outline:row.writing_outline,
      revision:Number(row.writing_draft_revision),startedAt:row.writing_started_at,
      deadlineAt:row.writing_deadline_at,submitted:Boolean(row.writing_submitted_at),grading};
   }`);
const paperRouter = 'registerK56ExamOrder(app,{';
assert.equal(fixtureSource.split(paperRouter).length,2,'Fixture registration anchor moved');
fixtureSource = fixtureSource.replace(paperRouter,'const registerPaperFixture = target => registerK56ExamOrder(target,{');
const fixtureMount = ' app.use((e,q,r,n)=>r.status(500)';
assert.equal(fixtureSource.split(fixtureMount).length,2,'Fixture middleware anchor moved');
fixtureSource = fixtureSource.replace(fixtureMount,` if (process.env.K56_PAPER_BROWSER_NATIVE_START === '1') {
   const {checkpointK56ListeningAudio} = await import(pathToFileURL(runtime+'/src/k56-listening-audio-recovery.js'));
   app.post('/api/term-tests/:testSlug/session/start', async (req,res,next) => {
    try {
     const started = await checkpointK56ListeningAudio(pool,{
      token:req.body.examSessionToken,slug:req.params.testSlug,generation:req.body.generation,state:'resume',
      startTotalSeconds:audioSeconds,listeningDurationSeconds:audioSeconds
     });
     res.json({ok:true,examSessionToken:started.exam_session_token,listeningStartedAt:started.listening_started_at,
       listeningDeadlineAt:started.listening_deadline_at,serverNow:started.server_now});
    } catch (error) {
     if (!error.status) return next(error);
     res.status(error.status).json({ok:false,error:error.code,message:error.message});
    }
   });
 }
`+fixtureMount);
overlays.set(fixtureFile.href,fixtureSource);
const hook = registerHooks({
  load(url, context, next) {
    if (overlays.has(url)) return {format:'module', source:overlays.get(url), shortCircuit:true};
    return next(url, context);
  },
});
process.env.TERM2_RUNTIME_ROOT = fileURLToPath(runtime).replaceAll('\\', '/').replace(/\/$/, '');
process.env.TERM2_DEPS_PACKAGE = process.env.TERM2_RUNTIME_ROOT + '/package.json';
process.env.K56_TEST_PRODUCT = '2';
process.env.K56_REAL_ROSTER_FIXTURE = '1';
process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
process.env.K56_TERM2_PARALLEL_ENTRY_MODE = 'on';
process.env.K56_TERM2_PAPER_PARALLEL_ENTRY_MODE = 'on';
process.env.K56_TERM_ONLINE_HOLD_CLASSES = 'FIXTURE';
process.env.K56_TERM_ONLINE_HOLD_HOURS = '2';
process.env.K56_TERM_ONLINE_HOLD_LIMIT = '16';
delete process.env.K56_TERM_HOLD_SCOPE_FILE;
delete process.env.TERM2_TEST_PG_URL;

const {fixture} = await import(fixtureFile);
let loseResponseFor;
const events = [];
const f = await fixture('read_first', {skipPrepare:true, realtime:true, listeningInterruption:true,
  record: (event,slug,token,details) => events.push({event,slug,token,details}),
  dropResponse(body, reply) {
    if (!loseResponseFor || body.recovery?.operationId !== loseResponseFor || !reply.receipt) return false;
    loseResponseFor = undefined;
    return true;
  },
});
const query = f.db.query.bind(f.db);
f.db.query = async (...args) => {
  const result = await query(...args);
  return {...result, rowCount:result.rowCount ?? (result.rows?.length || result.affectedRows || 0)};
};
try {
  await f.db.exec(`DELETE FROM assessment.term_test_attempt;
    DELETE FROM assessment.term_test_exam_session;
    INSERT INTO assessment.term_test_class_access VALUES ('term-test-2-k56',5601,true);
    ALTER TABLE assessment.term_test_attempt
      ADD COLUMN IF NOT EXISTS submission_hold_hours int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS submission_hold_limit int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS writing_outline text NOT NULL DEFAULT '';
    CREATE TABLE assessment.term_online_submission_hold (
      attempt_id uuid NOT NULL,generation bigint NOT NULL,operation_id uuid NOT NULL,
      section text NOT NULL,payload_hash text NOT NULL,payload jsonb,receipt jsonb,
      held_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,writing_grading_run_id uuid,
      PRIMARY KEY(attempt_id,generation,operation_id)
    );
    CREATE TABLE assessment.term2_submission_hold (LIKE assessment.term_online_submission_hold INCLUDING ALL);`);
  await f.db.exec(await readFile(new URL('../term2-k56-first-valid-20261118/migration.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('./migration.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('./legacy-bridge.sql',import.meta.url),'utf8'));
  if (process.env.K56_PAPER_BROWSER_NATIVE_START === '1') {
    await f.db.exec(`ALTER TABLE assessment.term_test_exam_session
      ADD COLUMN IF NOT EXISTS listening_resume_offset_seconds numeric NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS listening_audio_checkpoint_at timestamptz,
      ADD COLUMN IF NOT EXISTS listening_audio_state text,
      ADD COLUMN IF NOT EXISTS listening_audio_interrupted_at timestamptz,
      ADD COLUMN IF NOT EXISTS listening_audio_interrupted_seconds numeric,
      ADD COLUMN IF NOT EXISTS listening_audio_interruption_id uuid,
      ADD COLUMN IF NOT EXISTS listening_audio_owner_id uuid,
      ADD COLUMN IF NOT EXISTS listening_audio_legacy_recovery_id uuid,
      ADD COLUMN IF NOT EXISTS listening_recovery_seconds numeric NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS audio_state_revision bigint NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS assessment.term_test_audio_recovery_receipt (
        session_id uuid,recovery_id uuid,granted_seconds numeric,PRIMARY KEY(session_id,recovery_id)
      );`);
  }

  const identity = {classCode:'FIXTURE', studentRef:f.student, submissionRecovery:1};
  const aProfile = {...identity, term2PaperProfileId:randomUUID(), identityConfirmed:true};
  const bProfile = {...aProfile, term2PaperProfileId:randomUUID()};
  async function request(path, body, expectedStatus = 200) {
    const result = await f.request(path,body);
    assert.equal(result.status,expectedStatus,JSON.stringify({path,result}));
    return result;
  }
  const tokens = a => ({attemptToken:a.attemptToken, generation:a.generation});
  const scope = (a, owner = identity) => ({...tokens(a), examSessionToken:a.examSessionToken,
    classCode:owner.classCode, studentRef:owner.studentRef});
  const readFirst = 'read_first';
  const listenFirst = 'lis_first';
  const prepare = '/attempt/prepare';

  // Adopt an already-started cached paper client without changing its scope.
  const old = await request(prepare, {...identity,mode:readFirst});
  await request('/reading/start',tokens(old));
  assert.equal((await request('/reading/draft',{...tokens(old),revision:1,answers:{1:'A'}})).accepted,true);
  const secondOld = await request(prepare,{...identity,mode:listenFirst});
  assert.deepEqual(scope(secondOld),scope(old));
  await request(prepare,{...aProfile,mode:readFirst,identityConfirmed:false},400);
  await request(prepare,{...aProfile,mode:readFirst,studentRef:randomUUID()},404);
  const first = await request(prepare,{...aProfile,...scope(old),mode:readFirst});
  assert.equal(first.attemptToken,old.attemptToken);
  assert.equal(first.examSessionToken,old.examSessionToken);
  assert.equal(first.term2PaperParallelEntry,true);
  const drainBase = new URL(f.base);
  drainBase.pathname = '/drain' + drainBase.pathname;
  async function drainRequest(path, body, expectedStatus) {
    const response = await fetch(drainBase.href+path,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json();
    assert.equal(response.status,expectedStatus,JSON.stringify({path,result}));
    return result;
  }
  const rejectedNew = await drainRequest(prepare,{...bProfile,mode:readFirst},503);
  assert.equal(rejectedNew.error,'OFFLINE_NEW_DISABLED');
  const inProgress = await drainRequest(prepare,{...aProfile,...scope(first),mode:readFirst},200);
  assert.equal(inProgress.attemptToken,first.attemptToken);
  assert.equal(inProgress.examSessionToken,first.examSessionToken);
  assert.equal(inProgress.readingDeadlineAt,first.readingDeadlineAt);
  assert.deepEqual(inProgress.readingDraft,{'1':'A'});
  // Reopen by profile and confirm that another profile cannot claim the scope.
  const same = await request(prepare,{...aProfile,mode:listenFirst});
  assert.equal(same.attemptToken,first.attemptToken);
  assert.equal(same.examMode,readFirst);
  const wrongGeneration = await request(prepare,{...bProfile,...scope(secondOld),generation:1,mode:readFirst},403);
  assert.equal(wrongGeneration.error,'STUDENT_MISMATCH');
  const warmDrain = await drainRequest(prepare,{...bProfile,...scope(secondOld),mode:readFirst},503);
  assert.equal(warmDrain.error,'OFFLINE_NEW_DISABLED');

  const legacyBody = {...bProfile,...scope(secondOld),mode:listenFirst};
  const second = await request(prepare,legacyBody);
  assert.notEqual(first.attemptToken,second.attemptToken);
  assert.notEqual(first.examSessionToken,second.examSessionToken);
  assert.equal(second.examMode,readFirst);
  assert.equal(second.readingStartedAt,first.readingStartedAt);
  assert.equal(second.readingDeadlineAt,first.readingDeadlineAt);
  assert.deepEqual(second.readingDraft,{});
  assert.deepEqual(second.paperResumedFrom,{...tokens(secondOld),examSessionToken:secondOld.examSessionToken});
  const secondRetry = await request(prepare,legacyBody);
  assert.equal(secondRetry.attemptToken,second.attemptToken);
  assert.equal(secondRetry.examSessionToken,second.examSessionToken);
  assert.deepEqual(secondRetry.paperResumedFrom,second.paperResumedFrom);
  assert.equal((await drainRequest(prepare,legacyBody,200)).attemptToken,second.attemptToken);
  assert.deepEqual(events.filter(item=>item.event === 'term2_paper_legacy_resumed'),
    [{event:'term2_paper_legacy_resumed',slug:'term-test-2-k56',token:second.attemptToken,
      details:{generation:second.generation,legacyAttemptToken:secondOld.attemptToken}}]);
  const borrowed = await request(prepare,{...bProfile,term2PaperProfileId:randomUUID(),...scope(second),mode:readFirst},403);
  assert.equal(borrowed.error,'STUDENT_MISMATCH');
  await request('/reading/start',tokens(second));
  assert.equal((await request('/reading/draft',{...tokens(second),revision:2,answers:{1:'B'}})).accepted,true);
  const {rows:[aDraft]} = await f.db.query('SELECT reading_draft FROM assessment.term_test_attempt WHERE id=$1',[first.attemptToken]);
  assert.deepEqual(aDraft.reading_draft,{'1':'A'});

  // As in the serving regression, the original profile submits just past its deadline.
  await f.db.query("UPDATE assessment.term_test_attempt SET reading_deadline_at=now()-interval '1 minute' WHERE id=$1",[first.attemptToken]);
  const recovery = (a, owner) => ({...scope(a,owner),operationId:randomUUID(),capturedAt:new Date().toISOString(),automatic:false});
  const firstRecovery = recovery(first);
  const sealed = await drainRequest('/reading',{...tokens(first),draftRevision:1,answers:{1:'A'},recovery:firstRecovery},200);
  assert.equal(sealed.readingSubmitted,true);
  assert.ok(sealed.receipt);
  const confirmed = await drainRequest('/submission-recovery/status',{
    ...scope(first),operationId:firstRecovery.operationId,section:'reading'
  },200);
  assert.equal(confirmed.persisted,true);
  assert.deepEqual(confirmed.receipt,sealed.receipt);

  const secondRecovery = recovery(second);
  const retry = await request('/reading',{
    ...tokens(second),draftRevision:2,answers:{1:'B'},recovery:secondRecovery
  },409);
  assert.equal(retry.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
  assert.equal(retry.receipt,undefined);
  assert.ok(retry.held?.payloadHash);
  const secondReadback = await request('/submission-recovery/status',{
    ...scope(second),operationId:secondRecovery.operationId,section:'reading'
  });
  assert.equal(secondReadback.persisted,false);
  assert.equal(secondReadback.held.payloadHash,retry.held.payloadHash);

  // The focused HTTP fixture mounts the exam-order router. Seed the local
  // audio clock that the serving app's downstream session/start handler creates.
  const reopened = await request(prepare,{...bProfile,mode:readFirst});
  assert.equal(reopened.attemptToken,second.attemptToken);
  assert.equal(reopened.examSessionToken,second.examSessionToken);
  assert.equal(reopened.readingSubmitted,true);
  assert.equal(reopened.nextSection,'listening');
  assert.deepEqual(reopened.readingDraft,{'1':'B'});
  const seedListeningClock = a => f.db.query(
    "UPDATE assessment.term_test_exam_session SET listening_started_at=now(), listening_deadline_at=now()+interval '30 seconds' WHERE id=$1",
    [a.examSessionToken]);
  await seedListeningClock(second);
  const listeningRecovery = recovery(second);
  const listeningBody = {...scope(second), mode:readFirst, clientSubmissionId:randomUUID(),
    draftRevision:0, answers:{1:'B'}, recovery:listeningRecovery};
  loseResponseFor = listeningRecovery.operationId;
  await assert.rejects(f.request('/listening',listeningBody), {name:'TypeError'});
  assert.equal(loseResponseFor,undefined);
  const statusBody = {...scope(second),operationId:listeningRecovery.operationId,section:'listening'};
  const recovered = await request('/submission-recovery/status',statusBody);
  assert.equal(recovered.persisted,true);
  assert.equal(recovered.receipt.attemptToken,second.attemptToken);
  assert.equal(recovered.receipt.examSessionToken,second.examSessionToken);
  assert.equal(recovered.receipt.officialAttemptToken,first.attemptToken);
  assert.equal(recovered.response.attemptToken,second.attemptToken);
  assert.equal(recovered.response.nextSection,'writing');
  const replay = await request('/listening',listeningBody);
  assert.deepEqual(replay.receipt,recovered.receipt);
  const wrongScope = await request('/submission-recovery/status',{...statusBody,...scope(first)});
  assert.equal(wrongScope.persisted,false);
  const {rows:[pair]} = await f.db.query('SELECT listening_submitted_at FROM assessment.term_test_attempt WHERE id=$1',
    [second.attemptToken]);
  assert.equal(pair.listening_submitted_at,null);
  const {rows:[official]} = await f.db.query(`SELECT count(*)::int as n,
    min(reading_answers->>'1') as reading, min(listening_answers->>'1') as listening
    FROM assessment.term_test_attempt
    WHERE term2_official_submission`);
  assert.deepEqual(official,{n:1,reading:'A',listening:'B'});
  const {rows:outbox} = await f.db.query(`SELECT attempt_id::text,field
    FROM assessment.k56_portal_field_dispatch ORDER BY field`);
  assert.deepEqual(outbox,[{attempt_id:first.attemptToken,field:'listening'},
    {attempt_id:first.attemptToken,field:'reading'}]);

  const paperWriting = (a, action, task1 = '', baseRevision = null, outline = '') => ({
    ...tokens(a), action, task1, task2:'', outline, baseRevision
  });
  const firstEssay = 'First private writing draft.';
  const secondEssay = 'Second profile submits this essay for grading.';
  const secondOutline = 'The second outline stays outside grading.';
  async function readResult(a) {
    const reply = await fetch(new URL('result',f.base),{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({attemptToken:a.attemptToken})
    });
    assert.equal(reply.status,200);
    const result = await reply.json();
    assert.equal(result.exam.examSessionToken,a.examSessionToken);
    return result;
  }
  const startWriting = await request('/writing/draft',paperWriting(second,'start'));
  assert.equal(startWriting.writing.accepted,true);
  assert.ok(startWriting.writing.startedAt && startWriting.writing.deadlineAt);
  const otherStart = await request('/writing/draft',paperWriting(first,'start'));
  await request('/writing/draft',paperWriting(first,'draft',firstEssay,otherStart.writing.revision));
  const draft = await request('/writing/draft',paperWriting(second,'draft',secondEssay,
    startWriting.writing.revision,secondOutline));
  assert.equal(draft.writing.accepted,true);
  assert.equal(draft.writing.task1,secondEssay);
  assert.equal(draft.writing.deadlineAt,startWriting.writing.deadlineAt);
  assert.equal((await readResult(first)).writing.task1,firstEssay);
  assert.equal((await readResult(second)).writing.task1,secondEssay);
  const writingRows = async () => (await f.db.query(`SELECT id::text,writing_task_1,writing_outline,
    writing_submitted_at,writing_deadline_at
    FROM assessment.term_test_attempt WHERE id IN ($1,$2)`,[first.attemptToken,second.attemptToken])).rows;
  const beforeWriting = await writingRows();
  assert.equal(beforeWriting.find(a=>a.id===first.attemptToken).writing_task_1,firstEssay);
  assert.equal(beforeWriting.find(a=>a.id===second.attemptToken).writing_task_1,secondEssay);

  const finalize = (a, proof, task1, baseRevision, outline = '') => ({
    attemptToken:a.attemptToken, task1, task2:'', outline, baseRevision, recovery:proof
  });
  const stale = await request('/writing/finalize',finalize(second,recovery(second),'An old conflicting revision.',0),409);
  assert.equal(stale.error,'WRITING_REVISION_CONFLICT');
  assert.deepEqual(await writingRows(),beforeWriting);
  const writingRecovery = recovery(second);
  const finalBody = finalize(second,writingRecovery,secondEssay,draft.writing.revision,secondOutline);
  loseResponseFor = writingRecovery.operationId;
  await assert.rejects(f.request('/writing/finalize',finalBody),{name:'TypeError'});
  assert.equal(loseResponseFor,undefined);
  const writingStatus = await request('/submission-recovery/status',{
    ...scope(second),operationId:writingRecovery.operationId,section:'writing'
  });
  assert.equal(writingStatus.persisted,true);
  assert.equal(writingStatus.receipt.attemptToken,second.attemptToken);
  assert.equal(writingStatus.receipt.officialAttemptToken,first.attemptToken);
  assert.equal(writingStatus.response.writing.task1,secondEssay);
  assert.equal(writingStatus.response.writing.submitted,true);
  for (const profile of [first,second]) {
    const restored = await readResult(profile);
    assert.equal(restored.nextSection,'result');
    assert.equal(restored.writing.task1,secondEssay);
    assert.equal(restored.writing.submitted,true);
  }
  const repeatWriting = await request('/writing/finalize',finalBody);
  assert.deepEqual(repeatWriting.receipt,writingStatus.receipt);
  const rejectedWriting = await request('/writing/finalize',finalize(first,recovery(first),firstEssay,1),409);
  assert.equal(rejectedWriting.error,'WRITING_ALREADY_RECEIVED');
  const afterWriting = await writingRows();
  const accepted = afterWriting.find(a=>a.id===first.attemptToken);
  const privateSource = afterWriting.find(a=>a.id===second.attemptToken);
  assert.equal(accepted.writing_task_1,secondEssay);
  assert.equal(accepted.writing_outline,secondOutline);
  assert.deepEqual(accepted.writing_deadline_at,privateSource.writing_deadline_at);
  assert.ok(accepted.writing_submitted_at);
  assert.equal(privateSource.writing_submitted_at,null);
  const {rows:jobs} = await f.db.query(`SELECT r.attempt_id::text,r.essay_text,r.task_number,j.status
    FROM assessment.term_test_writing_grading_run r
    JOIN assessment.term_test_writing_grading_job j ON j.run_id=r.id`);
  assert.deepEqual(jobs,[{attempt_id:first.attemptToken,essay_text:secondEssay,task_number:1,status:'queued'}]);
  assert.equal(f.calls,1);
  const {rows:[gradeState]} = await f.db.query('SELECT status FROM assessment.term_test_writing_grading_final WHERE attempt_id=$1',
    [first.attemptToken]);
  assert.equal(gradeState.status,'waiting');

  // Reverse the order with another student. The first valid Listening seal
  // leaves a genuine Reading start and draft for the other browser.
  const other = {...identity, studentRef:randomUUID()};
  await f.db.query("INSERT INTO assessment.term_test_roster VALUES ('term-test-2-k56',5601,5603,$1,'Fixture Two',true)",
    [other.studentRef]);
  const otherPrepare = {...other,identityConfirmed:true};
  const listeningFirst = await request(prepare,{...otherPrepare,term2PaperProfileId:randomUUID(),mode:listenFirst});
  const resumeProfile = {...otherPrepare,term2PaperProfileId:randomUUID(),mode:listenFirst};
  const readingSecond = await request(prepare,resumeProfile);
  await seedListeningClock(listeningFirst);
  const listened = await request('/listening',{...scope(listeningFirst,other),mode:listenFirst,
    clientSubmissionId:randomUUID(),draftRevision:0,answers:{1:'A'},recovery:recovery(listeningFirst,other)});
  assert.equal(listened.nextSection,'reading');
  assert.equal((await request(prepare,resumeProfile)).nextSection,'reading');
  const readingOpen = await request('/reading/start',tokens(readingSecond));
  assert.equal(readingOpen.nextSection,'reading');
  assert.ok(readingOpen.readingStartedAt && readingOpen.readingDeadlineAt);
  assert.equal((await request('/reading/draft',{...tokens(readingSecond),revision:1,answers:{1:'B'}})).accepted,true);
  const readingRecovery = recovery(readingSecond,other);
  const readingDone = await request('/reading',{...tokens(readingSecond),draftRevision:1,answers:{1:'B'},recovery:readingRecovery});
  assert.equal(readingDone.nextSection,'writing');
  assert.equal(readingDone.receipt.officialAttemptToken,listeningFirst.attemptToken);
  const readingStatus = await request('/submission-recovery/status',{
    ...scope(readingSecond,other),operationId:readingRecovery.operationId,section:'reading'
  });
  assert.deepEqual(readingStatus.receipt,readingDone.receipt);
  assert.deepEqual((await f.db.query(`SELECT reading_answers->>'1' AS reading,
    listening_answers->>'1' AS listening, term2_official_submission FROM assessment.term_test_attempt WHERE id=$1`,
  [listeningFirst.attemptToken])).rows[0], {reading:'B',listening:'A',term2_official_submission:true});
  const distinct = await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt WHERE term2_official_submission');
  assert.equal(distinct.rows[0].n,2);

  const lateStart = await request('/writing/draft',paperWriting(readingSecond,'start'));
  const savedEssay = 'The saved essay is the official timed submission.';
  const lateEssay = 'A different edit arrived after the examination ended.';
  const savedDraft = await request('/writing/draft',paperWriting(readingSecond,'draft',savedEssay,lateStart.writing.revision));
  await f.db.query("UPDATE assessment.term_test_attempt SET writing_deadline_at=now()-interval '1 second' WHERE id=$1",
    [readingSecond.attemptToken]);
  const lateProof = recovery(readingSecond,other);
  const late = await request('/writing/finalize',finalize(readingSecond,lateProof,lateEssay,savedDraft.writing.revision),409);
  assert.equal(late.error,'WRITING_DEADLINE_EXPIRED');
  assert.ok(late.held?.payloadHash);
  const lateStatus = await request('/submission-recovery/status',{
    ...scope(readingSecond,other),operationId:lateProof.operationId,section:'writing'
  });
  assert.equal(lateStatus.persisted,false);
  assert.equal(lateStatus.held?.payloadHash,late.held.payloadHash);
  assert.equal((await readResult(readingSecond)).writing.task1,savedEssay);
  const heldLate = await f.db.query(`SELECT payload->'writing'->>'task1' AS essay
    FROM assessment.term_online_submission_hold WHERE attempt_id=$1 AND operation_id=$2`,
  [readingSecond.attemptToken,lateProof.operationId]);
  assert.equal(heldLate.rows[0].essay,lateEssay);
  const queuedLate = await f.db.query(`SELECT r.essay_text,j.status
    FROM assessment.term_test_writing_grading_run r JOIN assessment.term_test_writing_grading_job j ON j.run_id=r.id
    WHERE r.attempt_id=$1`,[listeningFirst.attemptToken]);
  assert.deepEqual(queuedLate.rows,[{essay_text:savedEssay,status:'queued'}]);
  assert.equal(f.calls,2);
  console.log('Passed both L/R orders, private Writing drafts, receipt readback, warm profile handoff and retry, exact legacy journal lineage, and drain admission.');
} finally {
  hook.deregister();
  await f.close();
}
