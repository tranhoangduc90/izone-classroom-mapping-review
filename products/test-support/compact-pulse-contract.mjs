// One HTTP/SQL contract for both native practice engines; all identities/content are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';

export function compactPulseContract({product,schema,fixture,createApp,request,secret,uuid}) {
 const appFor=f=>createApp({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'fixture-client',adminKey:secret(),verifyGoogle:async()=>({})});
 const post=(app,f,path,input)=>request(app).post('/api/'+path).set('Authorization',`Bearer ${f.token}`).send(input);
 test(`${product}: compact pulse acknowledges committed content without echoing current or historical answers`,async t=>{
  const f=await fixture();t.after(f.close);const app=appFor(f),start=await f.begin(),old=start.attempts.at(-1),draft=f.draft();
  draft.sequence=1;draft.answers[Object.keys(f.content.key)[0]]='A';draft.notes='Private synthetic history. '.repeat(100);
  const done=await f.service.submit({token:f.token,operationId:uuid(),attemptId:old.id,lease:start.lease,snapshot:draft,method:'manual'});
  const reset=await f.service.reset({token:f.token,operationId:uuid(),attemptId:old.id,owner:'device1'}),active=reset.attempts.at(-1);
  await f.service.activate({token:f.token,attemptId:active.id,lease:reset.lease});
  const previous=(await f.pool.query(`SELECT state FROM ${schema}.work WHERE binding_id=$1`,[f.registered.bindingId])).rows[0].state.attempts[0];
  const next=f.draft();next.sequence=1;next.notes='Current private synthetic draft';next.answers[Object.keys(f.content.key)[0]]='A';
  f.advance(300);next.activeMs=300;if(product==='Listening')next.audioPosition=0.3;
  const input={attemptId:active.id,lease:reset.lease,snapshot:next};
  const ack=await post(app,f,'pulse?ack=compact-v1',input);assert.equal(ack.status,200);
  assert.equal(ack.body.ack,'practice-pulse-v1');assert.equal(ack.body.bindingId,f.registered.bindingId);
  assert.equal(ack.body.attempt.id,active.id);assert.equal(ack.body.attempt.leaseId,reset.lease.id);assert.equal(ack.body.attempt.sequence,1);assert.equal(ack.body.attempt.status,'running');
  assert.equal(ack.body.attempt.usedMs,300);assert.equal(ack.body.attempt.remainingMs,f.content.totalMs-300);
  for(const key of ['attempts','definition','key','explanations'])assert.equal(ack.body[key],undefined);
  for(const key of ['draft','answers','notes','annotations','flags','result','lease'])assert.equal(ack.body.attempt[key],undefined);
  const restored=await f.service.read({token:f.token});assert.equal(restored.capabilities.compactPulseAck,true);
  assert.equal(restored.attempts.at(-1).notes,next.notes);assert.deepEqual(restored.attempts.at(-1).answers,next.answers);
  const stored=(await f.pool.query(`SELECT state FROM ${schema}.work WHERE binding_id=$1`,[f.registered.bindingId])).rows[0].state;
  assert.deepEqual(stored.attempts[0],previous);assert.equal(stored.attempts.length,2);assert.equal(stored.events.length,3);assert.equal(done.attempts[0].submissionId,restored.attempts[0].submissionId);
  const full=await post(app,f,'pulse',input);assert.equal(full.status,200);assert.equal(full.body.ack,undefined);assert.equal(full.body.attempts.length,2);assert.equal(full.body.attempts.at(-1).notes,next.notes);
  assert.ok(JSON.stringify(ack.body).length<JSON.stringify(full.body).length/3);
  const replay=await post(app,f,'pulse?ack=compact-v1',input);assert.deepEqual(replay.body,ack.body);
  assert.equal((await post(app,f,'pulse?ack=compact-v1',{...input,lease:{...reset.lease,token:secret()}})).status,409);
  assert.equal((await post(app,f,'pulse?ack=compact-v1',{...input,compactAck:true})).status,400);
  const paused=await post(app,f,'pause?ack=compact-v1',input);assert.equal(paused.status,200);assert.equal(paused.body.ack,undefined);assert.equal(paused.body.attempts.at(-1).status,'paused');assert.equal(paused.body.attempts.at(-1).notes,next.notes);
  f.setEligible(false);assert.equal((await post(app,f,'pulse?ack=compact-v1',input)).status,403);
  assert.equal((await request(app).post('/api/pulse?ack=compact-v1').send(input)).status,401);
 });

 test(`${product}: a failed commit never returns a successful compact acknowledgment`,async t=>{
  const f=await fixture();t.after(f.close);const app=appFor(f),start=await f.begin(),attempt=start.attempts.at(-1),snapshot=f.draft();snapshot.sequence=1;snapshot.notes='Retry after failed commit';
  const input={attemptId:attempt.id,lease:start.lease,snapshot};
  const connect=f.pool.connect.bind(f.pool);let rejectCommit=true;
  f.pool.connect=async()=>{const client=await connect();return{...client,query:async(sql,args)=>{if(sql==='COMMIT'&&rejectCommit){rejectCommit=false;throw Error('SYNTHETIC_COMMIT_FAILURE');}return client.query(sql,args);}};};
  const failed=await post(app,f,'pulse?ack=compact-v1',input);assert.equal(failed.status,500);assert.equal(failed.body.ack,undefined);
  assert.equal((await f.service.read({token:f.token})).attempts.at(-1).sequence,0);
  const retried=await post(app,f,'pulse?ack=compact-v1',input);assert.equal(retried.status,200);assert.equal(retried.body.ack,'practice-pulse-v1');
  assert.equal((await f.service.read({token:f.token})).attempts.at(-1).notes,snapshot.notes);
 });

 test(`${product}: compact receipts still carry fresh Docs status and authenticated identity metadata`,async t=>{
  const f=await fixture();t.after(f.close);const app=appFor(f),start=await f.begin(),snapshot=f.draft();snapshot.sequence=1;
  const original=f.context.student;f.context.student=async(...args)=>{const member=await original(...args);return member?{...member,name:'Updated synthetic display name'}:member;};
  await f.pool.query(`UPDATE ${schema}.doc_job SET status='verified' WHERE binding_id=$1`,[f.registered.bindingId]);
  const input={attemptId:start.attempts.at(-1).id,lease:start.lease,snapshot};
  const verified=await post(app,f,'pulse?ack=compact-v1',input);assert.equal(verified.status,200);assert.equal(verified.body.ack,'practice-pulse-v1');
  assert.equal(verified.body.identity.name,'Updated synthetic display name');assert.equal(verified.body.identity.bindingId,f.registered.bindingId);
  assert.equal(verified.body.identity.documentId,f.registration.documentId);assert.ok(verified.body.identity.documentUrl.includes(f.registration.documentId));
  assert.equal(verified.body.events[0].docs,'verified');assert.equal(verified.body.firstCompleted,null);
  await f.pool.query(`UPDATE ${schema}.doc_job SET status='blocked',error_code='DOC_MANUAL_CONFLICT' WHERE binding_id=$1`,[f.registered.bindingId]);
  const blocked=await post(app,f,'pulse?ack=compact-v1',input);assert.equal(blocked.status,200);assert.equal(blocked.body.events[0].docs,'blocked');
 });

 test(`${product}: compact checkpoints preserve the native deadline and return full state on automatic submission`,async t=>{
  const f=await fixture();t.after(f.close);const app=appFor(f),start=await f.begin(),id=start.attempts.at(-1).id,snapshot=f.draft();let result;
  for(let elapsed=0;elapsed<f.content.totalMs;){
   const step=Math.min(5000,f.content.totalMs-elapsed);elapsed+=step;f.advance(step);snapshot.sequence++;snapshot.activeMs=elapsed;
   if(product==='Listening'){snapshot.audioPosition=Math.min(elapsed,f.content.definition.audio.durationMs)/1000;if(elapsed>=f.content.definition.audio.durationMs)snapshot.phase='review';}
   const input={attemptId:id,lease:start.lease,snapshot};
   if(elapsed===f.content.totalMs){const response=await post(app,f,'pulse?ack=compact-v1',input);assert.equal(response.status,200);result=response.body;}
   else{const ack=await f.service.pulse({...input,token:f.token,compactAck:true});assert.equal(ack.ack,'practice-pulse-v1');assert.equal(ack.attempt.usedMs,elapsed);}
  }
  assert.equal(result.ack,undefined);assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].status,'submitted');assert.equal(result.attempts[0].method,'timeout');assert.equal(result.attempts[0].remainingMs,0);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS count FROM ${schema}.doc_job WHERE kind='status'`)).rows[0].count,2);
 });
}
