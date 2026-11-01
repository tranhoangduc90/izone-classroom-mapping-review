/** HTTP-only projection: native work, operation receipts and legacy responses remain complete. */
import {createHash} from 'node:crypto';
export const PRACTICE_HISTORY_MODE='on-demand-v1';
const fields=['id','no','status','startedAt','completedAt','endedAt','submissionId','usedMs','remainingMs','phase','finalScore','method','pauseReason','sequence'];
export function projectPracticeHistory(value,{enabled=false,selectedAttemptId=value?.attempt?.id}={}){
 if(!enabled||!Array.isArray(value?.attempts))return value;
 if(selectedAttemptId&&!value.attempts.some(attempt=>attempt.id===selectedAttemptId))throw Error('HISTORY_ATTEMPT_NOT_FOUND');
 const latestId=value.attempts.at(-1)?.id;
 const attempts=value.attempts.map(attempt=>{
  const detailRevision=createHash('sha256').update(JSON.stringify(attempt)).digest('hex');
  if(attempt.id===latestId||attempt.id===selectedAttemptId)return{...attempt,detailsLoaded:true,detailRevision};
  return{...Object.fromEntries(fields.filter(key=>attempt[key]!==undefined).map(key=>[key,attempt[key]])),
   answeredCount:Object.values(attempt.answers||{}).filter(value=>String(value).trim()).length,detailsLoaded:false,detailRevision};
 });
 return{...value,historyMode:PRACTICE_HISTORY_MODE,attempts,...(value.attempt?{attempt:attempts.find(attempt=>attempt.id===value.attempt.id)}:{})};
}
