import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createReportHandler} from './listening-report-service.mjs';
import {createTerm2K67ListeningReportQueue,term2K67ListeningReportSchema} from './listening-report-queue.mjs';
import {term2ListeningReportMap} from './listening-report-map-v1.mjs';

test('real K67 report queue is bound to Journey receipt and online incident',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  const query=db.query.bind(db);
  const schema=`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_exam_session (id uuid PRIMARY KEY,generation int,superseded_at timestamptz,
      test_slug text,attempt_mode text,student_name_snapshot text,class_name_snapshot text,listening_started_at timestamptz,
      audio_owner_protocol int,audio_owner_id uuid,audio_owner_proof_hash text,audio_owner_epoch int);
    CREATE TABLE assessment.term_k67_cbt_journey (session_id uuid,generation int,device_hash text,
      student_ref uuid,activated_at timestamptz,audio_hash text,sections jsonb);
    CREATE TABLE assessment.term_test_audio_incident (exam_session_id uuid,incident_id uuid,opened_at timestamptz,
      reason text,request_payload jsonb);
  `;
  await db.exec(schema+term2K67ListeningReportSchema);

  const sessionId=randomUUID(),studentRef=randomUUID(),operationId=randomUUID();
  const generation=7,ownerId=randomUUID(),ownerProof=randomBytes(32).toString('hex');
  const secret=randomBytes(32),deviceProof=randomBytes(32).toString('hex');
  const sha=input=>createHash('sha256').update(input).digest('hex');
  const audioHash=term2ListeningReportMap.sha256;
  const moment=Date.now()-3000;
  const reportedAt=new Date(moment).toISOString(),startedAt=new Date(moment-140000).toISOString();
  const permit=createHmac('sha256',secret).update(
    ['term2-k67-cbt-journey-v1',sessionId,generation,studentRef,sha(deviceProof),audioHash].join(':')).digest('hex');
  await query(`INSERT INTO assessment.term_test_exam_session VALUES
    ($1,$2,NULL,'term-test-2','legacy','Học viên giả','Lớp kiểm thử',$3,1,$4,$5,2)`,
    [sessionId,generation,startedAt,ownerId,sha(ownerProof)]);
  await query('INSERT INTO assessment.term_k67_cbt_journey VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [sessionId,generation,sha(deviceProof),studentRef,startedAt,audioHash,{listening:{operationId,generation,capturedAt:moment,outcome:'interrupted'}}]);

  const sent=[];
  const queue=createTerm2K67ListeningReportQueue({query,sendPhoto:async(item)=>{
    sent.push(item);return {acceptedByProvider:true,messageId:'5535'};
  },sendText:()=>assert.fail('Only the expected photo may be sent')});
  const submit=createReportHandler({query,secret,queue});
  const pngBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAAAASUVORK5CYII=';
  const body={mode:'journey',examSessionToken:sessionId,generation,operationId,deviceProof,audioHash,positionSeconds:140,reportedAt,pngBase64};
  await assert.rejects(submit({...body,positionSeconds:65},permit),{code:'LISTENING_REPORT_INVALID'});
  await assert.rejects(submit({...body,deviceProof:ownerProof},permit),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  await assert.rejects(submit({...body,operationId:randomUUID()},permit),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  await assert.rejects(submit({...body,generation:8},permit),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  const [first,copy]=await Promise.all([submit(body,permit),submit(body,permit)]);
  assert.equal(first.incidentId,copy.incidentId);
  await query("UPDATE assessment.term2_k67_listening_report SET ready_at=now()-interval '1 second'");
  assert.equal((await queue.runOne()).status,'sent');
  assert.equal(sent.length,1);
  assert.match(sent[0].caption,/Học viên giả/);

  const incidentId=randomUUID();
  const online={mode:'online',examSessionToken:sessionId,generation,operationId:incidentId,audioHash,positionSeconds:140,
    reportedAt,ownerId,ownerProof,ownerEpoch:2,pngBase64};
  await assert.rejects(submit(online),{code:'LISTENING_REPORT_WAITING'});
  await query("INSERT INTO assessment.term_test_audio_incident VALUES ($1,$2,$3,'manual',$4)",
    [sessionId,incidentId,reportedAt,{heardSeconds:140.1}]);
  await assert.rejects(submit({...online,ownerProof:deviceProof}),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  const registered=await submit(online);
  assert.ok(registered.incidentId);
  assert.notEqual(registered.incidentId,first.incidentId);
  assert.equal((await query('SELECT count(*)::int AS count FROM assessment.term2_k67_listening_report')).rows[0].count,2);
});
