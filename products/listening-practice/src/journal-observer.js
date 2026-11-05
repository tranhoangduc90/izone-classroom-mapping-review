import {randomUUID} from 'node:crypto';

// The native transaction owns the result. Logging sees only a small snapshot
// after COMMIT and cannot delay or reject the learner's request.
export function createJournalTransaction({pool,transaction,journal,clock}){
 if(!journal)return fn=>transaction(pool,db=>fn(db,()=>{}));
 return async fn=>{
  let receipt;
  const result=await transaction(pool,db=>fn(db,(b,state,action,operationId,{leaseIssued=false}={})=>{
   try{
   const a=state.attempts.at(-1);if(!a)return;
   receipt={scope:{code:b.code,classCode:b.class_code,studentRef:b.student_ref,attemptId:a.id,attemptNo:a.no},
    operationId:operationId||randomUUID(),data:{action,status:a.status,sequence:a.draft.sequence,
     usedMs:Math.round(a.usedMs),activeMs:Math.round(a.draft.activeMs),audioPositionMs:Math.round(a.draft.audioPosition*1000),
     recoveryPending:Boolean(a.progressRecovery),leaseIssued,nativeOperation:Boolean(operationId)}};
   }catch{receipt=undefined;}
  }));
  if(receipt){
   // Time observed after the database acknowledged COMMIT, not a claimed SQL
   // commit timestamp. Freeze it before asynchronous delivery/retries.
   try{
    receipt.occurredAt=new Date(clock()).toISOString();
    setImmediate(()=>{void Promise.resolve().then(()=>journal.recordReceipt(receipt.scope,receipt)).catch(()=>{});});
   }catch{}
  }
  return result;
 };
}
