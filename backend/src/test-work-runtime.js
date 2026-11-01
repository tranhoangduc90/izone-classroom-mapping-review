/** Canonical small runtime; standalone product copies are pinned by work-runtime-sync.mjs. */
import {randomUUID} from 'node:crypto';

const hints=new WeakMap(),publishers=new WeakMap();
export function markWorkReady(client,lane='docs') {
 if(!hints.has(client))hints.set(client,new Set());hints.get(client).add(lane);
}
export function announceCommittedWork(pool,lane='docs') {
 try{publishers.get(pool)?.(lane);}catch{/* A hint failure cannot undo a committed learner write. */}
}
export function finishWorkTransaction(pool,client,committed) {
 const lanes=hints.get(client);hints.delete(client);
 if(committed&&lanes)for(const lane of lanes)announceCommittedWork(pool,lane);
}
export function registerWorkPublisher(pool,publish) {
 if(publishers.has(pool))throw Error('WORK_PUBLISHER_ALREADY_REGISTERED');
 publishers.set(pool,publish);return()=>{if(publishers.get(pool)===publish)publishers.delete(pool);};
}

/** One bounded dispatcher per lane. A free slot is refilled without waiting for its peers. */
export function createDurableWorkLoop({claim,run,capacity=1,scanMs=1000,cooldownMs=0,onError=()=>{},clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}) {
 if(typeof claim!=='function'||typeof run!=='function'||!Number.isInteger(capacity)||capacity<1||capacity>16
  ||!Number.isFinite(scanMs)||scanMs<1||!Number.isFinite(cooldownMs)||cooldownMs<0)throw Error('WORK_LOOP_OPTIONS_INVALID');
 const slots=Array.from({length:capacity},()=>({running:null,readyAt:0}));
 const stats={claims:0,started:0,completed:0,errors:0};
 let closed=false,timer=null,due=Infinity,claiming=null,woken=false,closing;
 const report=error=>{stats.errors++;try{onError(error);}catch{}};
 function schedule(delay) {
  if(closed)return;if(claiming){if(delay===0)woken=true;return;}
  const idle=slots.filter(s=>!s.running);if(!idle.length)return;
  const at=Math.max(clock()+delay,Math.min(...idle.map(s=>s.readyAt)));
  if(timer&&due<=at)return;clearTimer(timer);due=at;
  timer=setTimer(()=>{timer=null;due=Infinity;void scan();},Math.max(0,at-clock()));timer?.unref?.();
 }
 function start(slot,job) {
  stats.started++;
  slot.running=Promise.resolve().then(()=>run(job)).catch(report).finally(()=>{
   stats.completed++;slot.running=null;slot.readyAt=clock()+cooldownMs;schedule(0);
  });
 }
 async function scan() {
  if(closed||claiming)return;
  const free=slots.filter(s=>!s.running&&s.readyAt<=clock());
  if(!free.length){schedule(0);return;}
  claiming=(async()=>{
   try{
    stats.claims++;const jobs=await claim(free.length);
    if(!Array.isArray(jobs)||jobs.length>free.length)throw Error('WORK_CLAIM_CAPACITY_EXCEEDED');
    // A stop can race a committed claim. Drain this bounded owned batch before closing.
    for(let i=0;i<jobs.length;i++)start(free[i],jobs[i]);
   }catch(error){report(error);}
  })();
  try{await claiming;}finally{claiming=null;const delay=woken?0:scanMs;woken=false;schedule(delay);}
 }
 schedule(0);
 return{
  wake(){schedule(0);},
  snapshot(){return{...stats,closed,running:slots.filter(s=>s.running).length};},
  close(){if(!closing)closing=(async()=>{closed=true;clearTimer(timer);await claiming;await Promise.all(slots.map(s=>s.running));})();return closing;},
 };
}

/** Notifications are hints, coalesced across producers; durable native claims remain authoritative. */
export function createWorkSignals({query,createClient,onWake,channel,lanes=['docs','state'],onError=()=>{},publishDelayMs=25,setTimer=setTimeout,clearTimer=clearTimeout}) {
 if(typeof query!=='function'||typeof createClient!=='function'||typeof onWake!=='function'||!/^[a-z][a-z0-9_]{0,62}$/.test(channel)||!Array.isArray(lanes)||!lanes.length||new Set(lanes).size!==lanes.length
  ||lanes.some(x=>typeof x!=='string'||!x)||!Number.isFinite(publishDelayMs)||publishDelayMs<0||publishDelayMs>100)throw Error('WORK_SIGNAL_OPTIONS_INVALID');
 const allowed=new Set(lanes),sender=randomUUID(),pending=new Set(),disposals=new WeakMap(),disposing=new Set();
 let closed=false,client=null,connecting=null,retryTimer=null,publishTimer=null,publishing=null,failures=0;
 const stats={connected:false,connections:0,sent:0,received:0,errors:0};
 function report(error){stats.errors++;try{onError(error);}catch{}}
 function wake(lane){try{onWake(lane);}catch(error){report(error);}}
 function timer(fn,delay){const value=setTimer(fn,delay);value?.unref?.();return value;}
 function retry(){if(!closed&&!retryTimer)retryTimer=timer(()=>{retryTimer=null;void connect();},Math.min(5000,250*2**Math.min(5,failures++)));}
 function detach(value){value.removeListener('error',value.workError);value.removeListener('end',value.workEnd);value.removeListener('notification',value.workNotification);}
 function discard(value){
  if(!disposals.has(value)){
   const ended=(async()=>{try{await value.end();}catch{}finally{detach(value);}})();
   disposals.set(value,ended);disposing.add(ended);void ended.finally(()=>disposing.delete(ended));
  }
  return disposals.get(value);
 }
 function lost(value,error){if(client!==value)return;client=null;stats.connected=false;if(error)report(error);void discard(value);retry();}
 async function connect(){
  if(closed||client||connecting)return;
  connecting=(async()=>{
   let value;try{value=createClient();}catch(error){report(error);retry();return;}client=value;
   value.workError=error=>lost(value,error);value.workEnd=()=>lost(value);
   value.workNotification=message=>{
    if(closed||client!==value||message.channel!==channel)return;
    let payload;try{payload=JSON.parse(message.payload);}catch{return;}
    if(payload?.v!==1||typeof payload.sender!=='string'||payload.sender===sender||!Array.isArray(payload.lanes)||!payload.lanes.length
     ||payload.lanes.length>allowed.size||payload.lanes.some(lane=>!allowed.has(lane)))return;
    stats.received++;for(const lane of new Set(payload.lanes))wake(lane);
   };
   value.on('error',value.workError);value.on('end',value.workEnd);value.on('notification',value.workNotification);
   try{
    await value.connect();if(closed||client!==value){await discard(value);return;}
    await value.query('LISTEN '+channel);if(closed||client!==value){await discard(value);return;}
    stats.connected=true;stats.connections++;failures=0;wake();
   }catch(error){lost(value,error);}
  })();
  try{await connecting;}finally{connecting=null;if(!closed&&!client)retry();}
 }
 function schedulePublish(){if(!closed&&!publishTimer&&!publishing&&pending.size)publishTimer=timer(()=>{publishTimer=null;void flush();},publishDelayMs);}
 async function flush(){
  if(closed||publishing||!pending.size)return;const ready=[...pending];pending.clear();
  publishing=Promise.resolve().then(()=>query('SELECT pg_notify($1,$2)',[channel,JSON.stringify({v:1,sender,lanes:ready})])).then(()=>{stats.sent++;}).catch(report);
  try{await publishing;}finally{publishing=null;schedulePublish();}
 }
 void connect();
 return{
  publish(lane){if(closed)return;if(!allowed.has(lane))throw Error('WORK_LANE_INVALID');wake(lane);pending.add(lane);schedulePublish();},
  snapshot(){return{...stats,closed,pending:pending.size};},
  async close(){if(closed)return;closed=true;clearTimer(retryTimer);clearTimer(publishTimer);pending.clear();await connecting;const value=client;client=null;stats.connected=false;if(value)await discard(value);await Promise.all([...disposing]);await publishing;},
 };
}

export function startCoordinatedDocs({pool,worker,createClient,channel,onError=()=>{},onState=()=>{}}) {
 if(publishers.has(pool))throw Error('WORK_PUBLISHER_ALREADY_REGISTERED');
 const loop=createDurableWorkLoop({claim:n=>worker.claim(n),run:job=>worker.run(job),capacity:1,scanMs:1000,cooldownMs:1000,onError});
 const signals=createWorkSignals({query:(...args)=>pool.query(...args),createClient,channel,onError,onWake:lane=>{if(!lane||lane==='docs')loop.wake();onState();}});
 const detach=registerWorkPublisher(pool,lane=>signals.publish(lane));let closing;
 return{snapshot:()=>({loop:loop.snapshot(),signals:signals.snapshot()}),
  stop(){if(!closing)closing=(async()=>{await loop.close();detach();await signals.close();})();return closing;}};
}
