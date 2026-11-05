import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {uuid,secret} from '../src/domain.js';

const options=f=>({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'fixture',adminKey:secret()});
test('ticket context comes from the authenticated native result and never from request fields',async t=>{
 const f=await fixture();t.after(()=>f.close());const scopes=[];
 const app=createApp({...options(f),journal:{context(scope){scopes.push(scope);return{...scope,ticket:'fixture-bound-ticket'};}}});
 assert.equal((await request(app).get('/api/state')).status,401);assert.equal(scopes.length,0);
 const started=await request(app).post('/api/begin').set('Authorization',`Bearer ${f.token}`).send({operationId:uuid(),owner:'fixture-browser'});
 assert.equal(started.status,200);const a=started.body.attempts.at(-1);
 assert.deepEqual(scopes,[{code:f.content.code,classCode:f.registration.classCode,studentRef:f.studentRef,attemptId:a.id,attemptNo:1}]);
 assert.equal(started.body.listeningJournal.ticket,'fixture-bound-ticket');
 assert.equal(started.headers['cache-control'],'no-store');
 const read=await request(app).get('/api/state').set('Authorization',`Bearer ${f.token}`);
 assert.equal(read.status,200);assert.equal(read.body.listeningJournal.attemptId,a.id);
 f.setEligible(false);assert.equal((await request(app).get('/api/state').set('Authorization',`Bearer ${f.token}`)).status,403);
 assert.equal(scopes.length,2);
});

test('disabled or failing ticket context preserves the native response and does not open an intake route',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.begin();
 const disabled=createApp(options(f));
 const expected=await request(disabled).get('/api/state').set('Authorization',`Bearer ${f.token}`);
 assert.equal(expected.body.listeningJournal,undefined);
 assert.equal((await request(disabled).post('/api/journal-events').send({})).status,404);
 const failing=createApp({...options(f),journal:{context(){throw Error('fixture unavailable');}}});
 const actual=await request(failing).get('/api/state').set('Authorization',`Bearer ${f.token}`);
 assert.equal(actual.status,200);assert.deepEqual(actual.body,expected.body);
});

test('intake delegates frozen old tickets without a learner session and forwards only its persistence result',async t=>{
 const f=await fixture();t.after(()=>f.close());const received=[];
 const app=createApp({...options(f),journal:{collect(input){received.push(input);return{status:503,headers:{'cache-control':'no-store'},body:{ok:false,persisted:false,error:'FIXTURE_COLLECTOR_OFFLINE'}};}}});
 const body={schemaVersion:1,bindingId:'old-attempt-fixture',auth:{ticket:'fixture-old-ticket'},events:[]};
 const denied=await request(app).post('/api/journal-events').set('Origin','https://unexpected.test').send(body);
 assert.equal(denied.status,403);assert.equal(received.length,0);
 const result=await request(app).post('/api/journal-events').set('Origin','https://page.test').send(body);
 assert.equal(result.status,503);assert.equal(result.body.persisted,false);assert.equal(received.length,1);
 assert.deepEqual(received[0].body,body);assert.equal(received[0].headers.origin,'https://page.test');
});
