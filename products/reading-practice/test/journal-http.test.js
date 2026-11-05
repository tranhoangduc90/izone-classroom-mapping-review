import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {uuid,secret} from '../src/domain.js';

const options=f=>({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'fixture',adminKey:secret()});
test('vé lấy từ đúng kết quả đã xác thực, không từ trường người/lượt do request tự khai',async t=>{
 const f=await fixture();t.after(f.close);const scopes=[];
 const app=createApp({...options(f),journal:{context(scope){scopes.push(scope);return{...scope,ticket:'fixture-ticket'};}}});
 assert.equal((await request(app).get('/api/state')).status,401);assert.equal(scopes.length,0);
 const result=await request(app).post('/api/begin').set('Authorization',`Bearer ${f.token}`).send({operationId:uuid(),owner:'browser'});
 assert.equal(result.status,200);const a=result.body.attempts.at(-1);
 assert.deepEqual(scopes,[{code:f.content.code,classCode:f.registration.classCode,studentRef:f.studentRef,attemptId:a.id,attemptNo:1}]);
 assert.equal(result.body.readingJournal.ticket,'fixture-ticket');assert.equal(result.headers['cache-control'],'no-store');
 f.setEligible(false);assert.equal((await request(app).get('/api/state').set('Authorization',`Bearer ${f.token}`)).status,403);assert.equal(scopes.length,1);
});
test('tắt log hoặc cấp vé lỗi giữ nguyên phản hồi; route mới không mở khi tắt',async t=>{
 const f=await fixture();t.after(f.close);await f.begin();
 const off=createApp(options(f)),expected=await request(off).get('/api/state').set('Authorization',`Bearer ${f.token}`);
 assert.equal(expected.body.readingJournal,undefined);assert.equal((await request(off).post('/api/journal-events').send({})).status,404);
 const failing=createApp({...options(f),journal:{context(){throw Error('fixture unavailable');}}});
 const actual=await request(failing).get('/api/state').set('Authorization',`Bearer ${f.token}`);assert.deepEqual(actual.body,expected.body);
});
test('intake kiểm Origin trước, vé lượt cũ không cần session hiện hành; không nhận ACK giả khi Collector lỗi',async t=>{
 const f=await fixture();t.after(f.close);const seen=[];
 const app=createApp({...options(f),journal:{collect(input){seen.push(input);return{status:503,headers:{'cache-control':'no-store'},body:{ok:false,persisted:false}};}}});
 const body={schemaVersion:1,bindingId:'old-scope',auth:{ticket:'old-ticket'},events:[]};
 assert.equal((await request(app).post('/api/journal-events').set('Origin','https://evil.test').send(body)).status,403);assert.equal(seen.length,0);
 const reply=await request(app).post('/api/journal-events').set('Origin','https://page.test').send(body);
 assert.equal(reply.status,503);assert.equal(reply.body.persisted,false);assert.deepEqual(seen[0].body,body);
});
