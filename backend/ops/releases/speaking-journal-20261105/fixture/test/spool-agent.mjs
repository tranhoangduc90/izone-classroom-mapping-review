import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

export async function startSpeakingSpoolAgent(libraryRoot,root,port){
 const child=spawn(process.env.EXAM_JOURNAL_TEST_PYTHON||'python',['-u',resolve(libraryRoot,'optimization/producer-agent-fixture.py'),
  '--root',root,'--collector-port',String(port),'--product','speaking-homework','--host-budget'],{
  windowsHide:true,env:{...process.env,EXAM_JOURNAL_PRODUCER_FIXTURE:'synthetic-producer-pipeline-v1'},stdio:['pipe','pipe','pipe']});
 const waiting=[],queued=[];let stderr='',exited=false,closed=false;
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{const row=JSON.parse(line),next=waiting.shift();if(next)next.resolve(row);else queued.push(row);});
 const exit=new Promise(r=>child.once('exit',(code,signal)=>{
  exited=true;for(const item of waiting.splice(0))item.reject(Error('fixture exited '+code+' '+signal+' '+stderr));r({code,signal});
 }));
 const failed=error=>{for(const item of waiting.splice(0))item.reject(error);};child.once('error',failed);child.stdin.on('error',failed);
 const next=()=>queued.length?Promise.resolve(queued.shift()):exited?Promise.reject(Error('fixture exited '+stderr)):new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{const i=waiting.indexOf(item);if(i>=0)waiting.splice(i,1);reject(Error('fixture read timeout '+stderr));},30000);
  const item={resolve:row=>{clearTimeout(timer);resolve(row);},reject:e=>{clearTimeout(timer);reject(e);}};waiting.push(item);
 });
 const waitExit=async()=>{let timer;try{return await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture stop timeout')),5000);})]);}
  finally{clearTimeout(timer);}};
 const close=async()=>{
  if(closed)return;closed=true;
  try{if(!exited){child.stdin.end('{"command":"exit"}\n');await waitExit();}}
  catch(error){if(!exited){child.kill();await waitExit();}throw error;}
  finally{child.stdin.destroy();lines.close();}
 };
 let ready;
 try{ready=await next();assert.equal(ready.ready,true);}catch(error){await close();throw error;}
 return{ready,exit,close,async command(command,extra={}){
  const result=next();child.stdin.write(JSON.stringify({command,...extra})+'\n');return(await result).result;
 }};
}
