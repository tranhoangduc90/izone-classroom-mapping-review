import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createTerm1FallbackListeningReportResolver,createTerm1OfflineListeningReportResolver} from './listening-report-native.mjs';
import {createTerm1ListeningReportIngress} from './listening-report-ingress.mjs';
import {createTerm1ListeningReportQueue,term1ListeningReportSchema} from './listening-report-queue.mjs';

const require=createRequire(process.env.SUBMIT_DEPS_PACKAGE||new URL('../../../../products/term-mini-k67/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const pngBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';

test('Term 1 K56 report uses the accepted manual interruption and matches the native owner',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  const query=db.query.bind(db);
  await db.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_exam_session (id uuid PRIMARY KEY, generation bigint, superseded_at timestamptz);
    CREATE TABLE assessment.term_test_attempt (id uuid PRIMARY KEY, exam_session_id uuid, generation bigint,
      test_slug text, attempt_mode text, student_name_snapshot text, class_name_snapshot text,
      superseded_at timestamptz, listening_interrupted_at timestamptz);
    CREATE TABLE assessment.term1_offline_run (attempt_id uuid PRIMARY KEY, session_id uuid, generation bigint,
      owner_id uuid, prepared_at timestamptz, policy text, state jsonb);
    CREATE TABLE assessment.term1_offline_operation (operation_id uuid PRIMARY KEY, attempt_id uuid,
      kind text, section text, payload jsonb, receipt jsonb);
    ${term1ListeningReportSchema}
  `);
  const now=Date.now();
  const reportedAt=new Date(now-1000).toISOString(),startedAt=new Date(now-55000).toISOString();
  const [attemptToken,examSessionToken,ownerId,operationId]=Array.from({length:4},()=>randomUUID());
  const generation=3;
  await query('INSERT INTO assessment.term_test_exam_session VALUES ($1,$2,NULL)',[examSessionToken,generation]);
  await query("INSERT INTO assessment.term_test_attempt VALUES ($1,$2,$3,'term-test-1-k56','cbt','Nguyễn Văn Mẫu','IC DEMO',NULL,$4)",
    [attemptToken,examSessionToken,generation,reportedAt]);
  await query("INSERT INTO assessment.term1_offline_run VALUES ($1,$2,$3,$4,$5,'term1-offline-v1',$6::jsonb)",
    [attemptToken,examSessionToken,generation,ownerId,startedAt,JSON.stringify({listening:{operationId}})]);
  const nativePayload=reason=>JSON.stringify({occurredAt:reportedAt,payload:{startedAt,interruptionReason:reason}});
  await query("INSERT INTO assessment.term1_offline_operation VALUES ($1,$2,'interrupt','listening',$3::jsonb,$4::jsonb)",
    [operationId,attemptToken,nativePayload('learner_cannot_hear'),JSON.stringify({status:'accepted',examSessionToken,generation})]);
  const permit='a'.repeat(64), destination=[];
  const queue=createTerm1ListeningReportQueue({query,sendText(){throw Error('unexpected text');},sendPhoto(item){
    destination.push(item);
    return {acceptedByProvider:true,messageId:'19'};
  }});
  const resolveReport=createTerm1OfflineListeningReportResolver({query,makePermit(row){
    assert.equal(row.owner_id,ownerId);
    return permit;
  }});
  const submit=createTerm1ListeningReportIngress({resolveReport,queue});
  const request={attemptToken,examSessionToken,ownerId,generation,operationId,reportedAt,pngBase64,
    mode:'offline',audioHash:'c7766f97758ec5ecdd3b69dfd3f762567a50bdbb0fd38930a2b609879e8439fc',positionSeconds:72};
  for(const invalid of [
    {...request,positionSeconds:355.206},
    {...request,reportedAt:'không có UTC'},
    {...request,studentName:'mạo danh'},
  ])await assert.rejects(()=>submit(invalid,permit),error=>error.status===400);
  for(const invalid of [
    {...request,ownerId:randomUUID()}, {...request,operationId:randomUUID()}, {...request,generation:4},
  ])await assert.rejects(()=>submit(invalid,permit),error=>error.status===403);
  await assert.rejects(()=>submit(request,'b'.repeat(64)),error=>error.status===403);
  await query('UPDATE assessment.term1_offline_operation SET payload=$1::jsonb',[nativePayload('page_interrupted')]);
  await assert.rejects(()=>submit(request,permit),error=>error.status===403);
  await query('UPDATE assessment.term1_offline_operation SET payload=$1::jsonb',[nativePayload('learner_cannot_hear')]);
  const result=await submit(request,permit);
  assert.deepEqual(await submit(request,permit),result);
  assert.equal((await queue.runOne()).status,'sent');
  assert.equal(destination.length,1);
  assert.equal(destination[0].id,result.incidentId);
  assert.equal(destination[0].png.toString('base64'),pngBase64);
  assert.match(destination[0].caption,/Nguyễn Văn Mẫu/);
  assert.match(destination[0].caption,/IC DEMO/);
  assert.match(destination[0].caption,/ca chưa đối soát lịch/);
  assert.match(destination[0].caption,/72.0 giây/);
  for(const credential of [permit,attemptToken,examSessionToken,ownerId])assert.ok(!destination[0].caption.includes(credential));
});

test('Listening fallback uses the bound grant but queues under the canonical attempt',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  const query=db.query.bind(db);
  await db.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_exam_session (id uuid PRIMARY KEY, generation int, superseded_at timestamptz);
    CREATE TABLE assessment.term_test_attempt (id uuid PRIMARY KEY, exam_session_id uuid, generation int, class_id int,
      test_slug text, attempt_mode text, student_name_snapshot text, class_name_snapshot text,
      superseded_at timestamptz, listening_interrupted_at timestamptz);
    CREATE TABLE assessment.term1_skill_grant (id uuid PRIMARY KEY, attempt_id uuid, session_id uuid,
      generation int, class_id int, owner_id uuid, secret_hash text, section text, revoked_at timestamptz, bound_at timestamptz);
    CREATE TABLE assessment.term1_offline_run (attempt_id uuid PRIMARY KEY, session_id uuid, generation int, policy text, state jsonb);
    CREATE TABLE assessment.term1_offline_operation (operation_id uuid PRIMARY KEY, attempt_id uuid,
      kind text, section text, payload jsonb, receipt jsonb);
    ${term1ListeningReportSchema}
  `);
  const [grant,attempt,session,ownerId,operationId]=Array.from({length:5},()=>randomUUID());
  const secret=randomBytes(32).toString('base64url');
  const capability=grant+'.'+secret;
  const generation=1;
  const time=Date.now();
  const startedAt=new Date(time-73000).toISOString(),reportedAt=new Date(time-1000).toISOString();
  await query('INSERT INTO assessment.term_test_exam_session VALUES ($1,$2,NULL)',[session,generation]);
  await query("INSERT INTO assessment.term_test_attempt VALUES ($1,$2,$3,31,'term-test-1-k56','cbt','Học viên giả','Lớp thử',NULL,$4)",
    [attempt,session,generation,reportedAt]);
  await query("INSERT INTO assessment.term1_skill_grant VALUES ($1,$2,$3,$4,31,$5,$6,'listening',NULL,now())",
    [grant,attempt,session,generation,ownerId,createHash('sha256').update(secret).digest('hex')]);
  await query("INSERT INTO assessment.term1_offline_run VALUES ($1,$2,$3,'term1-offline-v1',$4)",
    [attempt,session,generation,JSON.stringify({listening:{operationId}})]);
  await query("INSERT INTO assessment.term1_offline_operation VALUES ($1,$2,'interrupt','listening',$3,$4)",
    [operationId,attempt,JSON.stringify({occurredAt:reportedAt,payload:{startedAt,interruptionReason:'learner_cannot_hear'}}),
      JSON.stringify({status:'accepted',attemptToken:grant,examSessionToken:grant,generation})]);
  const observed=[];
  const queue=createTerm1ListeningReportQueue({query,sendText:async()=>assert.fail(),
    sendPhoto:async()=>({acceptedByProvider:true,messageId:'31'})});
  const submit=createTerm1ListeningReportIngress({queue,observe:entry=>observed.push(entry),
    resolveReport:createTerm1FallbackListeningReportResolver({query})});
  const report={attemptToken:grant,examSessionToken:grant,ownerId,generation,operationId,reportedAt,pngBase64,
    mode:'fallback',audioHash:'c7766f97758ec5ecdd3b69dfd3f762567a50bdbb0fd38930a2b609879e8439fc',positionSeconds:72};
  await assert.rejects(()=>submit({...report,ownerId:randomUUID()},capability),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  await assert.rejects(()=>submit({...report,examSessionToken:session},capability),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  const next=await submit(report,capability);
  assert.equal(observed[0].attemptId,attempt);
  assert.equal((await queue.runOne()).status,'sent');
  assert.equal((await query('SELECT attempt_id FROM assessment.term1_k56_listening_report WHERE incident_id=$1',[next.incidentId]))
    .rows[0].attempt_id,attempt);
  await query('UPDATE assessment.term1_skill_grant SET revoked_at=now() WHERE id=$1',[grant]);
  await assert.rejects(()=>submit(report,capability),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
});
