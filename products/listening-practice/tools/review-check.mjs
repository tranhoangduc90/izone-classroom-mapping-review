import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import {createListeningService} from '../src/service.js';
import {createApp} from '../src/app.js';
import {loadReview} from '../src/review.js';
import {secret,uuid,emptyDraft} from '../src/domain.js';

// Canary chỉ trong DB mới có tên riêng; không Google, không worker ghi Docs, không bài học viên.
const pool=new pg.Pool({connectionString:process.env.LISTENING_NATIVE_CHECK_DATABASE_URL,max:4});
let server;
try{
 const db=(await pool.query('SELECT current_database() AS db')).rows[0].db;
 assert.match(db,/^listening_practice_canary_review_[a-z0-9_]+$/);
 assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='listening_practice'")).rowCount,0);
 await pool.query(await readFile(new URL('../db/001-schema.sql',import.meta.url),'utf8'));
 const content=JSON.parse(await readFile('/private/content.json','utf8'));
 const audioFile=process.env.LISTENING_AUDIO_FILE;
 const audioHash=crypto.createHash('sha256').update(await readFile(audioFile)).digest('hex');
 const review=await loadReview(process.env.LISTENING_REVIEW_FILE,audioHash);
 assert.equal(review.contentVersion,content.version);
 const studentRef=uuid(),entryToken=secret();let teacherAllowed=true;
 const context={student:async(c,id)=>c==='fixture'&&id===studentRef?{studentRef,name:'Học viên canary'}:undefined,
  roster:async()=>[{studentRef,name:'Học viên canary'}],teacher:async(c,email)=>teacherAllowed&&c==='fixture'&&email==='canary@example.test'};
 const service=createListeningService({pool,context,pageBase:'https://example.test/listening/',verifyBinding:async i=>({fixtureOnly:true,documentId:i.documentId,studentRef:i.studentRef})});
 await service.seedContent(content);
 await service.register({classId:'fixture',classCode:'CANARY REVIEW',studentRef,documentId:'canary_'+uuid().replaceAll('-',''),tabId:'t.0',contentVersion:content.version,entryToken});
 await pool.query("UPDATE listening_practice.assignment SET status='open'");await pool.query('UPDATE listening_practice.binding SET cta_verified_at=now()');
 const login=await service.login({entryToken,studentRef,classCode:'CANARY REVIEW'});
 const begun=await service.begin({token:login.token,owner:'canary',operationId:uuid()}),id=begun.attempts.at(-1).id;
 await service.activate({token:login.token,attemptId:id,lease:begun.lease});
 const app=createApp({pool,service,review,audioFile,audioHash,origins:[],adminKey:secret(),googleClientId:'canary',
  verifyGoogle:async()=>({email:'canary@example.test',sub:'canary',email_verified:true})});
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api`;
 const get=(route,token=login.token,extra={})=>fetch(base+route,{headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...extra}});
 assert.equal((await get('/review-audio/'+id)).status,404);
 assert.equal((await (await get('/state')).json()).review,undefined);
 const draft=emptyDraft();draft.sequence=1;draft.answers=Object.fromEntries(Object.entries(content.key).map(([n,key])=>[n,key[0].toUpperCase()]));
 await service.submit({token:login.token,attemptId:id,lease:begun.lease,snapshot:draft,method:'manual',operationId:uuid()});
 const result=await (await get('/result/'+id)).json();assert.equal(result.attempt.finalScore,10);assert.equal(result.review.contentVersion,content.version);
 assert.equal((await get('/review-audio/'+id,null)).status,401);
 const before=await service.read({token:login.token});
 const audio=await get('/review-audio/'+id,login.token,{Range:'bytes=0-1023'});assert.equal(audio.status,206);assert.equal((await audio.arrayBuffer()).byteLength,1024);
 const loginResponse=await fetch(base+'/teacher/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:'canary-google-fixture'})});
 const teacherCookie=loginResponse.headers.get('set-cookie');assert.ok(teacherCookie.includes('Path=/listening-practice-api/api'));
 const teacher=await loginResponse.json();
 const sid=result.attempt.submissionId;
 assert.equal((await get('/teacher/result/'+sid,teacher.token)).status,200);
 const teacherAudio=await get('/teacher/review-audio/'+sid,teacher.token,{Range:'bytes=0-1023'});assert.equal(teacherAudio.status,206);await teacherAudio.arrayBuffer();
 const cookieAudio=await get('/teacher/review-audio/'+sid,null,{Cookie:teacherCookie.split(';')[0],Range:'bytes=0-1023'});assert.equal(cookieAudio.status,206);await cookieAudio.arrayBuffer();
 teacherAllowed=false;assert.equal((await get('/teacher/review-audio/'+sid,teacher.token)).status,403);
 assert.deepEqual(await service.read({token:login.token}),before);
 console.log(JSON.stringify({status:'passed',database:db,score:10,questions:Object.keys(review.questions).length,audioHash,
  checks:['before-submit-denied','student-review','unauthenticated-denied','audio-range','teacher-review','teacher-class-denied','state-unchanged'],scope:'isolated database; no real learner or external document writes'}));
}finally{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();}
