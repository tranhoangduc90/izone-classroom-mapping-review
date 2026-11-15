import {createTerm1ListeningReportQueue} from './listening-report-queue.mjs';
import {createTerm1OfflineListeningReportResolver,createTerm1FallbackListeningReportResolver} from './listening-report-native.mjs';
import {createTerm1OnlineListeningReportResolver} from './listening-report-online.mjs';
import {mountTerm1ListeningReportIngress} from './listening-report-ingress.mjs';

// Explicitly configured by the release operator with a bounded connection pool and
// an already verified private Telegram destination. The regular exam does not call this loop.
export async function startTerm1ListeningReportService({router,limiter,query,makePermit,onlineSecret,send,
  allowReporting=()=>true,observe=()=>{}}) {
  if (typeof send?.photo!=='function') throw Error('LISTENING_REPORT_TELEGRAM_NOT_CONFIGURED');
  await send.checkAuthorization();
  await query('SELECT incident_id FROM assessment.term1_k56_listening_report LIMIT 0');
  const queue=createTerm1ListeningReportQueue({query,
    sendPhoto:send.photo,
    sendText:({id,text})=>send({id,text,nodeId:'term1-k56-listening',severity:'warning'})
  });
  const resolveOffline=createTerm1OfflineListeningReportResolver({query,makePermit});
  const resolveOnline=createTerm1OnlineListeningReportResolver({query,secret:onlineSecret});
  const resolveFallback=createTerm1FallbackListeningReportResolver({query});
  const resolveReport=(body,capability)=>{
    if(body.mode==='fallback')return resolveFallback(body,capability);
    return body.mode==='offline'?resolveOffline(body,capability):resolveOnline(body,capability);
  };
  mountTerm1ListeningReportIngress(router,{limiter,resolveReport,queue,allowReporting,observe});
  let inFlight, closed=false, nextSweepAt=0;
  async function spendTick(){
    const now=Date.now();
    if(now>=nextSweepAt){
      await queue.expire();
      nextSweepAt=now+60000;
    }
    const result=allowReporting()?await queue.runOne():null;
    if(result)try{observe(result);}catch{}
  }
  function tick(){
    if(closed||inFlight)return;
    inFlight=spendTick().catch(()=>{
      try{observe({status:'delivery_worker_error'});}catch{}
    }).finally(()=>{inFlight=undefined;});
  }
  const clock=setInterval(tick,3000);
  clock.unref?.();
  tick();
  return {async close(){
    closed=true;
    clearInterval(clock);
    await inFlight;
  }};
}

// Offline prepare advertises reporting only after the route, database and
// destination are ready. Their failure must leave the normal exam available.
export function armTerm1ListeningReportService(options) {
  let service;
  let disabled=false;
  const ready=options.send ? startTerm1ListeningReportService(options).then(instance=>{
    service=instance;
    return !disabled;
  },()=>{
    try{options.observe?.({status:'delivery_startup_unavailable'});}catch{}
    return false;
  }) : Promise.resolve(false);
  return {
    ready,
    enabled:()=>Boolean(service)&&!disabled&&(!options.allowReporting||options.allowReporting()),
    async close(){
      disabled=true;
      await ready;
      await service?.close();
    },
  };
}
