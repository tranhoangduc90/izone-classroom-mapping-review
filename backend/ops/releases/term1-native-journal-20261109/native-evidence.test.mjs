import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const root=process.env.TERM1_NATIVE_FIXTURE_ROOT;
assert.ok(root,'TERM1_NATIVE_FIXTURE_ROOT must point to the local staged runtime');
const adapter=new URL('./src/exam-journal-runtime/adapters/term.mjs',pathToFileURL(root+'/'));
const {mountTermJournal}=await import(adapter);

function fixture(enabled=true){
  const slug='term-test-1-k56',session=randomUUID(),rows=[];
  const app={locals:{},post(){},use(handler){this.middleware=handler;}};
  const journal={ready:Promise.resolve(),status:()=>({contextReady:true}),registerCounters(){},async close(){},
    scopeForOwner(owner){return owner;},
    async emit(owner,type,data){rows.push({owner,type,data});}};
  const observer=mountTermJournal(app,{config:{allowedOrigins:[]},productId:'term-mini-k56',schema:'assessment_k56',
    env:{TERM1_NATIVE_JOURNAL_ENABLED:enabled?'1':'0'},journal,
    async lookupQuery(_sql,params){
      if(params[0]!==session)return {rows:[]};
      return {rows:[{test_slug:params[2],source_id:session,student_ref:'fixture-owner',class_code:'FIXTURE',
        generation:'4',definition_version:3,current_definition:{}}]};
    }});
  async function emit(action,fields,{token=session,testSlug=slug}={}){
    const requestId=randomUUID();
    app.middleware({path:'/api/term-tests/'+testSlug+'/session/audio-progress',method:'POST',body:{},
      get:()=>requestId},{once(){}},()=>observer.business(action,testSlug,token,fields));
    await setImmediate();
    return requestId;
  }
  return {rows,emit};
}

test('Term1 server binds only the accepted identity to the verified attempt scope',async()=>{
  const f=fixture();
  const requestId=await f.emit('term1_identity_decision',{accepted:true,lookup:'native_eligibility',reason:'OWNER_BOUND',generation:4});
  await f.emit('term1_identity_decision',{accepted:false,lookup:'retained_owner',reason:'STUDENT_MISMATCH',classCode:'fixture'});
  await f.emit('term1_identity_decision',{accepted:true,lookup:'native_eligibility',reason:'OWNER_BOUND',generation:3});
  assert.equal(f.rows.length,2);
  const [accepted,rejected]=f.rows;
  assert.equal(accepted.owner.studentRef,'fixture-owner');
  assert.equal(accepted.owner.generation,4);
  assert.equal(accepted.data.requestId,requestId);
  assert.equal(accepted.data.outcome,'accepted');
  assert.deepEqual(accepted.data.checkpointState,{term1NativeVersion:1,lookup:'native_eligibility'});
  assert.equal(rejected.owner.studentRef,'__unconfirmed__');
  assert.equal(rejected.owner.sourceId,rejected.data.requestId);
  assert.equal(rejected.data.reasonCode,'STUDENT_MISMATCH');
  assert.equal(rejected.data.outcome,'rejected');
});

test('Term1 checkpoint retains native revision, request and position with no token in payload',async()=>{
  const f=fixture();
  const info={state:'recovered',heardSeconds:18.25,nativeRevision:7,generation:4,grantedRecoverySeconds:0};
  const requestId=await f.emit('term1_listening_checkpoint',{...info,audioOwnerId:'never-export'});
  await f.emit('term1_listening_checkpoint',{...info,nativeRevision:NaN});
  await f.emit('term1_listening_checkpoint',{...info,generation:3});
  await f.emit('term1_listening_checkpoint',info,{testSlug:'term-test-2-k56'});
  assert.equal(f.rows.length,1);
  const [row]=f.rows;
  assert.equal(row.owner.generation,4);
  assert.equal(row.data.requestId,requestId);
  assert.equal(row.data.section,'listening');
  assert.deepEqual(row.data.checkpointState,{term1NativeVersion:1,...info});
  assert.ok(!JSON.stringify(row.data).includes('never-export'));
  const off=fixture(false);
  await off.emit('term1_listening_checkpoint',info);
  assert.deepEqual(off.rows,[]);
});

test('Term1 HTTP routes capture committed Listening and accepted or rejected identity',async()=>{
  const base=pathToFileURL(root+'/src/');
  const [{createApp},{loadConfig},{createRequire}]=await Promise.all([
    import(new URL('app.js',base)),import(new URL('config.js',base)),import('node:module')]);
  const api=createRequire(new URL('../package.json',base))('supertest');
  const config=loadConfig({NODE_ENV:'test',DEPLOYMENT_PROFILE:'k56-ic2264',
    DATABASE_URL:'postgres://fixture.invalid/fixture',GOOGLE_CLIENT_ID:'fixture-client',
    TERM_TEST_ASSET_DIR:root,TERM_TEST_SESSION_SECRET:'isolated-app-fixture-secret-at-least-32'});
  const session=randomUUID(),attempt=randomUUID(),student=randomUUID(),owner=randomUUID(),incident=randomUUID(),requestId=randomUUID();
  const current={id:session,generation:4,audio_state_revision:6,listening_audio_owner_id:owner,
    server_now:'2026-11-09T10:01:00.000Z',listening_started_at:'2026-11-09T10:00:00.000Z',
    listening_deadline_at:'2026-11-09T10:30:00.000Z',listening_audio_checkpoint_at:'2026-11-09T10:00:56.000Z',
    listening_audio_checkpoint_seconds:17,listening_recovery_seconds:0};
  let committed=false;
  const pool={async query(sql,params){
    assert.match(sql,/a\.exam_session_id/);
    assert.equal(params[1],session);
    return {rowCount:1,rows:[{...current,test_slug:'term-test-1-k56',attempt_mode:'cbt',
      mini_definition_snapshot:{version:3}}]};
  },async connect(){return {release(){},async query(sql,params){
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};
    if(sql==='COMMIT'){committed=true;return {rows:[]};}
    if(sql.startsWith('WITH target_classes AS'))return {rowCount:1,rows:[{definition_version:3,class_id:'101',student_id:'201'}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]};
    if(sql.includes('ORDER BY a.created_at DESC'))return {rowCount:1,rows:[{...current,attempt_token:attempt,
      exam_session_token:session,test_slug:'term-test-1-k56',attempt_mode:'cbt',mini_definition_snapshot:{version:3}}]};

    if(sql.includes('FROM assessment.term_test_exam_session'))return {rowCount:1,rows:[{...current}]};
    if(sql.includes('SELECT 1 FROM assessment.term1_skill_grant g'))return {rowCount:0,rows:[]};
    if(sql.includes('SELECT granted_seconds'))return {rowCount:0,rows:[]};
    if(sql.startsWith('UPDATE assessment.term_test_exam_session')){
      assert.equal(params[1],18.25);
      return {rowCount:1,rows:[{...current,listening_audio_checkpoint_seconds:params[1],
        audio_state_revision:7,listening_recovery_seconds:params[6]}]};
    }
    if(sql.includes('INSERT INTO assessment.term_test_audio_recovery_receipt'))return {rowCount:1,rows:[]};
    assert.fail('Unexpected fixture query: '+sql);
  }}}};
  const events=[];
  const journal={ready:Promise.resolve(),status:()=>({contextReady:true}),registerCounters(){},async close(){},
    scopeForOwner(owner){return owner;},
    async emit(scope,type,data){
      if(['term1_listening_checkpoint','term1_identity_decision'].includes(data.action)){
        events.push({scope,type,data,committed});
        await new Promise(()=>{});
      }
    }};
  const app=createApp({config,pool,termTestAssetService:{supports:slug=>slug==='term-test-1-k56',getTiming:()=>({listeningDurationSeconds:1848})},logger:{info(){},warn(){},error(){}},examJournal:journal,
    journalEnv:{TERM1_NATIVE_JOURNAL_ENABLED:'1'},journalLookupQuery:async(_sql,params)=>({rows:[{
      test_slug:params[2],source_id:session,student_ref:'fixture-owner',class_code:'FIXTURE',
      generation:'4',definition_version:3,current_definition:{}}]})});
  const response=await api(app).post('/api/term-tests/term-test-1-k56/session/audio-progress')
    .set('x-exam-journal-request-id',requestId).send({examSessionToken:session,audioOwnerId:owner,
      recoveryId:incident,audioStateRevision:6,generation:4,heardSeconds:18.25,state:'recovered'});
  assert.equal(response.status,200,JSON.stringify(response.body));
  await setImmediate();
  assert.equal(events.length,1);
  const [{data,committed:afterCommit}]=events;
  assert.equal(afterCommit,true);
  assert.equal(data.requestId,requestId);
  assert.equal(data.checkpointState.heardSeconds,response.body.listeningResumeAtSeconds);
  assert.equal(data.checkpointState.nativeRevision,response.body.audioStateRevision);
  assert.equal(data.checkpointState.grantedRecoverySeconds,response.body.grantedRecoverySeconds);

  const route='/api/term-tests/term-test-1-k56/attempt/active';
  const identity={classCode:'FIXTURE',studentRef:student,identityOnly:true};
  committed=false;
  const rejectedId=randomUUID(), acceptedId=randomUUID();
  const rejected=await api(app).post(route).set('x-exam-journal-request-id',rejectedId).send(identity);
  assert.equal(rejected.status,400);
  assert.equal(rejected.body.error,'TOKEN_REQUIRED');
  const accepted=await api(app).post(route).set('x-exam-journal-request-id',acceptedId)
    .send({...identity,attemptToken:attempt,examSessionToken:session});
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  await setImmediate();
  const rejectedProof=events.find(row=>row.data.requestId===rejectedId);
  const acceptedProof=events.find(row=>row.data.requestId===acceptedId);
  assert.equal(rejectedProof.scope.studentRef,'__unconfirmed__');
  assert.equal(rejectedProof.data.reasonCode,'TOKEN_REQUIRED');
  assert.equal(acceptedProof.scope.studentRef,'fixture-owner');
  assert.equal(acceptedProof.scope.generation,4);
  assert.equal(acceptedProof.data.checkpointState.lookup,'native_eligibility');
  assert.equal(acceptedProof.committed,true);

});
