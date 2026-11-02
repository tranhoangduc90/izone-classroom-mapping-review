/** Shared read-only observation loop; adapters retain their native identity and data stores. */
import {createHash,randomUUID} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable=()=>Object.assign(Error('STATE_UNAVAILABLE'),{code:'STATE_UNAVAILABLE',status:503});

export function createTestObservationHub({read,interval=30000,maxConnections=1000,setTimer=setTimeout,clearTimer=clearTimeout}){
 if(typeof read!=='function'||!Number.isFinite(interval)||interval<1||!Number.isInteger(maxConnections)||maxConnections<1)throw Error('STATE_OPTIONS_INVALID');
 const epoch=randomUUID(),members=new Set(),checksInFlight=new Set();let closed=false,timer=null,reading=null,woken=false,sequence=0,closing;
 const stats={scans:0,emitted:0,errors:0};
 function schedule(delay=interval){if(closed||!members.size)return;if(reading){if(delay===0)woken=true;return;}if(timer){if(delay!==0)return;clearTimer(timer);}timer=setTimer(()=>{timer=null;void scan();},delay);timer?.unref?.();}
 function send(member,event,value){if(closed||member.closed)return;try{member.send(event,value);}catch{member.close();}}
 function failed(member,error){
  if(closed||member.closed)return;const code=error.code||'STATE_UNAVAILABLE',status=error.status||503;
  const signature=status+':'+code;if(member.error!==signature){member.error=signature;send(member,[401,403,423].includes(status)?'access_revoked':'unavailable',{code,status});}
  member.current=null;member.revision=null;if([401,403,423].includes(status))member.close();
 }
 function publish(member,verified){
  if(closed||member.closed||!member.current)return;
  try{
   const currentSession=member.current.sessions.get(member.guard.hash);if(!currentSession)throw Object.assign(unavailable(),{status:401,code:'TEACHER_LOGIN_REQUIRED'});
   member.guard.assertCurrent?.(currentSession,verified);
   const state=member.current.states.get(member.scope.key);if(!state)throw unavailable();
   const value=member.guard.state(state,verified),revision=digest(value);
   if(revision===member.revision&&!member.error)return;member.revision=revision;member.error=null;stats.emitted++;
   send(member,'state',{...value,epoch,sequence:++sequence,revision});
  }catch(error){failed(member,error);}
 }
 async function scan(){
  if(closed||reading)return;const active=[...members];
  reading=(async()=>{try{
   stats.scans++;const snapshot=await read({scopes:active.map(member=>member.scope),guards:active.map(member=>member.guard)});
   if(closed)return;const grouped=new Map();
   for(const member of active){
    if(member.closed)continue;member.current=snapshot;
    const session=snapshot.sessions.get(member.guard.hash);
    if(!session){failed(member,{code:'TEACHER_LOGIN_REQUIRED',status:401});continue;}
    if(member.checking)continue;
    if(!grouped.has(member.guard.key))grouped.set(member.guard.key,Promise.resolve().then(()=>member.guard.verify(session)));
    member.checking=true;
    const check=grouped.get(member.guard.key).then(value=>publish(member,value)).catch(error=>failed(member,error)).finally(()=>{member.checking=false;checksInFlight.delete(check);});
    checksInFlight.add(check);
   }
  }catch(error){stats.errors++;for(const member of active)failed(member,error);}})();
  try{await reading;}finally{reading=null;const delay=woken?0:interval;woken=false;schedule(delay);}
 }
 function subscribe({scope,guard,send:callback}){
  if(closed)throw unavailable();if(members.size>=maxConnections)throw Object.assign(unavailable(),{code:'STATE_CONNECTION_LIMIT'});
  if(!scope?.key||!guard?.hash||!guard.key||typeof guard.verify!=='function'||typeof guard.state!=='function'||typeof callback!=='function')throw Error('STATE_OBSERVER_INVALID');
  const member={scope:{...scope},guard,send:callback,closed:false,current:null,checking:false,revision:null,error:null,
   close(){if(member.closed)return;member.closed=true;members.delete(member);if(!members.size){clearTimer(timer);timer=null;}}};
  members.add(member);schedule(0);return{close:member.close};
 }
 return{subscribe,wake(){schedule(0);},snapshot(){return{...stats,epoch,closed,connections:members.size};},
  readOnce(scope,guard,{signal}={}){
   return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(signal.reason||unavailable());let handle,deadline;
    const finish=(error,value)=>{clearTimer(deadline);signal?.removeEventListener('abort',abort);handle?.close();error?reject(error):resolve(value);};
    const abort=()=>finish(signal.reason||unavailable());
    try{handle=subscribe({scope,guard,send(event,value){if(event==='state')finish(null,value);else if(event==='unavailable'||event==='access_revoked')finish(Object.assign(unavailable(),value));else if(event==='closing')finish(unavailable());}});}
    catch(error){return reject(error);}
    deadline=setTimer(()=>finish(unavailable()),15000);deadline?.unref?.();signal?.addEventListener('abort',abort,{once:true});
   });
  },
  close(){if(!closing)closing=(async()=>{closed=true;clearTimer(timer);for(const member of members){try{member.send('closing',{});}catch{}member.close();}await reading;await Promise.all([...checksInFlight]);})();return closing;}
 };
}

/** Native authentication/renewal precedes this stream. Heartbeats never query SQL. */
export function openTestObservationStream({response,hub,scope,guard}){
 if(response.destroyed||response.writableEnded)return{close(){}};
 let subscription,heartbeat,lifetime,ended=false;
 function close(){if(ended)return;ended=true;clearInterval(heartbeat);clearTimeout(lifetime);subscription?.close();response.removeListener('close',close);if(!response.writableEnded)response.end();}
 subscription=hub.subscribe({scope,guard,send(event,value){
  if(ended||response.destroyed||event==='closing')return close();if(response.writableLength>65536)return close();
  if(!response.write(`${event==='state'?`id: ${value.epoch}:${value.sequence}\n`:''}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))return close();
  if(event==='access_revoked')close();
 }});
 response.on('close',close);
 try{response.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store','X-Accel-Buffering':'no'});response.flushHeaders();}catch(error){close();throw error;}
 heartbeat=setInterval(()=>{if(ended||response.destroyed||!response.write(': keepalive\n\n'))close();},15000);heartbeat.unref?.();
 // Re-read the browser's current cookie no later than the native teacher polling ceiling.
 lifetime=setTimeout(close,30000);lifetime.unref?.();return{close};
}
