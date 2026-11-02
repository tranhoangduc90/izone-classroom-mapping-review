import {finishWorkTransaction,registerWorkPublisher,createWorkSignals} from './test-work-runtime.js';

// Only Speaking producers use this transaction boundary. Other shared-API products keep their native transactions.
export async function withSpeakingTransaction(pool,work){
 const client=await pool.connect();
 try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');finishWorkTransaction(pool,client,true);return result;}
 catch(error){await client.query('ROLLBACK');throw error;}
 finally{finishWorkTransaction(pool,client,false);client.release();}
}

export function startSpeakingWorkCoordinator({pool,schema,worker,createClient,onDocs=()=>{},onState=()=>{},onError=()=>{}}){
 if(!['speaking_independent','speaking_homework'].includes(schema))throw Error('SPEAKING_WORK_SCOPE_INVALID');
 let signals;const detach=registerWorkPublisher(pool,lane=>signals?.publish(lane));
 try{signals=createWorkSignals({query:(...args)=>pool.query(...args),createClient,channel:schema+'_work_v1',lanes:['ai','docs','state'],onError,
  onWake:lane=>{if(!lane||lane==='ai')worker.wake?.();if(!lane||lane==='docs')onDocs();onState();}});}catch(error){detach();throw error;}
 let closing;
 return{snapshot:()=>signals.snapshot(),stop(){return closing??=(async()=>{detach();await signals.close();})();}};
}
