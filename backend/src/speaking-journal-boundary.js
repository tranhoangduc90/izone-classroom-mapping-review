// Chỉ Speaking dùng boundary này. Native transaction/work-ready vẫn là bên
// quyết định COMMIT; việc chuyển log không được chặn kết quả nghiệp vụ.
export function createSpeakingJournalBoundary({transaction,journal,maxTransactionEvents=32,maxPendingEvents=256,onFailure=()=>{}}){
 const stats={staged:0,committed:0,pending:0,delivered:0,unknown:0,overflow:0,discardedOnTransactionError:0};
 const snapshot=()=>({enabled:typeof journal==='function',...stats});
 if(journal==null||journal===false)return{transaction,record:()=>false,snapshot};
 if(typeof transaction!=='function'||typeof journal!=='function'
  ||!Number.isInteger(maxTransactionEvents)||maxTransactionEvents<1||maxTransactionEvents>100
  ||!Number.isInteger(maxPendingEvents)||maxPendingEvents<1||maxPendingEvents>4096)
  throw Error('SPEAKING_JOURNAL_OPTIONS_INVALID');
 const active=new WeakMap();
 const delivery=[];let sending=false;
 const failure=code=>{try{onFailure({code});}catch{}};
 function scheduleDelivery(){
  if(sending)return;
  sending=true;
  setImmediate(async()=>{
   while(delivery.length){
    const row=delivery.shift();
    try{
     const receipt=await journal(row);
     if(receipt?.persisted===true)stats.delivered++;
     else{stats.unknown++;failure('SPEAKING_JOURNAL_PERSISTENCE_UNKNOWN');}
    }catch{stats.unknown++;failure('SPEAKING_JOURNAL_PERSISTENCE_UNKNOWN');}
    finally{stats.pending--;}
   }
   sending=false;
  });
 }
 function record(client,projection){
  const rows=active.get(client);
  if(!rows){stats.unknown++;failure('SPEAKING_JOURNAL_NO_TRANSACTION');return false;}
  if(rows.length>=maxTransactionEvents){stats.overflow++;failure('SPEAKING_JOURNAL_TRANSACTION_FULL');return false;}
  try{rows.push(structuredClone(typeof projection==='function'?projection():projection));stats.staged++;return true;}
  catch{stats.unknown++;failure('SPEAKING_JOURNAL_PROJECTION_INVALID');return false;}
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
  stats.committed+=rows.length;
  for(const row of rows){
   if(stats.pending>=maxPendingEvents){stats.overflow++;failure('SPEAKING_JOURNAL_DELIVERY_FULL');continue;}
   stats.pending++;delivery.push(row);
  }
  if(delivery.length)scheduleDelivery();
  return result;
 }
 return{transaction:observedTransaction,record,snapshot};
}

export function speakingJournalTime(value){
 if(value instanceof Date)return value.toISOString();
 if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))
  throw Error('SPEAKING_JOURNAL_NATIVE_TIME_REQUIRED');
 return new Date(value).toISOString();
}
