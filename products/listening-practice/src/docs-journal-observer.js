import {createHash} from 'node:crypto';
import {canonical} from './domain.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const scope=(b,a)=>({code:b.code,classCode:b.class_code,studentRef:b.student_ref,attemptId:a.id,attemptNo:a.no});
const count=(value,max=Number.MAX_SAFE_INTEGER)=>Math.max(0,Math.min(max,Math.round(value)||0));
const fields=job=>({jobKind:job.kind,queueSequence:job.sequence,jobAttempt:job.attempts||0,payloadHash:digest(job.payload),
 ...(uuid.test(job.leaseId||'')?{runHash:digest(['docs-run',job.leaseId])}:{})});

// Chỉ gọi sau ACK COMMIT. Không await bộ ghi và không chuyển nội dung job vào log.
export function publishDocsProgress(journal,receipt,clock=Date.now){
 if(!journal?.recordProgress||!receipt)return;
 try{
  const captured={...receipt,occurredAt:new Date(clock()).toISOString()};
  setImmediate(()=>{void Promise.resolve().then(()=>journal.recordProgress(captured.scope,captured)).catch(()=>{});});
 }catch{}
}
export function queuedDocsReceipt(b,job,a){
 try{
  if(!job)return null;
  const attempt=job.kind==='cta'?{id:b.id,no:0}:a;
  if(!uuid.test(attempt?.id||'')||!Number.isSafeInteger(attempt.no))return null;
  return{scope:scope(b,attempt),operationId:job.id,data:{...fields(job),phase:'queued'}};
 }catch{return null;}
}

// Cùng một SELECT binding đã có. Khi bật log, chỉ chiếu UUID/no của lượt gắn
// với sequence job đã commit; không lấy lượt mới nhất sau Reset hoặc trả nháp.
export async function readDocsBinding(pool,schema,job,journal){
 if(!['reading_practice','listening_practice'].includes(schema))throw Error('DOCS_SCHEMA_INVALID');
 const observe=Boolean(journal)&&job.kind==='status';
 const projection=observe?`,(SELECT jsonb_agg(jsonb_build_object('id',a->>'id','no',(a->>'no')::int))
  FROM ${schema}.work w,jsonb_array_elements(w.state->'events') e,jsonb_array_elements(w.state->'attempts') a
  WHERE w.binding_id=b.id AND e->>'sequence'=$2 AND a->>'no'=e->>'attempt') AS journal_attempts`:'';
 return(await pool.query(`SELECT b.*,a.class_id,a.class_code,c.code${projection} FROM ${schema}.binding b
  JOIN ${schema}.assignment a ON a.id=b.assignment_id JOIN ${schema}.content c ON c.id=a.content_id WHERE b.id=$1`,
 [job.binding_id,...(observe?[String(job.sequence)]:[])])).rows[0];
}
export function createDocsObserver({journal,job,binding:b,clock=Date.now}){
 if(!journal)return{emit(){},target(){},read:(docs,id)=>docs.read(id),write:(docs,id,plan)=>docs.write(id,plan),failure(){}};
 const started=clock();let targetHash,reads=0,writes=0,received=0,requestCount=0,range;
 let a=job.kind==='cta'?{id:b?.id,no:0}:b?.journal_attempts?.length===1?b.journal_attempts[0]:null;
 if(!uuid.test(a?.id||'')||!Number.isSafeInteger(a.no)||a.no<0
  ||job.kind==='status'&&(job.payload.attemptId&&job.payload.attemptId!==a.id||job.payload.attemptNo!==undefined&&job.payload.attemptNo!==a.no))a=null;
 const emit=(phase,extra={})=>{
  if(!journal)return;
  try{publishDocsProgress(journal,{scope:a?scope(b,a):undefined,operationId:job.id,data:{...fields(job),phase,
   queueAgeMs:count(clock()-new Date(job.created_at).getTime()),durationMs:count(clock()-started),
   readCalls:count(reads,100),writeCalls:count(writes,100),writeRequestCount:count(requestCount,1000),
   ...(targetHash?{targetHash}:{}),...(range||{}),...extra}},clock);}catch{}
 };
 return{
  emit,
  target(binding){try{targetHash=digest([binding.document_id,binding.tab_id]);emit('target_resolved');}catch{}},
  read(docs,id){reads++;return docs.read(id);},
  async write(docs,id,plan){
   writes++;requestCount+=(plan.requests||[]).length;
   const positions=(plan.requests||[]).flatMap(r=>[r.deleteContentRange?.range,r.updateTextStyle?.range,r.insertText?.location])
    .filter(Boolean).flatMap(r=>[r.startIndex??r.index,r.endIndex??r.index]).filter(Number.isSafeInteger);
   if(positions.length)range={rangeStart:count(Math.min(...positions)),rangeEnd:count(Math.max(...positions))};
   emit('write_attempt');const result=await docs.write(id,plan);received++;emit('write_received');return result;
  },
  failure(code,blocked,delay,updated){
   const errorCode=/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'DOC_RETRY';
   if(!updated){emit('outcome_unknown',{errorCode:'DOC_LEASE_LOST'});return;}
   if(writes>received&&!/^DOC_HTTP_4\d\d$/.test(code))emit('outcome_unknown',{errorCode});
   emit(blocked?'blocked':'retry',{errorCode,retryDelaySeconds:delay});
  },
 };
}
