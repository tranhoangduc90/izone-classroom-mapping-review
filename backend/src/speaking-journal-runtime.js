// Logging is optional infrastructure: configuration/transport failures never stop Speaking.
export async function startSpeakingJournalRuntime({env=process.env,
 load=()=>import('./exam-journal-runtime/adapters/speaking-producer.mjs'),onHealth=()=>{}}={}){
 const enabled=env.EXAM_JOURNAL_ENABLED==='1';
 let journal=false,failures=0,closed=false,closing,shutdownUnknown=false;
 const notify=(status,errorCode)=>{try{onHealth({type:'speaking_journal_health',status,...errorCode?{errorCode}:{}});}catch{}};
 if(enabled){
  try{
   const module=await load();
   journal=module.createSpeakingProducerJournalFromEnv({env,onFailure:()=>{failures++;}});
   if(typeof journal!=='function'||typeof journal.close!=='function')throw Error('INVALID_JOURNAL');
   // Configuration exists; this is not an ACK from the Agent or Collector.
   notify('configured');
  }catch{
   try{await journal?.close?.();}catch{}
   journal=false;failures++;notify('degraded','SPEAKING_JOURNAL_START_FAILED');
  }
 }
 return {journal,
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
