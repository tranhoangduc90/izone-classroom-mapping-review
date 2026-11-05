// Logging is optional infrastructure: configuration/transport failures never stop Speaking.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const requests=new AsyncLocalStorage();
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function withSpeakingJournalRequest(requestId,work){
 const frame={requestId:uuid(requestId)?requestId.toLowerCase():randomUUID(),started:performance.now()};
 return requests.run(frame,()=>work(frame));
}
// Called only after the native grant has checked both SQL and current source membership.
export function rememberSpeakingJournalScope(scope){
 const frame=requests.getStore();if(frame)frame.scope=Object.freeze({...scope});
}

// Successful reads are counts/latencies, not one event per background poll.
export function createSpeakingReadSummary({emit,clock=()=>performance.now(),windowMs=60000,maxGroups=256,setTimer=setTimeout,clearTimer=clearTimeout}){
 const groups=new Map();let timer,emitted=0,failed=0;
 function flush(){
  clearTimer(timer);timer=null;const pending=[...groups.values()];groups.clear();
  for(const row of pending)try{
   const result=emit({scope:row.scope,kind:'api.summary',operationId:randomUUID(),committedAt:new Date().toISOString(),
    data:{route:row.route,requests:row.count,sumDurationMs:row.total,maxDurationMs:row.maximum,windowMs:Math.max(0,Math.round(clock()-row.started)),outcome:'http_response_only'}});
   if(result===false)failed++;else emitted++;
  }catch{failed++;}
 }
 return{
  record(frame,route,httpStatus){
   if(!frame.scope||!['open','doctor_list'].includes(route)||httpStatus<200||httpStatus>=300)return false;
   const key=JSON.stringify([frame.scope,route]);
   if(!groups.has(key)&&groups.size>=maxGroups)flush();
   let row=groups.get(key);
   if(!row){row={scope:{...frame.scope},route,count:0,total:0,maximum:0,started:frame.started};groups.set(key,row);}
   const duration=Math.max(0,Math.round(clock()-frame.started));row.count++;row.total+=duration;row.maximum=Math.max(row.maximum,duration);
   if(!timer){timer=setTimer(flush,windowMs);timer?.unref?.();}
   return true;
  },flush,snapshot:()=>({pendingGroups:groups.size,emitted,failed}),
 };
}
export async function startSpeakingJournalRuntime({env=process.env,
 load=()=>import('./exam-journal-runtime/adapters/speaking-producer.mjs'),onHealth=()=>{},allowedOrigins=[]}={}){
 const enabled=env.EXAM_JOURNAL_ENABLED==='1';
 let journal=false,failures=0,closed=false,closing,shutdownUnknown=false;
 const notify=(status,errorCode)=>{try{onHealth({type:'speaking_journal_health',status,...errorCode?{errorCode}:{}});}catch{}};
 if(enabled){
  try{
   const module=await load();
   journal=module.createSpeakingProducerJournalFromEnv({env,allowedOrigins,onFailure:()=>{failures++;}});
   if(typeof journal!=='function'||typeof journal.close!=='function')throw Error('INVALID_JOURNAL');
   // Configuration exists; this is not an ACK from the Agent or Collector.
   notify('configured');
  }catch{
   try{await journal?.close?.();}catch{}
   journal=false;failures++;notify('degraded','SPEAKING_JOURNAL_START_FAILED');
  }
 }
 return {journal,intake:journal?.intake||null,
  snapshot:()=>({enabled,configured:Boolean(journal),failures,closed,shutdownUnknown}),
  close({flushers=[]}={}){return closing??=(async()=>{
   // Caller first stops HTTP/workers. Keep the transport open until both boundaries drain.
   for(const flush of flushers)try{await flush?.();}catch{failures++;shutdownUnknown=true;}
   try{await journal?.close?.();}catch{failures++;shutdownUnknown=true;}
   try{
    const metrics=journal?.metrics?.();
    if(metrics?.retryBatches>0||metrics?.pending>0||metrics?.producerSpool?.pendingCalls>0||metrics?.producerSpool?.inflight>0){shutdownUnknown=true;}
   }catch{failures++;shutdownUnknown=true;}
   closed=true;
   if(shutdownUnknown)notify('degraded','SPEAKING_JOURNAL_SHUTDOWN_UNKNOWN');
  })();},
 };
}
