import test from 'node:test';
import assert from 'node:assert/strict';

export function workDispatchContract({product,schema,fixture,createDocsWorker,registerWorkPublisher,readConfig,uuid,secret}) {
 test(`${product}: one SQL claim respects binding order, capacity and expired leases`,async t=>{
  const f=await fixture();t.after(f.close);await f.begin();
  for(let n=0;n<2;n++){
   const id=uuid();await f.pool.query(`INSERT INTO ${schema}.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof)
    SELECT $1,assignment_id,$2,$3,tab_id,$4,owner_proof FROM ${schema}.binding WHERE id=$5`,[id,uuid(),'synthetic_batch_document_'+n,secret(),f.registered.bindingId]);
   for(const sequence of [0,1])await f.pool.query(`INSERT INTO ${schema}.doc_job(id,binding_id,sequence,kind,payload) VALUES($1,$2,$3,$4,$5)`,[uuid(),id,sequence,sequence?'status':'cta',{}]);
  }
  const worker=createDocsWorker({pool:f.pool,docs:{}}),other=createDocsWorker({pool:f.pool,docs:{}}),query=f.pool.query.bind(f.pool);let calls=0;
  f.pool.query=async(...args)=>{calls++;return query(...args);};
  const first=await worker.claim(2);assert.equal(calls,1);assert.equal(first.length,2);assert.equal(new Set(first.map(j=>j.binding_id)).size,2);assert.ok(first.every(j=>j.sequence===0&&j.status==='processing'&&j.attempts===1&&j.leaseId));
  const second=await other.claim(16);assert.equal(second.length,1);assert.equal(second[0].sequence,0);assert.equal(new Set([...first,...second].map(j=>j.id)).size,3);
  calls=0;assert.deepEqual(await worker.claim(1),[]);assert.equal(calls,1);
  const [done,expired]=first;await f.pool.query(`UPDATE ${schema}.doc_job SET status='verified' WHERE id=$1`,[done.id]);
  const next=await other.claim(1);assert.equal(next.length,1);assert.equal(next[0].binding_id,done.binding_id);assert.equal(next[0].sequence,1);
  await f.pool.query(`UPDATE ${schema}.doc_job SET lease_until=now()-interval '1 second' WHERE id=$1`,[expired.id]);
  const recovered=await worker.claim(1);assert.equal(recovered[0].id,expired.id);assert.notEqual(recovered[0].leaseId,expired.leaseId);assert.equal(recovered[0].attempts,2);
  await assert.rejects(worker.claim(0),/DOC_CLAIM_LIMIT_INVALID/);await assert.rejects(worker.claim(17),/DOC_CLAIM_LIMIT_INVALID/);
 });

 test(`${product}: work hints follow commit, never pulse/replay/rollback, and notifier failure cannot reject a save`,async t=>{
  const f=await fixture();t.after(f.close);const wakes=[],detach=registerWorkPublisher(f.pool,lane=>wakes.push(lane));t.after(detach);
  await f.service.register(f.registration);assert.deepEqual(wakes,[]);
  const start=await f.begin(),snapshot=f.draft();snapshot.sequence=1;await f.service.pulse({token:f.token,attemptId:start.attempts[0].id,lease:start.lease,snapshot});assert.deepEqual(wakes,['docs']);
  const connect=f.pool.connect.bind(f.pool);let reject=true;
  f.pool.connect=async()=>{const c=await connect();return{...c,query:async(sql,args)=>{if(sql==='COMMIT'&&reject){reject=false;throw Error('SYNTHETIC_COMMIT_FAILURE');}return c.query(sql,args);}};};
  const input={token:f.token,operationId:uuid(),attemptId:start.attempts[0].id,lease:start.lease,snapshot,method:'manual'};
  await assert.rejects(f.service.submit(input),/SYNTHETIC_COMMIT_FAILURE/);assert.deepEqual(wakes,['docs']);assert.equal((await f.service.read({token:f.token})).attempts[0].status,'running');
  const done=await f.service.submit(input);assert.deepEqual(wakes,['docs','docs']);await f.service.submit(input);assert.deepEqual(wakes,['docs','docs']);assert.equal(done.attempts[0].status,'submitted');
  detach();const stop=registerWorkPublisher(f.pool,()=>{throw Error('NOTIFIER_UNAVAILABLE');});t.after(stop);
  const fresh=await f.service.reset({token:f.token,operationId:uuid(),attemptId:start.attempts[0].id,owner:'device2'});assert.equal(fresh.attempts.length,2);
 });

 test(`${product}: completed Docs readback emits state only after its verified commit`,async t=>{
  const f=await fixture();t.after(f.close);const wakes=[],detach=registerWorkPublisher(f.pool,lane=>wakes.push(lane));t.after(detach);
  const b=(await f.pool.query(`SELECT * FROM ${schema}.binding WHERE id=$1`,[f.registered.bindingId])).rows[0];
  const paragraph=(index,text,link)=>({startIndex:index,endIndex:index+text.length+1,paragraph:{elements:[{startIndex:index,endIndex:index+text.length,textRun:{content:text,textStyle:link?{link:{url:link}}:{}}}]}});
  const doc={documentId:b.document_id,revisionId:'synthetic-revision',tabs:[{tabProperties:{tabId:b.tab_id},documentTab:{body:{content:[paragraph(1,f.content.code),paragraph(100,product==='Reading'?'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP READING':'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING',f.registered.entryUrl)]}}}]};
  let writes=0;const worker=createDocsWorker({pool:f.pool,docs:{read:async()=>doc,write:async()=>writes++}});
  const [job]=await worker.claim(1);assert.deepEqual(wakes,[]);await worker.run(job);
  assert.equal(writes,0);assert.equal((await f.pool.query(`SELECT status FROM ${schema}.doc_job WHERE id=$1`,[job.id])).rows[0].status,'verified');assert.deepEqual(wakes,['state']);
 });

 test(`${product}: worker disable and opt-in coordinator flags preserve startup defaults`,()=>{
  const prefix=product.toUpperCase(),env={
   [`${prefix}_DATABASE_URL`]:'postgres://fixture@127.0.0.1/isolated_fixture',
   [`${prefix}_CONTEXT_URL`]:'https://fixture.test/context',[`${prefix}_CONTEXT_KEY`]:'K'.repeat(32),
   [`${prefix}_OWNER_SOURCE_URL`]:'https://fixture.test/owner',[`${prefix}_OWNER_SOURCE_KEY`]:'K'.repeat(32),
   [`${prefix}_ADMIN_KEY`]:'A'.repeat(43),[`${prefix}_GOOGLE_CLIENT_ID`]:'synthetic-client-id',
   [`${prefix}_PAGE_BASE`]:'https://fixture.test/',[`${prefix}_ALLOWED_ORIGINS`]:'https://fixture.test',
   [`${prefix}_DOCS_CLIENT_ID`]:'synthetic-client',[`${prefix}_DOCS_CLIENT_SECRET`]:'synthetic-secret',[`${prefix}_DOCS_REFRESH_TOKEN`]:'synthetic-refresh',
   ...(product==='Listening'?{LISTENING_AUDIO_FILE:'/synthetic/audio.mp3',LISTENING_REVIEW_FILE:'/synthetic/review.json'}:{}),
  };
  const defaults=readConfig(env);assert.equal(defaults[`${prefix}_WORKERS_ENABLED`],'true');assert.equal(defaults[`${prefix}_WORK_COORDINATOR_ENABLED`],'false');
  const disabled=readConfig({...env,[`${prefix}_WORKERS_ENABLED`]:'false',[`${prefix}_WORK_COORDINATOR_ENABLED`]:'true'});assert.equal(disabled[`${prefix}_WORKERS_ENABLED`],'false');
  assert.throws(()=>readConfig({...env,[`${prefix}_WORKERS_ENABLED`]:'yes'}));
 });
}
