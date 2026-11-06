import {queuedDocsReceipt,publishDocsProgress} from './docs-journal-observer.js';
import {randomUUID} from 'node:crypto';
import {canonical} from './domain.js';
import {lessonFor} from './lessons.js';

// So nội dung ngay trong giao dịch; chỉ phát boolean/số đếm, không đưa nháp vào log.
export function readingDraftChanged(before,after){
 try{
  const content=draft=>[draft?.answers,draft?.flags,draft?.notes,draft?.annotations];
  return canonical(content(before))!==canonical(content(after));
 }catch{return false;}
}
export function createJournalTransaction({pool,transaction,journal,clock}){
 if(!journal)return fn=>transaction(pool,db=>fn(db,()=>{}));
 return async fn=>{
  let receipt;const docsReceipts=[];
  const record=(b,state,action,operationId,details={})=>{
   try{
    const a=state.attempts.at(-1);if(!a)return;
    receipt={scope:{code:b.code,classCode:b.class_code,studentRef:b.student_ref,attemptId:a.id,attemptNo:a.no},
     operationId:operationId||randomUUID(),data:{action,status:a.status,sequence:a.draft.sequence,
      usedMs:Math.round(a.usedMs),activeMs:Math.round(a.draft.activeMs),
      answeredCount:Object.values(a.draft.answers).filter(value=>String(value).trim()).length,
      expectedQuestions:lessonFor(b.code).questionIds.length,contentVersion:b.version,
      leaseIssued:Boolean(details.leaseIssued),nativeOperation:Boolean(operationId),
      recoverySupplied:Boolean(details.recoverySupplied),contentChanged:Boolean(details.contentChanged),
      ...(details.previousAttemptId?{previousAttemptId:details.previousAttemptId}:{}),
      ...(a.method?{method:a.method}:{})}};
   }catch{receipt=undefined;}
  };
  record.docs=(b,job,a)=>{const value=queuedDocsReceipt(b,job,a);if(value)docsReceipts.push(value);};
  const result=await transaction(pool,db=>fn(db,record));
  for(const value of docsReceipts)publishDocsProgress(journal,value,clock);
  if(receipt)try{
   // Mốc quan sát sau ACK COMMIT; không tự nhận đây là timestamp commit SQL.
   receipt.occurredAt=new Date(clock()).toISOString();
   const work=()=>journal.recordReceipt(receipt.scope,receipt);
   if(typeof journal.scheduleSource==='function')journal.scheduleSource(work);
   else setImmediate(()=>{void Promise.resolve().then(work).catch(()=>{});});
  }catch{}
  return result;
 };
}
