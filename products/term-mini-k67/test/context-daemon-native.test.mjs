import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import https from 'node:https';
import test from 'node:test';

// Chạy CLI từ image vật lý, DB/HTTPS đều riêng của task; không thay timer 30 giây.
// TLS certificate chỉ là fixture localhost, không dùng khóa hay nguồn production.
if(process.env.PRACTICE_FIXTURE_DATABASE_URL)test('Physical context daemon preserves freshness, recovers source failure, revokes rights and restarts safely', {timeout:150000},async t=>{
  assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
  const {nativeContextFixture}=await import('./context-noop-native-fixture.mjs');
  const {createContextSnapshot}=await import('/app/src/context-contract.js');
  const f=await nativeContextFixture();let server,active;
  t.after(async()=>{
    try{
      if(active&&!active.ended)await stop(active);
      if(server?.listening)await new Promise(resolve=>server.close(resolve));
    }finally{await f.close();}
  });
  await f.db.exec(await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8'));
  await f.db.exec(`CREATE TABLE public.fixture_mutation(table_name text,operation text);
    CREATE FUNCTION public.fixture_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN INSERT INTO public.fixture_mutation VALUES(TG_TABLE_NAME,TG_OP); RETURN NULL; END $$;`);
  for(const table of ['classroom_course_mapping','student_mapping_review','erp_class_membership_snapshot','reviewer_account','reviewer_class_access'])
    await f.db.exec(`CREATE TRIGGER fixture_changed AFTER INSERT OR UPDATE OR DELETE ON mapping.${table} FOR EACH ROW EXECUTE FUNCTION public.fixture_changed()`);
  await f.grantAndVerify();
  const identity=(await f.pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
  const dbUrl=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL);dbUrl.username='k67_context_sync';dbUrl.pathname='/'+identity.db;
  const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',
    classes:[{erp_course_class_id:'990020067',erp_class_name_snapshot:'Lớp CLI mô phỏng',erp_course_id:'5'}],
    students:[{public_id:'80000000-0000-4000-8000-000000000001',erp_course_class_id:'990020067',erp_student_contact_id:'8001',erp_student_name_snapshot:'Học viên CLI mô phỏng',status:'approved'}],
    memberships:[],accounts:[{email:'cli-fixture@example.test',google_subject:null,display_name:'Giáo viên CLI mô phỏng',role:'teacher',status:'active',can_access_all_classes:false}],
    access:[{reviewer_email:'cli-fixture@example.test',erp_course_class_id:'990020067'}]};
  let mode='ok',requests=0,wrongPaths=0,wrongSecrets=0;
  const requestTimes=[],secret='c'.repeat(32);
  server=https.createServer({key:await readFile(new URL('./context-fixture-key.private.pem',import.meta.url)),cert:await readFile(new URL('./context-fixture-cert.private.pem',import.meta.url))},(req,res)=>{
    requests++;requestTimes.push(Date.now());
    if(req.url!=='/term-mini-k67-context/v1/snapshot'){wrongPaths++;res.writeHead(404).end();return;}
    if(req.headers['x-k67-context-key']!==secret){wrongSecrets++;res.writeHead(401).end();return;}
    if(mode==='unavailable'){res.writeHead(503).end();return;}
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(createContextSnapshot(payload)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const apiUrl=`https://localhost:${server.address().port}/term-mini-k67-context/v1/snapshot`;
  const events=[];
  function launch(url=apiUrl){
    const child=spawn(process.execPath,['/app/src/context-sync-server.js'],{stdio:['ignore','pipe','pipe'],env:{...process.env,
      NODE_OPTIONS:'',NODE_EXTRA_CA_CERTS:new URL('./context-fixture-cert.private.pem',import.meta.url).pathname,
      K67_CONTEXT_DATABASE_URL:dbUrl.href,K67_CONTEXT_API_URL:url,K67_CONTEXT_API_SECRET:secret}});
    const result={child,exit:null,signal:null,stdout:'',stderr:''};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',value=>{result.stdout+=value;});child.stderr.on('data',value=>{result.stderr+=value;});
    child.on('error',error=>{result.spawnError=error;});
    result.done=new Promise(resolve=>child.once('exit',(code,signal)=>{result.exit=code;result.signal=signal;result.ended=true;resolve();}));
    active=result;return result;
  }
  async function until(check,message,timeout=40000){
    const deadline=Date.now()+timeout;
    while(!await check()){
      assert.ok(!active?.spawnError,active?.spawnError?.message);
      assert.ok(!active?.ended,'CLI exited unexpectedly: '+active?.stderr);
      assert.ok(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  function count(result,event){return (result.stdout+'\n'+result.stderr).split('\n').filter(line=>{
    try{return JSON.parse(line).event===event;}catch{return false;}
  }).length;}
  async function stop(result){
    if(!result.ended)result.child.kill('SIGTERM');
    await Promise.race([result.done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('CLI_GRACEFUL_STOP_TIMEOUT')),5000);timer.unref();})]);
    assert.equal(result.exit,0,result.stderr);assert.equal(result.signal,null);
  }
  const state=async()=>(await f.pool.query('SELECT source_revision,captured_at FROM mapping.k67_context_state')).rows[0];
  const mutations=async()=>(await f.db.query('SELECT count(*)::int n FROM public.fixture_mutation')).rows[0].n;
  const first=launch();await until(()=>count(first,'k67_context_applied')===1,'First real CLI apply',10000);
  const initial=await state();
  await f.db.query("UPDATE mapping.reviewer_account SET google_subject='fixture-native-binding' WHERE email='cli-fixture@example.test'");
  await f.db.exec('TRUNCATE public.fixture_mutation');
  await until(()=>count(first,'k67_context_applied')===2,'Second unchanged real 30s cycle');
  const unchanged=await state();assert.equal(unchanged.source_revision,initial.source_revision);
  assert.ok(new Date(unchanged.captured_at)>new Date(initial.captured_at));assert.equal(await mutations(),0);
  assert.equal((await f.db.query('SELECT google_subject FROM mapping.reviewer_account')).rows[0].google_subject,'fixture-native-binding');
  mode='unavailable';await until(()=>count(first,'k67_context_unavailable')===1,'Source failure reaches real CLI');
  assert.deepEqual(await state(),unchanged);assert.equal(await mutations(),0);
  await f.db.query(`INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
    VALUES($1,'cli-fixture@example.test','fixture-native-binding',now()+interval '90 days',now()+interval '365 days')`,[Buffer.from('fixture-cli-session-hash')]);
  payload.access=[];payload.students[0].erp_student_name_snapshot='Tên thay đổi CLI mô phỏng';mode='ok';
  await until(()=>count(first,'k67_context_applied')===3,'Source recovery and revocation');
  assert.equal((await f.db.query('SELECT revoked_reason FROM mapping.reviewer_session')).rows[0].revoked_reason,'context_changed');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM mapping.reviewer_class_access')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT erp_student_name_snapshot FROM mapping.student_mapping_review')).rows[0].erp_student_name_snapshot,payload.students[0].erp_student_name_snapshot);
  assert.equal(String((await f.db.query('SELECT erp_course_id FROM mapping.classroom_course_mapping')).rows[0].erp_course_id),'5');
  const recovered=await state();assert.notEqual(recovered.source_revision,initial.source_revision);
  await stop(first);events.push({phase:'four_native_cycles',applied:count(first,'k67_context_applied'),unavailable:count(first,'k67_context_unavailable'),exit:first.exit});
  await f.db.exec('TRUNCATE public.fixture_mutation');
  const restarted=launch();await until(()=>count(restarted,'k67_context_applied')===1,'Restart receives fresh unchanged snapshot',10000);
  assert.equal(await mutations(),0);assert.equal((await state()).source_revision,recovered.source_revision);
  assert.ok(new Date((await state()).captured_at)>new Date(recovered.captured_at));await stop(restarted);
  assert.equal(requests,5);assert.equal(wrongPaths,0);assert.equal(wrongSecrets,0);
  const intervals=requestTimes.slice(1,4).map((value,i)=>value-requestTimes[i]);
  assert.ok(intervals.every(value=>value>=29900&&value<=40000),JSON.stringify(intervals));
  console.log(JSON.stringify({event:'context_daemon_physical_image_proof',events,restartExit:restarted.exit,requests,intervals,sourceFailureRetainedMirror:true,unchangedMirrorWrites:0,sourceRevocationApplied:true,productionAccess:false}));
});
