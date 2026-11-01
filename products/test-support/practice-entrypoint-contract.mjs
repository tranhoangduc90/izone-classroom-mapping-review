// Starts each actual src/server.js against only the isolated task PostgreSQL server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await check())return;await sleep(25);}throw Error('ENTRYPOINT_TIMEOUT:'+label);}
async function freePort(){const server=http.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function stopChild(child,ended){
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');let timer;
 try{const result=await Promise.race([ended,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ENTRYPOINT_DRAIN_TIMEOUT')),10000);})]);assert.deepEqual(result,[0,null]);}
 finally{clearTimeout(timer);}
}

export function entrypointContract({product,fixture,poolUrl,uuid}){
 test(`${product}: actual entrypoint preserves a running draft across disabled, coordinated and legacy worker restarts`,{timeout:60000},async()=>{
  const f=await fixture(),schema=product+'_practice',prefix=product.toUpperCase(),channel=schema+'_work_v1';
  const directory=await mkdtemp(path.join(tmpdir(),'tsto-entry-'+product+'-')),audio=path.join(directory,'fixture.mp3');
  let child,ended,stdout='',stderr='',snapshotRequests=0,unexpected=0;
  const authority=http.createServer((req,res)=>{
   if(req.url!=='/v1/snapshot'||req.headers['x-k67-context-key']!=='k'.repeat(32)){unexpected++;res.writeHead(403).end();return;}
   snapshotRequests++;
   const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'FIXTURE 67'}],
    students:[{public_id:f.studentRef,erp_course_class_id:'1124',erp_student_contact_id:'1',erp_student_name_snapshot:'Synthetic entrypoint learner',status:'approved'}],
    memberships:[{erp_course_class_id:'1124',erp_student_contact_id:'1',erp_student_name_snapshot:'Synthetic entrypoint learner',source_state:'active'}],accounts:[],access:[]};
   res.setHeader('content-type','application/json');res.end(JSON.stringify({...payload,capturedAt:new Date().toISOString(),sourceRevision:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}));
  });
  authority.listen(0,'127.0.0.1');await once(authority,'listening');
  try{
   await writeFile(audio,Buffer.from('Synthetic fixture asset; not an audio-quality test.'));
   let lease,attemptId;const snapshot=f.draft();snapshot.notes='Synthetic running draft survives actual process replacement.';
   const artifactBefore=JSON.stringify((await f.pool.query(`SELECT id,binding_id,sequence,payload FROM ${schema}.doc_job ORDER BY id`)).rows);
   for(const mode of ['disabled','coordinated','legacy']){
    const port=await freePort(),authorityUrl='http://127.0.0.1:'+authority.address().port;
    const settings={DATABASE_URL:poolUrl(f.pool),CONTEXT_URL:authorityUrl,CONTEXT_KEY:'k'.repeat(32),OWNER_SOURCE_URL:authorityUrl,OWNER_SOURCE_KEY:'o'.repeat(32),
     ADMIN_KEY:'a'.repeat(43),GOOGLE_CLIENT_ID:'synthetic-google-client',PAGE_BASE:'https://page.test/'+product+'/',ALLOWED_ORIGINS:'https://page.test',PORT:String(port),
     DOCS_CLIENT_ID:'synthetic-docs-client',DOCS_CLIENT_SECRET:'synthetic-secret',DOCS_REFRESH_TOKEN:'synthetic-refresh',WORKERS_ENABLED:mode==='disabled'?'false':'true',WORK_COORDINATOR_ENABLED:mode==='legacy'?'false':'true'};
    if(product==='listening')settings.AUDIO_FILE=audio;
    const env={PATH:process.env.PATH,...Object.fromEntries(Object.entries(settings).map(([key,value])=>[prefix+'_'+key,value]))};
    stdout='';stderr='';child=spawn(process.execPath,['src/server.js'],{cwd:fileURLToPath(new URL('../'+product+'-practice/',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
    ended=once(child,'exit');child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
    const send=async(route,body,authorized=true,origin='https://page.test')=>{
     const response=await fetch(`http://127.0.0.1:${port}/api/${route}`,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(authorized?{Authorization:'Bearer '+f.token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
     return{status:response.status,body:await response.json()};
    };
    await until(()=>{if(child.exitCode!==null)throw Error('ENTRYPOINT_EXITED:'+stderr);return stdout.includes('"port":'+port);},mode+' started');
    assert.equal((await send('health')).status,200);assert.equal((await send('state',undefined,false)).status,401);assert.equal((await send('state',undefined,true,'https://denied.test')).status,403);
    if(mode==='disabled'){
     const begun=await send('begin',{operationId:uuid(),owner:'native-entry-device'});assert.equal(begun.status,200);lease=begun.body.lease;attemptId=begun.body.attempts.at(-1).id;
     assert.equal((await send('activate',{attemptId,lease})).status,200);
    }
    snapshot.sequence++;snapshot.activeMs=0;if(product==='listening')snapshot.audioPosition=0;
    const input={attemptId,lease,snapshot},compact=await send('pulse?ack=compact-v1',input);assert.equal(compact.status,200);assert.equal(compact.body.ack,'practice-pulse-v1');assert.equal(compact.body.attempt.id,attemptId);
    const full=await send('pulse',input);assert.equal(full.status,200);assert.equal(full.body.attempts.at(-1).notes,snapshot.notes);assert.equal(full.body.attempts.at(-1).sequence,snapshot.sequence);
    // Queue remains durable but not due; no real Docs/OAuth request is needed for this entrypoint test.
    await f.pool.query(`UPDATE ${schema}.doc_job SET available_at=now()+interval '1 day'`);
    const expected=mode==='coordinated'?1:0;
    await until(async()=>Number((await f.pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND query=$1",['LISTEN '+channel])).rows[0].n)===expected,'listener count');
    const state=(await f.pool.query(`SELECT state FROM ${schema}.work WHERE binding_id=$1`,[f.registered.bindingId])).rows[0].state;
    assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].status,'running');assert.equal(state.attempts[0].draft.notes,snapshot.notes);
    await stopChild(child,ended);child=null;
    assert.equal(stderr,'');
    await until(async()=>Number((await f.pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND query=$1",['LISTEN '+channel])).rows[0].n)===0,'listener drained');
   }
   const jobs=(await f.pool.query(`SELECT id,binding_id,sequence,payload FROM ${schema}.doc_job ORDER BY id`)).rows;
   assert.equal(jobs.length,2);assert.ok(jobs.some(job=>JSON.stringify([job])===artifactBefore));assert.equal(snapshotRequests,3);assert.equal(unexpected,0);
   console.log(JSON.stringify({event:'practice_actual_entrypoint',product,modes:3,gracefulRestarts:3,snapshotRequests,queuedJobs:jobs.length,externalCredentials:false}));
  }finally{
   if(child)await stopChild(child,ended);
   authority.closeAllConnections();await new Promise(r=>authority.close(r));await f.close();await rm(directory,{recursive:true,force:true});
  }
 });
}
