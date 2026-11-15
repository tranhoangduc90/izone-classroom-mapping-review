import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createReportHandler} from './listening-report-service.mjs';
import {createK67ListeningReportQueue,k67ListeningReportSchema} from './listening-report-queue.mjs';
import {listeningProfiles} from './listening-profiles-v1.mjs';

const sha=input=>createHash('sha256').update(input).digest('hex');
const products=[
  ['term-test-1','term1','term1-k67-cbt-journey-v1','term_k67_cbt_journey'],
  ['mini-test-lesson-5','mini','mini-k67-cbt-journey-v1','mini_k67_cbt_journey'],
  ['pretest-lesson-16','pretest','pretest-lesson-16-k67-cbt-v1','term_k67_cbt_journey'],
];

for(const [slug,key,journeyVersion,table] of products)test(slug+' binds report and image to exact native scope',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  const query=db.query.bind(db);
  await db.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_exam_session (id uuid PRIMARY KEY,generation int,superseded_at timestamptz,
      test_slug text,attempt_mode text,student_name_snapshot text,class_name_snapshot text,listening_started_at timestamptz,
      audio_owner_protocol int,audio_owner_id uuid,audio_owner_proof_hash text,audio_owner_epoch int);
    CREATE TABLE assessment.${table} (session_id uuid,generation int,device_hash text,
      student_ref uuid,activated_at timestamptz,audio_hash text,sections jsonb);
    CREATE TABLE assessment.term_test_audio_incident (exam_session_id uuid,incident_id uuid,opened_at timestamptz,
      reason text,request_payload jsonb);
    ${k67ListeningReportSchema(key)}
  `);
  const sessionId=randomUUID(),studentRef=randomUUID(),operationId=randomUUID();
  const generation=7,ownerId=randomUUID(),ownerProof=randomBytes(32).toString('hex');
  const secret=randomBytes(32),deviceProof=randomBytes(32).toString('hex');
  const audio=listeningProfiles[slug].audio;
  const audioHash=audio.sha256,position=audio.audibleWindows[0][0]+1;
  const moment=Date.now()-3000,started=moment-140000;
  const reportedAt=new Date(moment).toISOString(),startedAt=new Date(started).toISOString();
  const permit=createHmac('sha256',secret).update(
    [journeyVersion,sessionId,generation,studentRef,sha(deviceProof),audioHash].join(':')).digest('hex');
  await query(`INSERT INTO assessment.term_test_exam_session VALUES
    ($1,$2,NULL,$3,'legacy','Học viên giả','Lớp kiểm thử',$4,1,$5,$6,2)`,
    [sessionId,generation,slug,startedAt,ownerId,sha(ownerProof)]);
  await query(`INSERT INTO assessment.${table} VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId,generation,sha(deviceProof),studentRef,startedAt,audioHash,
      {listening:{operationId,generation,capturedAt:moment,startedAt:started,outcome:'interrupted'}}]);
  const sent=[];
  const queue=createK67ListeningReportQueue({key,query,sendPhoto:async item=>{
    sent.push(item);return {acceptedByProvider:true,messageId:'5535'};
  },sendText:()=>assert.fail('Only the accepted photo may be sent')});
  const submit=createReportHandler({slug,query,secret,queue});
  const pngBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAAAASUVORK5CYII=';
  const body={mode:'journey',examSessionToken:sessionId,generation,operationId,
    deviceProof,audioHash,positionSeconds:position,reportedAt,pngBase64};
  await assert.rejects(submit({...body,positionSeconds:audio.readingGaps[0].from+1},permit),{code:'LISTENING_REPORT_INVALID'});
  await assert.rejects(submit({...body,deviceProof:ownerProof},permit),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  await assert.rejects(submit({...body,operationId:randomUUID()},permit),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  await assert.rejects(submit({...body,generation:8},permit),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  await query('UPDATE assessment.term_test_exam_session SET test_slug=$1',['wrong-test']);
  await assert.rejects(submit(body,permit),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  await query('UPDATE assessment.term_test_exam_session SET test_slug=$1',[slug]);
  const [first,duplicate]=await Promise.all([submit(body,permit),submit(body,permit)]);
  assert.equal(first.incidentId,duplicate.incidentId);
  await query(`UPDATE assessment.k67_${key}_listening_report SET ready_at=now()-interval '1 second'`);
  assert.equal((await queue.runOne()).status,'sent');
  assert.equal(sent.length,1);
  assert.match(sent[0].caption,/Học viên giả/);
  const incidentId=randomUUID();
  const online={mode:'online',examSessionToken:sessionId,generation,operationId:incidentId,
    audioHash,positionSeconds:position,reportedAt,ownerId,ownerProof,ownerEpoch:2,pngBase64};
  await assert.rejects(submit(online),{code:'LISTENING_REPORT_WAITING'});
  await query("INSERT INTO assessment.term_test_audio_incident VALUES ($1,$2,$3,'manual',$4)",
    [sessionId,incidentId,reportedAt,{heardSeconds:position+.1}]);
  await assert.rejects(submit({...online,ownerProof:deviceProof}),{code:'LISTENING_REPORT_SCOPE_MISMATCH'});
  const registered=await submit(online);
  assert.ok(registered.incidentId);
  assert.notEqual(registered.incidentId,first.incidentId);
  assert.equal((await query(`SELECT count(*)::int AS count FROM assessment.k67_${key}_listening_report`)).rows[0].count,2);
});
