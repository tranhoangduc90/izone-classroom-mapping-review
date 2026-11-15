import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createTerm2OfflineListeningReportResolver} from './listening-report-native.mjs';
import {createTerm2ListeningReportIngress} from './listening-report-ingress.mjs';
import {createTerm2ListeningReportQueue,term2ListeningReportSchema} from './listening-report-queue.mjs';

const require=createRequire(process.env.SUBMIT_DEPS_PACKAGE||new URL('../../../../products/term-mini-k67/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const pngBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';

test('Term 2 K56 report uses the accepted manual interruption and matches the native owner',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  const query=db.query.bind(db);
  await db.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_exam_session (id uuid PRIMARY KEY, generation bigint, superseded_at timestamptz);
    CREATE TABLE assessment.term_test_attempt (id uuid PRIMARY KEY, exam_session_id uuid, generation bigint,
      test_slug text, attempt_mode text, student_name_snapshot text, class_name_snapshot text,
      superseded_at timestamptz, listening_interrupted_at timestamptz);
    CREATE TABLE assessment.term2_offline_run (attempt_id uuid PRIMARY KEY, session_id uuid, generation bigint,
      owner_id uuid, prepared_at timestamptz, policy text, state jsonb);
    CREATE TABLE assessment.term2_offline_operation (operation_id uuid PRIMARY KEY, attempt_id uuid,
      kind text, section text, payload jsonb, receipt jsonb);
    ${term2ListeningReportSchema}
  `);
  const now=Date.now();
  const reportedAt=new Date(now-1000).toISOString(),startedAt=new Date(now-55000).toISOString();
  const [attemptToken,examSessionToken,ownerId,operationId]=Array.from({length:4},()=>randomUUID());
  const generation=3;
  await query('INSERT INTO assessment.term_test_exam_session VALUES ($1,$2,NULL)',[examSessionToken,generation]);
  await query("INSERT INTO assessment.term_test_attempt VALUES ($1,$2,$3,'term-test-2-k56','cbt','Nguyễn Văn Mẫu','IC DEMO',NULL,$4)",
    [attemptToken,examSessionToken,generation,reportedAt]);
  await query("INSERT INTO assessment.term2_offline_run VALUES ($1,$2,$3,$4,$5,'term2-offline-v1',$6::jsonb)",
    [attemptToken,examSessionToken,generation,ownerId,startedAt,JSON.stringify({listening:{operationId}})]);
  const nativePayload=reason=>JSON.stringify({occurredAt:reportedAt,payload:{startedAt,interruptionReason:reason}});
  await query("INSERT INTO assessment.term2_offline_operation VALUES ($1,$2,'interrupt','listening',$3::jsonb,$4::jsonb)",
    [operationId,attemptToken,nativePayload('learner_cannot_hear'),JSON.stringify({status:'accepted',examSessionToken,generation})]);
  const permit='a'.repeat(64), destination=[];
  const queue=createTerm2ListeningReportQueue({query,sendText(){throw Error('unexpected text');},sendPhoto(item){
    destination.push(item);
    return {acceptedByProvider:true,messageId:'19'};
  }});
  const resolveReport=createTerm2OfflineListeningReportResolver({query,makePermit(row){
    assert.equal(row.owner_id,ownerId);
    return permit;
  }});
  const submit=createTerm2ListeningReportIngress({resolveReport,queue});
  const request={attemptToken,examSessionToken,ownerId,generation,operationId,reportedAt,pngBase64,
    mode:'offline',audioHash:'3600563c0af62fd5c9656be0d7b7f52a1bae281d6af1de80ba4fe0de523f92af',positionSeconds:80};
  for(const invalid of [
    {...request,positionSeconds:20.6},
    {...request,reportedAt:'không có UTC'},
    {...request,studentName:'mạo danh'},
  ])await assert.rejects(()=>submit(invalid,permit),error=>error.status===400);
  for(const invalid of [
    {...request,ownerId:randomUUID()}, {...request,operationId:randomUUID()}, {...request,generation:4},
  ])await assert.rejects(()=>submit(invalid,permit),error=>error.status===403);
  await assert.rejects(()=>submit(request,'b'.repeat(64)),error=>error.status===403);
  await query('UPDATE assessment.term2_offline_operation SET payload=$1::jsonb',[nativePayload('page_interrupted')]);
  await assert.rejects(()=>submit(request,permit),error=>error.status===403);
  await query('UPDATE assessment.term2_offline_operation SET payload=$1::jsonb',[nativePayload('learner_cannot_hear')]);
  const result=await submit(request,permit);
  assert.deepEqual(await submit(request,permit),result);
  assert.equal((await queue.runOne()).status,'sent');
  assert.equal(destination.length,1);
  assert.equal(destination[0].id,result.incidentId);
  assert.equal(destination[0].png.toString('base64'),pngBase64);
  assert.match(destination[0].caption,/Nguyễn Văn Mẫu/);
  assert.match(destination[0].caption,/IC DEMO/);
  assert.match(destination[0].caption,/ca chưa đối soát lịch/);
  assert.match(destination[0].caption,/80.0 giây/);
  for(const credential of [permit,attemptToken,examSessionToken,ownerId])assert.ok(!destination[0].caption.includes(credential));
});
