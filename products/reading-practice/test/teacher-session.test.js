import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {hash,secret,uuid} from '../src/domain.js';
import {readFile} from 'node:fs/promises';

// Dùng SQL và bài nộp giả để kiểm phiên qua HTTP; không đăng nhập hoặc ghi bài học viên thật.
async function setup(context){
 const fixtureState=await fixture();context.after(fixtureState.close);
 const started=await fixtureState.begin();
 const submitted=await fixtureState.service.submit({token:fixtureState.token,attemptId:started.attempts.at(-1).id,
  lease:started.lease,snapshot:fixtureState.draft(),method:'manual',operationId:uuid()});
 const app=createApp({pool:fixtureState.pool,service:fixtureState.service,origins:['https://page.test'],
  googleClientId:'google-client-fixture',adminKey:secret(),
  verifyGoogle:async()=>({email:'teacher@example.test',sub:'google-fixture',email_verified:true})});
 const resultPath=`/api/teacher/result/${submitted.attempts.at(-1).submissionId}`;
 const login=remember=>request(app).post('/api/teacher/login').set('Origin','https://page.test')
  .set('X-Forwarded-Proto','https').send({credential:'valid-google-fixture',remember});
 return{...fixtureState,app,resultPath,login};
}

test('teacher: cookie đúng đường công khai, khôi phục không cần Bearer và giữ phiên dài hạn có trần',async context=>{
 const state=await setup(context),logged=await state.login();
 assert.equal(logged.status,200);
 const header=logged.headers['set-cookie'].find(value=>value.startsWith('reading_teacher='));
 for(const flag of ['Path=/reading-practice-api/api','HttpOnly','Secure','SameSite=None','Partitioned'])assert.ok(header.includes(flag),flag);
 assert.ok(Number(header.match(/Max-Age=(\d+)/)?.[1])>=89*86400);
 const cookie=header.split(';')[0];
 const restored=await request(state.app).get(state.resultPath).set('Cookie',cookie).set('X-Forwarded-Proto','https');
 assert.equal(restored.status,200);assert.equal(restored.body.attempt.status,'submitted');
 assert.equal(restored.headers['cache-control'],'no-store');
 await state.pool.query("UPDATE reading_practice.teacher_session SET expires_at=now()+interval '2 days',absolute_expires_at=now()+interval '10 days'");
 const renewed=await request(state.app).get(state.resultPath).set('Cookie',cookie).set('X-Forwarded-Proto','https');
 assert.equal(renewed.status,200);
 const row=(await state.pool.query('SELECT expires_at,absolute_expires_at FROM reading_practice.teacher_session')).rows[0];
 assert.equal(new Date(row.expires_at).getTime(),new Date(row.absolute_expires_at).getTime());
 await state.pool.query("UPDATE reading_practice.teacher_session SET absolute_expires_at=now()-interval '1 second'");
 assert.equal((await request(state.app).get(state.resultPath).set('Cookie',cookie)).status,401);
});

test('teacher: đăng xuất thu hồi phiên mọi tab, chặn giả mạo yêu cầu và vẫn kiểm quyền lớp',async context=>{
 const state=await setup(context),logged=await state.login();
 assert.equal(logged.status,200);
 const cookie=logged.headers['set-cookie'][0].split(';')[0];
 const headers={Origin:'https://page.test',Cookie:cookie,'X-Izone-Csrf':'1'};
 state.setTeacher(false);
 assert.equal((await request(state.app).get(state.resultPath).set('Cookie',cookie)).status,403);
 state.setTeacher(true);
 assert.equal((await request(state.app).post('/api/teacher/logout').set('Cookie',cookie).send({})).status,403);
 assert.equal((await request(state.app).post('/api/teacher/logout').set({...headers,Origin:'https://evil.test'}).send({})).status,403);
 const logout=await request(state.app).post('/api/teacher/logout').set(headers).send({});
 assert.equal(logout.status,200);
 assert.ok(logout.headers['set-cookie'].some(value=>value.includes('Max-Age=0')));
 assert.equal((await request(state.app).get(state.resultPath).set('Cookie',cookie)).status,401);
 assert.equal((await request(state.app).get(state.resultPath).set('Authorization',`Bearer ${logged.body.token}`)).status,401);
});

test('teacher: bỏ ghi nhớ chỉ mở phiên một giờ; phiên Bearer cũ còn hạn được chuyển sang cookie',async context=>{
 const state=await setup(context),logged=await state.login(false);
 assert.equal(logged.status,200);
 const header=logged.headers['set-cookie'][0];
 assert.ok(!header.includes('Max-Age='));
 const row=(await state.pool.query('SELECT remembered,expires_at,absolute_expires_at FROM reading_practice.teacher_session')).rows[0];
 assert.equal(row.remembered,false);
 assert.ok(new Date(row.expires_at).getTime()-Date.now()<=3600000);
 assert.equal(new Date(row.expires_at).getTime(),new Date(row.absolute_expires_at).getTime());
 const restored=await request(state.app).get(state.resultPath).set('Authorization',`Bearer ${logged.body.token}`);
 assert.equal(restored.status,200);assert.ok(restored.headers['set-cookie']);
 await state.pool.query("UPDATE reading_practice.teacher_session SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(logged.body.token)]);
 assert.equal((await request(state.app).get(state.resultPath).set('Authorization',`Bearer ${logged.body.token}`)).status,401);
});

test('teacher: migration chạy lại an toàn, giữ hạn phiên cũ và cho phép quay lại runtime cũ',async context=>{
 const state=await fixture();context.after(state.close);
 await state.pool.query('ALTER TABLE reading_practice.teacher_session DROP COLUMN absolute_expires_at, DROP COLUMN remembered');
 const tokenHash=hash(secret());
 await state.pool.query("INSERT INTO reading_practice.teacher_session(token_hash,email,google_subject,expires_at) VALUES($1,'teacher@example.test','google-fixture',now()+interval '30 minutes')",[tokenHash]);
 const client=await state.pool.connect();
 try{
  const migration=await readFile(new URL('../db/003-teacher-session.sql',import.meta.url),'utf8');
  for(let run=0;run<2;run++)for(const statement of migration.split(';').map(value=>value.trim()).filter(Boolean))await client.query(statement);
 }finally{client.release();}
 const migrated=(await state.pool.query('SELECT remembered,expires_at,absolute_expires_at FROM reading_practice.teacher_session WHERE token_hash=$1',[tokenHash])).rows[0];
 assert.equal(migrated.remembered,false);
 assert.equal(new Date(migrated.expires_at).getTime(),new Date(migrated.absolute_expires_at).getTime());
 await state.pool.query("INSERT INTO reading_practice.teacher_session(token_hash,email,google_subject,expires_at) VALUES($1,'teacher@example.test','google-fixture',now()+interval '1 hour')",[hash(secret())]);
 assert.equal((await state.pool.query('SELECT count(*)::int AS total FROM reading_practice.teacher_session')).rows[0].total,2);
});
