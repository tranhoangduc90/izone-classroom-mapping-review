import {createMiniListeningReportQueue} from './listening-report-queue.mjs';
import {createMiniOfflineListeningReportResolver} from './listening-report-native.mjs';
import {createMiniOnlineListeningReportResolver} from './listening-report-online.mjs';
import {mountMiniListeningReportIngress} from './listening-report-ingress.mjs';

// Explicitly configured by the release operator with a bounded connection pool and
// an already verified private Telegram destination. The regular exam does not call this loop.
export async function startMiniListeningReportService({router,limiter,query,makePermit,onlineSecret,send,
  allowReporting=()=>true,observe=()=>{}}) {
  if (typeof send?.photo!=='function') throw Error('LISTENING_REPORT_TELEGRAM_NOT_CONFIGURED');
  await send.checkAuthorization();
  await query('SELECT incident_id FROM assessment.mini_k56_listening_report LIMIT 0');
  const queue=createMiniListeningReportQueue({query,
    sendPhoto:send.photo,
    sendText:({id,text})=>send({id,text,nodeId:'mini-k56-listening',severity:'warning'})
  });
  const resolveOffline=createMiniOfflineListeningReportResolver({query,makePermit});
  const resolveOnline=createMiniOnlineListeningReportResolver({query,secret:onlineSecret});
  const resolveReport=(body,capability)=>body.mode==='offline'
    ?resolveOffline(body,capability):resolveOnline(body,capability);
  mountMiniListeningReportIngress(router,{limiter,resolveReport,queue,allowReporting,observe});
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
export function armMiniListeningReportService(options) {
  let service;
  let disabled=false;
  const ready=options.send ? startMiniListeningReportService(options).then(instance=>{
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
