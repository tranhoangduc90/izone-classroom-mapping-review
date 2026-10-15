import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {validateReview,matchingReview} from '../src/review.js';
import {secret,uuid} from '../src/domain.js';

// Dữ liệu giả đủ cấu trúc; test quyền trên SQL thật, không nạp transcript riêng vào Git.
function reviewData(){
 const part={id:'fixture-part',wordStart:0,wordEnd:1,startMs:100,endMs:300,paragraphs:[{runs:[{text:'Fixture'}]}]};
 return{audioSha256:'0'.repeat(64),audioDurationMs:459207,contentVersion:'fixture-v1',
  words:[{word:'Fixture',start:.1,end:.3}],segments:[{id:'fixture-segment',wordStart:0,wordEnd:1,start:.1,end:.3}],
  questions:Object.fromEntries(Array.from({length:10},(_,i)=>[21+i,{replay:[part],optionReplay:{}}]))};
}
test('mốc nghe: từ chối sai audio, sai biên và thiếu câu; chỉ ghép đúng phiên bản đã nộp',()=>{
 const data=reviewData();assert.equal(validateReview(data,data.audioSha256),data);
 for(const change of[v=>v.audioSha256='f'.repeat(64),v=>v.words[0].end=500,v=>v.questions[21].replay[0].endMs=600000,v=>delete v.questions[30]]){
  const invalid=structuredClone(data);change(invalid);assert.throws(()=>validateReview(invalid,data.audioSha256));
 }
 const result={attempt:{status:'submitted'},contentVersion:data.contentVersion,definition:{audio:{sha256:data.audioSha256}}};
 assert.equal(matchingReview(data,result),true);assert.equal(matchingReview(data,{...result,contentVersion:'other'}),false);
 assert.equal(matchingReview(data,{...result,attempt:{status:'running'}}),false);
});
test('xem lại: chỉ sau nộp, đúng học viên/lớp GV; range audio hoạt động và không ghi bài',async t=>{
 const f=await fixture();t.after(f.close);
 const dir=await mkdtemp(path.join(os.tmpdir(),'listening-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const audioFile=path.join(dir,'fixture.mp3');await writeFile(audioFile,Buffer.alloc(128,7));
 const review=reviewData(),app=createApp({pool:f.pool,service:f.service,review,audioFile,audioHash:review.audioSha256,
  origins:['https://page.test'],googleClientId:'fixture-google',adminKey:secret(),
  verifyGoogle:async()=>({email:'teacher@example.test',sub:'google-fixture',email_verified:true})});
 const started=await f.begin(),id=started.attempts.at(-1).id;
 const get=url=>request(app).get(url).set('Authorization',`Bearer ${f.token}`).set('Origin','https://page.test');
 assert.equal((await get(`/api/review-audio/${id}`)).status,404);
 assert.equal((await get('/api/state')).body.review,undefined);
 await f.service.submit({token:f.token,attemptId:id,lease:started.lease,snapshot:f.draft(),operationId:uuid(),method:'manual'});
 const result=await get(`/api/result/${id}`);assert.equal(result.status,200);assert.deepEqual(result.body.review,review);
 assert.equal(result.body.reviewAudioUrl,`review-audio/${id}`);
 assert.equal((await request(app).get(`/api/review-audio/${id}`)).status,401);
 assert.equal((await request(app).get(`/api/review-audio/${id}`).set('Authorization',`Bearer ${secret()}`)).status,401);
 const stateBefore=(await f.service.read({token:f.token}));
 const audio=await get(`/api/review-audio/${id}`).set('Range','bytes=0-15');assert.equal(audio.status,206);assert.equal(audio.headers['content-length'],'16');assert.match(audio.headers['cache-control'],/no-store/);
 const teacher=await request(app).post('/api/teacher/login').send({credential:'fixture-google-login'}),submissionId=result.body.attempt.submissionId;
 const teacherGet=url=>request(app).get(url).set('Authorization',`Bearer ${teacher.body.token}`);
 assert.equal((await teacherGet(`/api/teacher/result/${submissionId}`)).body.review.contentVersion,review.contentVersion);
 assert.equal((await teacherGet(`/api/teacher/review-audio/${submissionId}`)).status,200);
 f.setTeacher(false);assert.equal((await teacherGet(`/api/teacher/review-audio/${submissionId}`)).status,403);
 f.setEligible(false);assert.equal((await get(`/api/review-audio/${id}`)).status,403);f.setEligible(true);
 assert.deepEqual(await f.service.read({token:f.token}),stateBefore);
});
