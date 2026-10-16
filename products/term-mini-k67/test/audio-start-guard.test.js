import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

// Dùng HTTP/SQL thật: bỏ ACK start vẫn phải có hold đã commit trước khi trả response.
// Không mô phỏng luật bảo vệ trong fixture; đọc lại incident và kiểm đường nộp thật.
const studentRef='11111111-1111-4111-8111-111111111111';
const assets={supports:()=>true,getTiming:()=>({listeningDurationSeconds:120,listeningTotalSeconds:240,readingDurationMinutes:20}),getContent:async()=>({}),getSessionAudioKey:()=>Buffer.alloc(32)};
let f,api;
before(async()=>{f=await createMiniFixture({examOrder:true,assets,audioProtection:true});api=request(f.app);});
after(async()=>f?.db.close());
for(const mode of ['lis_first','read_first'])test(`${mode}: mất ACK start vẫn giữ thời gian, retry cùng incident và bù đúng một lần`,async()=>{
  await f.db.exec(`UPDATE assessment.term_test_exam_session SET attempt_id=NULL;UPDATE assessment.term_test_attempt SET exam_session_id=NULL;
    DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;`);
  const base='/api/term-tests/mini-test-lesson-5';
  const post=(suffix,data)=>api.post(base+'/'+suffix).send({orderClientVersion:1,...data});
  const p=await post('session/prepare',{classCode:'IC2304',studentRef,examMode:mode,examDelivery:'cbt'});
  assert.ok([200,201].includes(p.status));
  const token={examSessionToken:p.body.examSessionToken,attemptToken:p.body.attemptToken,generation:0};
  if(mode==='read_first'){assert.equal((await post('reading/start',token)).status,200);assert.equal((await post('reading',{...token,answers:{14:'A'}})).status,200);}
  const body={...token,audioProtocolVersion:1,audioStartGuardVersion:1,audioEventId:randomUUID()};
  assert.equal((await post('session/start',body)).status,200); // Bỏ nội dung ACK như client mất phản hồi.
  const row=()=>f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken]).then(r=>r.rows[0]);
  const started=await row();assert.ok(started.listening_started_at);
  assert.ok(started.listening_audio_incident_id,'Start commit phải giữ bài trước ACK, không để thời gian chạy khi đề còn khóa');
  const denied=await post('listening',{...token,classCode:'IC2304',studentRef,answers:{11:'A'},clientSubmissionId:randomUUID()});
  assert.equal(denied.status,409);assert.equal(denied.body.error,'AUDIO_INCIDENT_OPEN');
  await f.db.query(`UPDATE assessment.term_test_audio_incident SET opened_at=clock_timestamp()-interval '30 seconds' WHERE incident_id=$1`,[started.listening_audio_incident_id]);
  const retry=await post('session/start',{...body,audioEventId:randomUUID()});assert.equal(retry.status,200);
  assert.equal(retry.body.activeIncident.incidentId,started.listening_audio_incident_id);assert.equal(retry.body.activeIncident.startup,true);
  assert.equal(retry.body.listeningDeadlineAt,new Date(started.listening_deadline_at).toISOString());
  const incidentId=started.listening_audio_incident_id,resumeAttemptId=randomUUID();
  const prepared=await post('session/audio-resume',{...token,incidentId,resumeAttemptId,eventId:randomUUID(),phase:'prepare',heardSeconds:0});assert.equal(prepared.status,200);
  const confirm={...token,incidentId,resumeAttemptId,eventId:randomUUID(),phase:'confirm',heardSeconds:.1};
  const resumed=await post('session/audio-resume',confirm);assert.equal(resumed.status,200);assert.equal(resumed.body.activeIncident,null);
  assert.ok(resumed.body.grantedRecoverySeconds>=29&&resumed.body.grantedRecoverySeconds<=31);
  const duplicate=await post('session/audio-resume',confirm);assert.equal(duplicate.body.listeningDeadlineAt,resumed.body.listeningDeadlineAt);
  assert.equal(duplicate.body.listeningRecoverySeconds,resumed.body.listeningRecoverySeconds);
  const done=await post('listening',{...token,classCode:'IC2304',studentRef,answers:{11:'A'},clientSubmissionId:randomUUID()});
  assert.ok([200,201].includes(done.status),JSON.stringify(done.body));assert.ok((await row()).listening_submitted_at);
});
