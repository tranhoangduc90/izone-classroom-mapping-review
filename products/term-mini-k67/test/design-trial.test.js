import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import request from 'supertest';
import {mountDesignTrial,designTrialStudents} from '../src/design-trial.js';
const base='/api/term-tests/teacher/design-demo/trial';
function fixture({owner=true,found=true}={}){
 const app=express();app.use(express.json());let calls=0;
 mountDesignTrial(app,{pool:{query:async(sql)=>({rows:sql.includes('SELECT student_ref')?[]:[{found,owned:owner}]})}});
 app.post('/api/term-tests/term-test-1/session/start',(req,res)=>{calls++;res.json({ok:true,body:req.body});});
 app.get('/api/term-tests/roster',(_req,res)=>{calls++;res.json({ok:true,students:[{ref:designTrialStudents[0][2],name:'Trial'},{ref:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Other'}]});});
 app.get('/api/term-tests/mini-test-lesson-5/answer-sheet/classes',(_req,res)=>res.json({ok:true,classes:[{name:'IC2200'}]}));
 return {api:request(app),calls:()=>calls};
}
test('trial forwards the original payload to the native handler; direct original routes remain unchanged',async()=>{
 const f=fixture(),body={examSessionToken:'11111111-1111-4111-8111-111111111111'};
 const trial=await f.api.post(base+'/api/term-tests/term-test-1/session/start').send(body);
 assert.equal(trial.status,200);assert.deepEqual(trial.body.body,body);assert.equal(f.calls(),1);
 const original=await f.api.post('/api/term-tests/term-test-1/session/start').send(body);assert.equal(original.status,200);assert.equal(f.calls(),2);
});
test('trial rejects real identities, foreign tokens and methods before calling any native handler',async()=>{
 const f=fixture({owner:false});
 assert.equal((await f.api.post(base+'/api/term-tests/term-test-1/session/start').send({classCode:'IC2200'})).status,403);
 assert.equal((await f.api.post(base+'/api/term-tests/term-test-1/session/start').send({examSessionToken:'11111111-1111-4111-1111-111111111111'})).status,403);
 assert.equal((await f.api.delete(base+'/api/term-tests/term-test-1/session/start')).status,403);assert.equal(f.calls(),0);
});
test('trial roster is limited to new demo slots; paper uses its own slots and exposes only the demo class',async()=>{
 const f=fixture();const roster=await f.api.get(base+'/api/term-tests/roster?class=CODEXDEMO806&test=term-test-1');
 assert.equal(roster.status,200);assert.deepEqual(roster.body.students,[{ref:designTrialStudents[0][2],name:'Trial'}]);
 assert.equal((await f.api.get(base+'/api/term-tests/roster?class=IC2200&test=term-test-1')).status,403);
 const paper=await f.api.get(base+'/paper/api/term-tests/mini-test-lesson-5/answer-sheet/classes');assert.deepEqual(paper.body.classes,[{name:'CODEXDEMO806'}]);
 assert.equal((await f.api.post(base+'/paper/api/term-tests/term-test-1/session/start').send({studentRef:designTrialStudents[0][2]})).status,403);
});

test('trial: unknown tokens retain native recovery; paper temporary identities use own prefix',async()=>{
 const f=fixture({found:false,owner:false});
 const r=await f.api.post(base+'/api/term-tests/term-test-1/session/start').send({examSessionToken:'11111111-1111-4111-8111-111111111111'});
 assert.equal(r.status,200);assert.equal(f.calls(),1);
 const app=express();app.use(express.json());mountDesignTrial(app,{pool:{query:async()=>({rows:[]})}});
 app.post('/api/term-tests/mini-test-lesson-5/temporary-students',(req,res)=>res.json({ok:true,body:req.body}));
 const api=request(app);
 assert.equal((await api.post(base+'/paper/api/term-tests/mini-test-lesson-5/temporary-students').send({classCode:'CODEXDEMO806',temporaryCode:'DESIGNP123'})).status,200);
 assert.equal((await api.post(base+'/paper/api/term-tests/mini-test-lesson-5/temporary-students').send({classCode:'CODEXDEMO806',temporaryCode:'DESIGNC123'})).status,403);
});

test('trial: Writing start/save/planning retain native routes; paper cannot call Writing',async()=>{
 const app=express();app.use(express.json());mountDesignTrial(app,{pool:{query:async()=>({rows:[{found:true,owned:true}]})}});
 for(const path of ['/api/term-tests/writing','/api/term-tests/writing/planning'])app.post(path,(req,res)=>res.json({ok:true,body:req.body}));
 const api=request(app),body={attemptToken:'11111111-1111-4111-8111-111111111111',action:'start'};
 for(const path of ['/api/term-tests/writing','/api/term-tests/writing/planning']){
  const r=await api.post(base+path).send(body);assert.equal(r.status,200);assert.deepEqual(r.body.body,body);
  assert.equal((await api.post(base+'/paper'+path).send(body)).status,403);
 }
});
