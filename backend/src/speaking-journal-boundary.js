// Chỉ Speaking dùng boundary này. Native transaction/work-ready vẫn là bên
// quyết định COMMIT; việc chuyển log không được chặn kết quả nghiệp vụ.
import {randomUUID} from 'node:crypto';

export function createSpeakingJournalBoundary({transaction,journal,maxTransactionEvents=32,maxPendingEvents=256,onFailure=()=>{}}){
 const stats={staged:0,committed:0,pending:0,delivered:0,durableQueued:0,unknown:0,overflow:0,discardedOnTransactionError:0};
 const snapshot=()=>({enabled:typeof journal==='function',...stats});
 if(journal==null||journal===false)return{transaction,record:()=>false,recordCommitted:()=>false,snapshot,flush:async()=>snapshot()};
 if(typeof transaction!=='function'||typeof journal!=='function'
  ||!Number.isInteger(maxTransactionEvents)||maxTransactionEvents<1||maxTransactionEvents>100
  ||!Number.isInteger(maxPendingEvents)||maxPendingEvents<1||maxPendingEvents>4096)
  throw Error('SPEAKING_JOURNAL_OPTIONS_INVALID');
 const active=new WeakMap();
 const delivery=[],waiters=[];let sending=false,batchJournal;
 try{const method=Object.getOwnPropertyDescriptor(journal,'batch')?.value;if(typeof method==='function')batchJournal=method.bind(journal);}catch{}
 const failure=code=>{try{onFailure({code});}catch{}};
 function unknown(count=1){stats.unknown+=count;failure('SPEAKING_JOURNAL_PERSISTENCE_UNKNOWN');}
 function settle(receipt){
  try{
   if(receipt?.persisted===true&&receipt.durableQueued!==true)stats.delivered++;
   else if(receipt?.persisted===false&&receipt.durableQueued===true)stats.durableQueued++;
   else unknown();
  }catch{unknown();}
 }
 function scheduleDelivery(){
  if(sending)return;
  sending=true;
  setImmediate(async()=>{
   while(delivery.length){
    const rows=delivery.splice(0,batchJournal?32:1);
    try{
     if(batchJournal){
      const expected=new Set(rows.map(row=>row.deliveryId));
      const result=await batchJournal(rows.map(row=>({deliveryId:row.deliveryId,projection:row.projection})));
      if(!Array.isArray(result)||result.length>rows.length)throw Error('SPEAKING_JOURNAL_BATCH_ACK_INVALID');
      const receipts=new Map();
      for(const row of result){
       if(!row||!expected.has(row.deliveryId)||receipts.has(row.deliveryId))throw Error('SPEAKING_JOURNAL_BATCH_ACK_INVALID');
       receipts.set(row.deliveryId,row.receipt);
      }
      for(const row of rows)settle(receipts.get(row.deliveryId));
     }else settle(await journal(rows[0].projection));
    }catch{unknown(rows.length);}
    finally{stats.pending-=rows.length;}
   }
   sending=false;
   for(const resolve of waiters.splice(0))resolve(snapshot());
  });
 }
 function flush(){
  if(delivery.length)scheduleDelivery();
  return sending?new Promise(resolve=>waiters.push(resolve)):Promise.resolve(snapshot());
 }
 function record(client,projection){
  const rows=active.get(client);
  if(!rows){stats.unknown++;failure('SPEAKING_JOURNAL_NO_TRANSACTION');return false;}
  if(rows.length>=maxTransactionEvents){stats.overflow++;failure('SPEAKING_JOURNAL_TRANSACTION_FULL');return false;}
  try{rows.push(structuredClone(typeof projection==='function'?projection():projection));stats.staged++;return true;}
  catch{stats.unknown++;failure('SPEAKING_JOURNAL_PROJECTION_INVALID');return false;}
 }
 function enqueueCommitted(rows){
  stats.committed+=rows.length;let accepted=0;
  for(const row of rows){
   if(stats.pending>=maxPendingEvents){stats.overflow++;failure('SPEAKING_JOURNAL_DELIVERY_FULL');continue;}
   stats.pending++;delivery.push({deliveryId:randomUUID(),projection:row});accepted++;
  }
  if(delivery.length)scheduleDelivery();
  return accepted;
 }
 // Chỉ caller vừa nhận SQL auto-commit hoặc kết quả I/O mới dùng đường này.
 // Boundary không tự chứng minh kết quả đã commit; ACK của Collector vẫn riêng.
 function recordCommitted(projection){
  let row;
  try{row=structuredClone(typeof projection==='function'?projection():projection);}
  catch{stats.unknown++;failure('SPEAKING_JOURNAL_PROJECTION_INVALID');return false;}
  return enqueueCommitted([row])===1;
 }
 async function observedTransaction(pool,work){
  const rows=[];
  let result;
  try{
   result=await transaction(pool,async client=>{
    active.set(client,rows);
    try{return await work(client);}finally{active.delete(client);}
   });
  }catch(error){stats.discardedOnTransactionError+=rows.length;throw error;}
  enqueueCommitted(rows);
  return result;
 }
 return{transaction:observedTransaction,record,recordCommitted,snapshot,flush};
}

export function speakingJournalTime(value){
 if(value instanceof Date)return value.toISOString();
 if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))
  throw Error('SPEAKING_JOURNAL_NATIVE_TIME_REQUIRED');
 return new Date(value).toISOString();
}
