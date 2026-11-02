import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async check=>{const end=performance.now()+20000;while(performance.now()<end){if(await check())return;await pause(30);}throw Error('SPEAKING_ENTRYPOINT_TIMEOUT');};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});

/** A separate real entrypoint, private source server and task-owned database; never sends work to an AI/Google service. */
export async function speakingEntrypointContract({fixture,identity,dbUrl,requestLinkOnly}){
 const f=await fixture(),secret='native-speaking-source-secret-32-characters-only';let allowed=true,sourceReads=0,child;
 const source=http.createServer(async(req,res)=>{
  try{
   assert.equal(req.headers['x-speaking-worker-secret'],secret);assert.equal(req.url,'/internal/independent/context');assert.equal(req.method,'POST');let raw='';for await(const part of req)raw+=part;
   sourceReads++;if(!allowed){res.writeHead(403,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:'STUDENT_NOT_ACTIVE',message:'Synthetic revocation'}));return;}
   const context=await f.source.context(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,...context}));
  }catch(error){res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:'FIXTURE_SOURCE_ERROR'}));}
 });
 const sourcePort=await listen(source),records=[];
 const saved=async()=>{
  const result={};for(const name of ['work_unit','link','job','receipt','doc_progress'])result[name]=(await f.pool.query(`SELECT * FROM speaking_independent.${name} ORDER BY ${name==='doc_progress'?'unit_id':'id'}`)).rows;
  return result;
 };
 const stop=async()=>{
  if(!child)return;const current=child;child=null;if(current.exitCode!==null)return current.exitCode;
  const exited=new Promise(resolve=>current.once('exit',resolve));current.kill('SIGTERM');let timer;
  const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('SPEAKING_ENTRYPOINT_NOT_DRAINED:'+current.pid)),12000);});
  try{return await Promise.race([exited,deadline]);}finally{clearTimeout(timer);}
 };
 try{
  await requestLinkOnly(f);const before=await saved();
  for(const mode of [{coordinated:false,enabled:false},{coordinated:true,enabled:false},{coordinated:true,enabled:true}]){
   const reservation=http.createServer(),port=await listen(reservation);await close(reservation);let logs='';
   child=spawn(process.execPath,[fileURLToPath(new URL('../../backend/src/speaking-independent-server.js',import.meta.url))],{stdio:['ignore','pipe','pipe'],env:{...process.env,
    PORT:String(port),NODE_OPTIONS:'',INDEPENDENT_DATABASE_URL:dbUrl,INDEPENDENT_ACCESS_SECRET:'fixture-secret-32-characters-long-only',SPEAKING_SOURCE_URL:'http://127.0.0.1:'+sourcePort,SPEAKING_SOURCE_SECRET:secret,
    WORKER_ENABLED:String(mode.enabled),TEST_SERVICES_COORDINATOR_ENABLED:String(mode.coordinated),SPEAKING_PROGRESS_DOCS_ENABLED:'true',SPEAKING_DOCS_READ_CREDENTIALS_FILE:'',SPEAKING_DOCS_GATEWAY_URL:'',SPEAKING_DOCS_GATEWAY_SECRET:''}});
   child.stdout.on('data',part=>logs=(logs+part).slice(-2000));child.stderr.on('data',part=>logs=(logs+part).slice(-2000));
   const origin='http://127.0.0.1:'+port;
   await until(async()=>{if(child.exitCode!==null)throw Error('SPEAKING_ENTRYPOINT_EARLY_EXIT:'+child.exitCode+':'+logs);try{return(await fetch(origin+'/health',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});
   const listenerCount=async()=>Number((await f.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='speaking_independent_work_listener' AND datname=current_database()")).rows[0].n);
   await until(async()=>await listenerCount()===(mode.coordinated?1:0));
   const open=()=>fetch(origin+'/api/speaking-homework-independent/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(identity(f)),signal:AbortSignal.timeout(10000)});
   const response=await open();assert.equal(response.status,200);const body=await response.json();assert.equal(body.ok,true);assert.equal(body.links.length,1);assert.equal(body.links[0].status,'accepted');
   allowed=false;assert.equal((await open()).status,403);allowed=true;
   assert.deepEqual(await saved(),before);const pid=child.pid;assert.equal(await stop(),0);await until(async()=>await listenerCount()===0);assert.deepEqual(await saved(),before);records.push({...mode,pid,exitCode:0,listenerClosed:true,workUnchanged:true});
  }
  assert.ok(sourceReads>=6);console.log(JSON.stringify({event:'speaking_actual_entrypoint',modes:records,sourceReads,externalCredentials:false}));
 }finally{if(child)await stop();await close(source);await f.db.close();}
}
