import {AsyncLocalStorage} from 'node:async_hooks';

// Context belongs to one committed worker claim. It never contains URLs,
// prompts, response bodies, credentials, or authority supplied by a browser.
const requests=new AsyncLocalStorage();
const routes=new Set(['share_direct','share_gateway','check_ai','doctor_ai']);
const reasons=new Set(['initial','retry','redirect','correction']);
const noop={headers(){},failed(){}};
const code=error=>error?.name==='TimeoutError'?'PROVIDER_TIMEOUT':error?.name==='AbortError'?'PROVIDER_ABORTED'
 :['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT'].includes(error?.code)?error.code:'PROVIDER_TRANSPORT_FAILED';

export function withSpeakingProviderJournal(observe,action){
 if(typeof observe!=='function')return action();
 return requests.run({observe,counter:{next:0}},action);
}

export function withSpeakingProviderPart(part,action){
 const context=requests.getStore();
 if(!context||typeof part!=='string'||!/^[a-z0-9_]{1,40}$/.test(part))return action();
 return requests.run({...context,part},action);
}

export function beginSpeakingProviderRequest(route,{attempt=1,reason='initial'}={}){
 const context=requests.getStore();
 if(!context||!routes.has(route)||!Number.isSafeInteger(attempt)||attempt<1||attempt>1000||!reasons.has(reason))return noop;
 const requestOrdinal=++context.counter.next,started=performance.now();let settled=false;
 const emit=data=>{
  try{
   const result=context.observe({at:new Date().toISOString(),data:{route,requestOrdinal,attempt,reason,
    ...(context.part?{part:context.part}:{}),...data}});
   if(result&&typeof result.catch==='function')result.catch(()=>{});
  }catch{}
 };
 emit({phase:'started'});
 const finish=data=>{
  if(settled)return;settled=true;
  emit({durationMs:Math.max(0,Math.round(performance.now()-started)),...data});
 };
 return{
  headers(status){
   if(Number.isInteger(status)&&status>=100&&status<=599)finish({phase:'headers',httpStatus:status});
   else finish({phase:'outcome_unknown',errorCode:'PROVIDER_STATUS_UNKNOWN'});
  },
  failed(error){let errorCode='PROVIDER_TRANSPORT_FAILED';try{errorCode=code(error);}catch{}finish({phase:'failed',errorCode});},
 };
}

// The measured interval ends at response headers, not JSON/body validation or
// provider completion. Return the identical response/error to the native caller.
export function speakingProviderCall(route,call,options){
 return async(...args)=>{
  const request=beginSpeakingProviderRequest(route,options);
  if(request===noop)return call(...args);
  try{const response=await call(...args);let status;try{status=response?.status;}catch{}request.headers(status);return response;}
  catch(error){request.failed(error);throw error;}
 };
}
