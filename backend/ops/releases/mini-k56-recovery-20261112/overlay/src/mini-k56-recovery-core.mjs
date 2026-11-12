import {createHmac, timingSafeEqual, createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {isBlank} from './term1-blank.mjs';
import {issueK56TermAudio} from './k56-term-audio-r2.mjs';
import {gradeSection, parseStoredTest, buildCombinedResult, buildListeningResult} from './term-tests.js';
import {buildErpGradePayload} from './erp-sync.js';
import {queueK56Grades} from './k56-ordered-grade-sync.js';
import {createSubmissionRecovery} from './k56-submission-recovery.mjs';

// Profile đóng; tên bảng không được lấy từ request. Mặc định Term 2 giữ wire/storage v1.
export function createK56Offline(profile){
const slugByPrefix={term1:'term-test-1-k56',term2:'term-test-2-k56',mini_k56:'mini-test-k56'};
if(!Object.hasOwn(slugByPrefix,profile.tablePrefix)||profile.slug!==slugByPrefix[profile.tablePrefix])throw Error('Unknown offline profile');
const mini=profile.tablePrefix==='mini_k56';
const tables=sql=>sql.replaceAll('term2_offline_',profile.tablePrefix+'_offline_');
// Quyền offline và biên nhận riêng Term 2 K56. Nhận operation đã lưu ở máy,
// commit bài/receipt/outbox cùng giao dịch; không gọi mạng hoặc AI trong giao dịch.

const SLUG=profile.slug;
const POLICY=profile.policy;
const schema=tables(`
CREATE TABLE IF NOT EXISTS assessment.term2_offline_run (
 attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id),
 session_id uuid NOT NULL, generation bigint NOT NULL, owner_id uuid NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(), policy text NOT NULL,
 state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS assessment.term2_offline_operation (
 operation_id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment.term2_offline_run(attempt_id),
 payload_hash text NOT NULL, section text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, receipt jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS term2_offline_operations_attempt ON assessment.term2_offline_operation(attempt_id,committed_at);
CREATE INDEX IF NOT EXISTS term2_offline_writing_pending ON assessment.term2_offline_operation(attempt_id)
 WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';
`);
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
function canonical(value){return JSON.stringify(value&&typeof value==='object'?(Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))]))):value);}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const answers=z.record(z.string().regex(profile.taskNumber===2?/^(?:[1-9]|[1-3][0-9]|40|32a|32b)$/:/^(?:[1-9]|[1-3][0-9]|40)$/),z.string().max(120));
const scope=z.object({attemptToken:z.string().uuid(),examSessionToken:z.string().uuid(),generation:z.number().int().nonnegative(),ownerId:z.string().uuid()});
const operation=scope.extend({operationId:z.string().uuid(),section:z.enum(['listening','reading','writing']),kind:z.enum(['start','draft','seal','interrupt']),revision:z.number().int().nonnegative(),
 occurredAt:z.string().datetime(),dependency:z.string().uuid().nullable(),payload:z.object({answers:answers.optional(),[profile.taskId]:z.string().max(120000).optional(),
 startedAt:z.string().datetime(),deadlineAt:z.string().datetime().nullable(),reason:z.enum(['manual','deadline','ended']).optional(),
 interruptionReason:z.enum(['learner_cannot_hear','page_interrupted']).optional(),
 audioEnded:z.boolean().optional(),heardSeconds:z.number().min(0).max(14400).optional(),timeValid:z.boolean()}).strict()}).strict();
const parse=(s,v)=>{const r=s.safeParse(v);if(!r.success)throw fail('OFFLINE_INVALID','Dữ liệu chưa hợp lệ; bản bài làm vẫn được giữ.',400);return r.data;};
function permitFor(secret,run){return createHmac('sha256',secret).update([POLICY,run.attempt_id,run.session_id,run.generation,run.owner_id,new Date(run.prepared_at).toISOString()].join(':')).digest('hex');}
function equal(a,b){return typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function validateTimeline(op,run,a,timing){
 const p=op.payload,start=Date.parse(p.startedAt),at=Date.parse(op.occurredAt),now=Date.parse(a.server_now);
 if(!p.timeValid||start<Date.parse(run.prepared_at)-2000||start>now+2000||at<start-100||at>now+2000)return 'TIME_REVIEW_REQUIRED';
 if(mini&&a.attempt_mode==='answer_sheet'&&(p.deadlineAt!==null||(op.kind==='seal'&&p.reason!=='manual')))return 'PAPER_MANUAL_ONLY';
 const seconds=mini&&a.attempt_mode==='answer_sheet'?null:op.section==='reading'?timing.readingDurationMinutes*60:op.section==='writing'?timing.writingDurationMinutes*60:null;
 const deadline=seconds===null?at: start+seconds*1000;
 if(seconds!==null&&Date.parse(p.deadlineAt)!==deadline)return 'TIME_REVIEW_REQUIRED';
 if(op.kind!=='start'&&seconds!==null&&at>deadline+2000)return 'TIME_REVIEW_REQUIRED';
 if(now>deadline+86400000)return 'OFFLINE_WINDOW_REVIEW_REQUIRED';
 if(op.section==='listening'&&op.kind==='seal'&&p.reason!=='manual'
   &&(!p.audioEnded||p.heardSeconds<timing.listeningDurationSeconds-2))return 'AUDIO_NOT_FINISHED';
 return null;
}

function registerOffline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter=limiter,draftLimiter=limiter,record,onWriting,allowNew=()=>profile.tablePrefix==='term1'?process.env[profile.flag]==='true':process.env[profile.flag]!=='false'}){
 const recovery=createSubmissionRecovery({
  profile,record,fail,transaction,admitted,previousReceipt,validateSeal,pool
 });
 const onlyThis=(req,res,next)=>req.params.testSlug===SLUG?next():next('route');
 const route=handler=>async(req,res,next)=>{if(req.params.testSlug!==SLUG)return next();const began=performance.now();try{res.set('Cache-Control','no-store');await handler(req,res);}catch(e){
  recovery.note('offline_request_failed',SLUG,req.body?.attemptToken,{
   ...recovery.meta(req,req.body),errorCode:e.status?e.code:'OFFLINE_INTERNAL_ERROR',phase:'api',durationMs:performance.now()-began
  });
  if(!e.status)return next(e);
  res.status(e.status).json({ok:false,error:e.code,message:e.message,...(e.held?{held:e.held}:{})});}};
 async function admitted(client,body,token){
  const a=await load(client,SLUG,body.attemptToken,false,true);
  const run=(await client.query(tables('SELECT * FROM assessment.term2_offline_run WHERE attempt_id=$1 FOR UPDATE'),[body.attemptToken])).rows[0];
  if(a.test_slug!==SLUG||!run||run.policy!==POLICY||run.owner_id!==body.ownerId||run.session_id!==body.examSessionToken||Number(run.generation)!==body.generation
    ||Number(a.generation)!==body.generation||(a.session_generation!==undefined&&Number(a.session_generation)!==body.generation)||a.exam_session_token!==body.examSessionToken||!(a.attempt_mode==='cbt'||(mini&&a.attempt_mode==='answer_sheet'))
    ||(mini&&a.session_attempt_mode&&a.session_attempt_mode!==a.attempt_mode)
    ||!equal(token,permitFor(secret,run)))throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi hoặc quyền đã thay đổi. Giữ bài và liên hệ giảng viên.',403);
  return {a,run};
 }
 router.post('/:testSlug/offline/prepare',onlyThis,limiter,route(async(req,res)=>{
  if(!secret||secret.length<32)throw fail('OFFLINE_UNAVAILABLE','Chưa chuẩn bị được quyền offline.',503);
  const body=parse(scope.extend({classCode:z.string().min(2).max(32),studentRef:z.string().uuid(),mode:z.enum(['lis_first','read_first']),audioTransport:z.literal('r2-direct-v1').optional(),...(mini?{attemptMode:z.enum(['cbt','answer_sheet']).default('cbt'),identityConfirmed:z.literal(true).optional()}:{})}),req.body);
  const attemptMode=mini?body.attemptMode:'cbt';
  const paper=attemptMode==='answer_sheet';
  const a=await prepare(SLUG,{...body,attemptMode},false);
  if(!a||a.attempt_token!==body.attemptToken||a.exam_session_token!==body.examSessionToken||Number(a.generation)!==body.generation)throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi chưa khớp.',403);
  const {run,audioDownload}=await transaction(async client=>{
   const current=await load(client,SLUG,a.attempt_token,false,true);
   let row=(await client.query(tables('SELECT * FROM assessment.term2_offline_run WHERE attempt_id=$1'),[a.attempt_token])).rows[0];
   if(!row){
    if(!allowNew(attemptMode,body.classCode))throw fail('OFFLINE_NEW_DISABLED','Lượt mới đang dùng chế độ tương thích.',503);
    if(current.listening_started_at||current.reading_started_at||current.writing_started_at)throw fail('OFFLINE_LEGACY','Lượt đang làm tiếp tục cơ chế cũ; nháp vẫn được giữ.');
    const limits=recovery.enrollment(current,body.classCode);
    row=(await client.query(tables(`INSERT INTO assessment.term2_offline_run
      (attempt_id,session_id,generation,owner_id,policy${limits.length?',submission_hold_hours,submission_hold_limit':''})
      VALUES($1,$2,$3,$4,$5${limits.length?',$6,$7':''}) RETURNING *`),
      [a.attempt_token,a.exam_session_token,body.generation,body.ownerId,POLICY,...limits])).rows[0];
   }
   if(row.owner_id!==body.ownerId)throw fail('OFFLINE_OWNER_CONFLICT','Lượt đã được chuẩn bị trên thiết bị khác. Giữ bài và liên hệ giảng viên.');
   if(mini&&(current.superseded_at||current.session_superseded_at||current.attempt_mode!==attemptMode||current.exam_mode!==body.mode||Number(current.generation)!==body.generation||Number(current.session_generation)!==body.generation))throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi chưa khớp.',403);
   if(row.session_id!==body.examSessionToken||Number(row.generation)!==body.generation||row.policy!==POLICY)throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi chưa khớp.',403);
   return {run:row,audioDownload:issueK56TermAudio(current,body.audioTransport)};
  });
  const content=a.mini_definition_snapshot?.content||await assets.getContent(SLUG),timing=a.mini_definition_snapshot?.timing||assets.getTiming(SLUG);
  res.json({...serialize(a),...(paper?{}:{content,timing}),...(audioDownload?{audioDownload}:{}),offline:{policy:POLICY,permit:permitFor(secret,run),ownerId:run.owner_id,preparedAt:run.prepared_at,sendWindowHours:24,...(recovery.enabled(run)?{submissionRecoveryVersion:1,submissionHoldOnly:true}:{})},
   ...(paper?{}:{audioKey:assets.getSessionAudioKey(SLUG,a.exam_session_token).toString('base64'),audioEnvelope:{magic:'IZTT1',ivBytes:12,tagBytes:16}})});
 }));
 router.post('/:testSlug/offline/status',onlyThis,readLimiter,route(async(req,res)=>{
  const b=parse(scope.extend({operationId:z.string().uuid()}),req.body);
  const result=await transaction(async client=>{
   const {a,run}=await admitted(client,b,req.get('x-term2-permit'));
   const receipt=(await client.query(tables('SELECT receipt FROM assessment.term2_offline_operation WHERE operation_id=$1 AND attempt_id=$2'),[b.operationId,a.attempt_token])).rows[0]?.receipt;
   return {receipt,held:await recovery.read(client,req,a,run,b,receipt)};
  });
  res.json({ok:true,persisted:Boolean(result.receipt),receipt:result.receipt||null,...(result.held?{held:result.held}:{})});
 }));
 function validateContent(a,b){
   const p=b.payload;
   if(b.section==='writing'&&typeof p[profile.taskId]!=='string')throw fail('OFFLINE_WRITING_REQUIRED','Chưa có trường bài Writing đúng Task; không coi là bài trắng.',400);
   if(b.section!=='writing'&&!p.answers)throw fail('OFFLINE_ANSWERS_REQUIRED','Chưa có đáp án của bản gửi.',400);
   if(profile.taskNumber===2&&b.section!=='writing'){
    const definition=parseStoredTest(a)[b.section+'_definition'],keys=new Set(definition.questions.flatMap(q=>q.compound?q.compound.keys:[String(q.number)]));
    if(Object.keys(p.answers).some(k=>!keys.has(k)))throw fail('OFFLINE_ANSWER_KEYS','Có ô không thuộc định nghĩa đã ghim; giữ bài để đối soát.',400);
   }
 }
 function validateSeal(a,b){
   validateContent(a,b);
   if(b.payload.interruptionReason!==undefined||(b.section==='writing'?b.payload.answers!==undefined:b.payload[profile.taskId]!==undefined))
    throw fail('OFFLINE_INVALID','Nội dung không khớp kỹ năng của bản gửi.',400);
   if(!mini&&b.section!=='writing'){
    const definition=parseStoredTest(a)[b.section+'_definition'],keys=new Set(definition.questions.map(q=>String(q.number)));
    if(Object.keys(b.payload.answers).some(key=>!keys.has(key)))
     throw fail('OFFLINE_ANSWER_KEYS','Có ô không thuộc định nghĩa đã ghim.',400);
   }
 }
 async function previousReceipt(client,a,b,hash){
   const previous=(await client.query(tables('SELECT attempt_id,payload_hash,receipt FROM assessment.term2_offline_operation WHERE operation_id=$1'),[b.operationId])).rows[0];
   if(previous&&(previous.attempt_id!==a.attempt_token||previous.payload_hash!==hash))
    throw fail('OPERATION_CONFLICT','Mã gửi đã có nội dung khác. Bản trên máy được giữ.');
   return previous?.receipt;
 }
 router.post('/:testSlug/offline/hold',onlyThis,draftLimiter,route(async(req,res)=>{
  const b=parse(operation,req.body),hold=await recovery.retain(req,b,digest(b),{required:true});
  res.json({ok:true,held:hold?.held||null,alreadyRecorded:!hold});
 }));
 router.post('/:testSlug/offline/operation',onlyThis,draftLimiter,route(async(req,res)=>{
  const b=parse(operation,req.body),hash=digest(b),trace=recovery.meta(req,b);
  const hold=await recovery.retain(req,b,hash);
  let out;
  try{
  out=await transaction(async client=>{
   let {a,run}=await admitted(client,b,req.get('x-term2-permit'));
   const previous=await previousReceipt(client,a,b,hash);
   if(previous)return {receipt:previous,a,replayed:true};
   if(recovery.enabled(run))await recovery.assertIdentity(client,a.attempt_token,b,hash);
   const state=run.state||{},order=a.exam_mode==='read_first'?['reading','listening','writing']:['listening','reading','writing'];
   if(mini&&a.attempt_mode==='answer_sheet'&&b.section==='writing')throw fail('MODE_CONFLICT','Phiếu giấy chỉ nhận Listening và Reading.',403);
   const index=order.indexOf(b.section),prior=index?state[order[index-1]]:null;
   if(index&&(!(prior?.sealed||prior?.interrupted)||prior.operationId!==b.dependency))throw fail('OFFLINE_DEPENDENCY','Kỹ năng trước chưa được xác nhận; bài đang chờ gửi.');
   const item=state[b.section]||{},p=b.payload,timing=a.mini_definition_snapshot?.timing||assets.getTiming(SLUG);
   if(mini&&(a.superseded_at||a.session_superseded_at||a[b.section+'_submitted_at']||(!item.startedAt&&a[b.section+'_started_at'])))throw fail('OFFLINE_NATIVE_CONFLICT','Lượt này đã thay đổi trên máy chủ; bản trên máy vẫn được giữ.',409);
   if(item.interrupted||item.sealed)throw fail('OFFLINE_SECTION_LOCKED','Kỹ năng đã khóa; bản khác được giữ để đối soát.');
   if(item.startedAt&&item.startedAt!==p.startedAt)throw fail('OFFLINE_TIME_CONFLICT','Không đặt lại thời gian của kỹ năng.');
   if(b.kind!=='start'&&!item.startedAt)throw fail('OFFLINE_START_REQUIRED','Chưa nhận mốc bắt đầu kỹ năng.');
   if(b.kind==='start'&&item.startedAt)throw fail('OFFLINE_START_CONFLICT','Kỹ năng đã bắt đầu; hãy đọc lại biên nhận.');
   if((item.revision??-1)>b.revision)throw fail('OFFLINE_REVISION_STALE','Bản gửi cũ hơn bản đã nhận.');
   const interruption=b.kind==='interrupt';
   if(interruption ? !['term-test-2-k56','mini-test-k56'].includes(SLUG)||a.attempt_mode!=='cbt'||b.section!=='listening'||!p.interruptionReason
      ||p.answers!==undefined||p[profile.taskId]!==undefined||p.reason!==undefined
      ||p.audioEnded!==undefined||p.heardSeconds!==undefined : p.interruptionReason!==undefined)
    throw fail('OFFLINE_INVALID','Trạng thái gián đoạn không khớp kỹ năng.',400);
   const contentHash=digest(b.section==='writing'?{[profile.taskId]:p[profile.taskId]??null}:{answers:p.answers??null});
   if(!interruption&&b.kind!=='start'&&item.revision===b.revision&&item.contentHash&&item.contentHash!==contentHash)throw fail('OFFLINE_REVISION_CONFLICT','Cùng revision có hai nội dung khác nhau; giữ bản trên máy để kiểm tra.');
   const review=validateTimeline(b,run,a,timing);
   if(!interruption)validateContent(a,b);
   const writingBlank=mini&&b.section==='writing'&&b.kind==='seal'&&isBlank(p[profile.taskId]);
   const receipt={...(writingBlank?{writingBlank:true}:{}),version:1,receiptId:randomUUID(),operationId:b.operationId,payloadHash:hash,attemptToken:b.attemptToken,examSessionToken:b.examSessionToken,generation:b.generation,section:b.section,kind:b.kind,acceptedRevision:b.revision,
    status:review?'review_required':'accepted',reason:review,serverCommittedAt:new Date(a.server_now).toISOString()};
   if(!review){
    const start=p.startedAt,deadline=p.deadlineAt;
    if(interruption)await client.query(`UPDATE assessment.term_test_attempt
     SET listening_interrupted_at=$2::timestamptz,updated_at=now() WHERE id=$1`,[a.attempt_token,b.occurredAt]);
    else if(b.section==='listening')await client.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=coalesce(listening_started_at,$2::timestamptz),listening_deadline_at=$3::timestamptz,
     listening_draft=$4::jsonb,listening_draft_revision=$5,listening_draft_updated_at=now(),updated_at=now() WHERE id=$1`,[a.exam_session_token,start,deadline,JSON.stringify(p.answers),b.revision]);
    else if(b.section==='reading')await client.query(`UPDATE assessment.term_test_attempt SET reading_started_at=coalesce(reading_started_at,$2::timestamptz),reading_deadline_at=$3::timestamptz,
     reading_draft=$4::jsonb,reading_draft_revision=$5,reading_draft_updated_at=now(),updated_at=now() WHERE id=$1`,[a.attempt_token,start,deadline,JSON.stringify(p.answers),b.revision]);
    else await client.query(`UPDATE assessment.term_test_attempt SET writing_started_at=coalesce(writing_started_at,$2::timestamptz),writing_deadline_at=$3::timestamptz,
     writing_task_${profile.taskNumber}=$4,writing_draft_revision=$5,writing_draft_updated_at=now(),writing_updated_at=now(),updated_at=now() WHERE id=$1`,[a.attempt_token,start,deadline,p[profile.taskId],b.revision]);
    if(b.kind==='seal'){
     if(b.section==='writing')await client.query('UPDATE assessment.term_test_attempt SET writing_submitted_at=$2::timestamptz,updated_at=now() WHERE id=$1',[a.attempt_token,b.occurredAt]);
     else{
      const def=parseStoredTest(a),score=gradeSection(def[b.section+'_definition'],p.answers,b.section==='listening'?def.listening_band_adjustment:0,def.scoreMode);
      await client.query(`UPDATE assessment.term_test_attempt SET ${b.section}_answers=$2::jsonb,${b.section}_result=$3::jsonb,${b.section}_submitted_at=$4::timestamptz,updated_at=now() WHERE id=$1`,[a.attempt_token,JSON.stringify(p.answers),JSON.stringify(score),b.occurredAt]);
      if(b.section==='listening')await client.query('UPDATE assessment.term_test_exam_session SET listening_submitted_at=$2::timestamptz,updated_at=now() WHERE id=$1',[a.exam_session_token,b.occurredAt]);
      a=await load(client,SLUG,a.attempt_token);
      await client.query('UPDATE assessment.term_test_attempt SET combined_result=$2::jsonb,completed_at=CASE WHEN $3 THEN coalesce(completed_at,now()) ELSE NULL END WHERE id=$1',[a.attempt_token,JSON.stringify(resultFor(a)),Boolean(a.listening_submitted_at&&a.reading_submitted_at)]);
      await queueK56Grades(client,buildErpGradePayload(a,{[b.section]:score}));
     }
    }
    state[b.section]={startedAt:start,deadlineAt:deadline,revision:b.revision,contentHash:b.kind==='start'?null:contentHash,sealed:b.kind==='seal',operationId:b.kind==='seal'||interruption?b.operationId:null,...(interruption?{interrupted:true}:{}),...(writingBlank?{blank:true}:{})};
    await client.query(tables('UPDATE assessment.term2_offline_run SET state=$2::jsonb WHERE attempt_id=$1'),[a.attempt_token,JSON.stringify(state)]);
   }
   // For opted-in reviews the expiring hold is the only new copy of the sealed content.
   await client.query(tables('INSERT INTO assessment.term2_offline_operation(operation_id,attempt_id,payload_hash,section,kind,payload,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)'),[b.operationId,a.attempt_token,hash,b.section,b.kind,JSON.stringify(review&&hold?{}:b),JSON.stringify(receipt)]);
   if(!review&&hold)await recovery.clear(client,a.attempt_token,b);
   return {receipt,a:await load(client,SLUG,a.attempt_token)};
  });
  }catch(error){
   if(hold&&![401,403,404].includes(error.status)){
    if(!error.status){
     recovery.note('offline_submission_unconfirmed',SLUG,b.attemptToken,{...trace,phase:'commit',reason:'SUBMISSION_TRANSACTION_UNCONFIRMED'});
     error=fail('OFFLINE_SUBMISSION_UNAVAILABLE','Chưa xác nhận được bài nộp. Hãy giữ bản trên thiết bị để tra lại.',503);
    }
    error.held=hold.held;
   }
   throw error;
  }
  recovery.note('offline_operation_committed',SLUG,b.attemptToken,{...trace,...hold?.observation,
   receiptId:out.receipt.receiptId,phase:'after_commit',accepted:out.receipt.status==='accepted',reason:out.receipt.reason,
   ...(hold?{heldAtMs:hold.held.heldAt}:{}),replayed:out.replayed===true});
  // Sau commit: thất bại khởi động chấm không mất bài; process-due/result sẽ quét lại.
  if(b.section==='writing'&&b.kind==='seal'&&out.receipt.status==='accepted'&&!out.receipt.writingBlank)try{await onWriting(out.a);}catch(e){recovery.note('offline_writing_start_failed',SLUG,b.attemptToken,{...trace,section:'writing',operationId:b.operationId,errorCode:e.code||'WRITING_START_UNAVAILABLE',phase:'after_commit'});}
  res.json({ok:true,persisted:true,receipt:out.receipt,...(hold&&out.receipt.status==='review_required'?{held:hold.held}:{})});
 }));
 // Operation đã commit là outbox bền. Quét bù sau crash trước bước tạo job chấm.
 let scanning=false;
 const timer=setInterval(async()=>{
  if(scanning)return;scanning=true;
  try{await recovery.expire();const rows=(await pool.query(tables(`SELECT DISTINCT o.attempt_id FROM assessment.term2_offline_operation o
    JOIN assessment.term_test_attempt a ON a.id=o.attempt_id
    WHERE o.section='writing' AND o.kind='seal' AND o.receipt->>'status'='accepted' AND a.superseded_at IS NULL
    ${mini?"AND o.receipt->>'writingBlank' IS DISTINCT FROM 'true'":''}
    AND NOT EXISTS(SELECT 1 FROM assessment.term_test_writing_grading_run r WHERE r.attempt_id=a.id) LIMIT 4`))).rows;
   for(const row of rows)try{await onWriting(await load(pool,SLUG,row.attempt_id));}catch(e){recovery.note('offline_writing_start_failed',SLUG,row.attempt_id,{section:'writing',errorCode:e.code||'WRITING_START_UNAVAILABLE',phase:'worker_retry'});}
  }catch{}finally{scanning=false;}
 },15000);timer.unref?.();
 return ()=>clearInterval(timer);
}

return {SLUG,POLICY,schema,canonical,digest,permitFor,validateTimeline,registerOffline};
}
