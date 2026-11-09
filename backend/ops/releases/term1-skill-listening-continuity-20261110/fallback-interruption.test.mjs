import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
process.env.K56_TEST_PRODUCT='1';
process.env.TERM2_FIXTURE_IMPORT_ONLY='1';
const {fixture,op}=await import('../term1-offline-20261107/test.mjs');
const {issueSkillGrant,bindSkillGrant}=await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT+'/src/term1-skill-grant.mjs'));
for(const mode of ['lis_first','read_first'])test(mode+': scoped Listening grant interrupts once and allows next skill',async t=>{
 const f=await fixture(mode,{listeningInterruption:true});
 t.after(f.close);
 let previousReading=null;
 if(mode==='read_first'){
  const start=op(f,'reading','start');
  assert.equal((await f.request('/offline/operation',start)).receipt?.status,'accepted');
  previousReading=op(f,'reading','seal',{startedAt:start.payload.startedAt});
  assert.equal((await f.request('/offline/operation',previousReading)).receipt?.status,'accepted');
 }
 const ownerId=randomUUID();
 const s={attemptId:f.a,sessionId:f.s,generation:0,classId:'5601',studentRef:randomUUID(),section:'listening'};
 const {grant,token,activationCode}=await issueSkillGrant(f.db,s);
 await bindSkillGrant(f.db,s,token,ownerId,activationCode);
 const access={...f.scope,attemptToken:grant.id,examSessionToken:grant.id,ownerId};
 const send=async(path,body)=>{
  const r=await fetch(f.base+path,{method:'POST',headers:{'content-type':'application/json','x-term1-skill-grant':token},body:JSON.stringify(body)});
  return {status:r.status,...await r.json()};
 };
 const start={...op(f,'listening','start'),...access};
 assert.equal((await send('/offline/operation',start)).receipt?.status,'accepted');
 f.advance(5000);
 const interrupted={...op(f,'listening','interrupt',{startedAt:start.payload.startedAt,revision:1}),...access};
 delete interrupted.payload.answers;
 interrupted.payload.interruptionReason='learner_cannot_hear';
 const rejected=await send('/offline/operation',{...interrupted,section:'reading'});
 assert.equal(rejected.status,403);
 const accepted=await send('/offline/operation',interrupted);
 assert.equal(accepted.receipt?.status,'accepted',JSON.stringify(accepted));
 assert.equal(accepted.receipt.attemptToken,grant.id);
 assert.deepEqual((await send('/offline/operation',interrupted)).receipt,accepted.receipt);
 assert.deepEqual((await send('/offline/status',{...access,operationId:interrupted.operationId})).receipt,accepted.receipt);
 assert.equal((await send('/offline/operation',{...op(f,'listening','seal',{startedAt:start.payload.startedAt,revision:2}),...access})).error,'OFFLINE_SECTION_LOCKED');
 const row=await f.load(f.pool,'term-test-1-k56',f.a);
 assert.ok(row.listening_interrupted_at);
 assert.equal(row.listening_submitted_at,null);
 assert.equal(row.listening_result,null);
 assert.equal((await f.db.query("SELECT field FROM assessment.k56_portal_field_dispatch WHERE attempt_id=$1 AND field='listening'",[f.a])).rows.length,0);
 const next=mode==='read_first'?'writing':'reading';
 assert.equal((await f.request('/offline/operation',op(f,next,'start',{dependency:interrupted.operationId}))).receipt?.status,'accepted');
});
