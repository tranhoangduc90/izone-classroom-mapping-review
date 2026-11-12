"""Overlay Term 2 and Mini K56 on the exact shared runtime for isolated verification."""
from pathlib import Path
import hashlib
import sys
import shutil

MODULE = 'k56-offline-core.mjs'
EXPECTED = '2a9bd27a250896cdaca8ecd8fea87e52c2958876298a0246a07c4c90cc149770'
HERE = Path(__file__).resolve().parent


def stage(source):
    def replace(before, after):
        nonlocal source
        before, after = before.replace('§', chr(96)), after.replace('§', chr(96)).replace('¤', '$')
        if source.count(before) != 1:
            raise ValueError(f'Unexpected K56 shared runtime anchor: {before}')
        source = source.replace(before, after)

    replace("import {queueK56Grades} from './k56-ordered-grade-sync.js';",
            """import {queueK56Grades} from './k56-ordered-grade-sync.js';
import {createSubmissionRecovery} from './k56-submission-recovery.mjs';""")
    replace(" const onlyThis=(req,res,next)=>", """ const recovery=createSubmissionRecovery({
  profile,record,fail,transaction,admitted,previousReceipt,validateSeal,pool
 });
 const onlyThis=(req,res,next)=>""")
    replace("""  record('offline_request_failed',SLUG,req.body?.attemptToken,{section:req.body?.section,operationId:req.body?.operationId,errorCode:e.code||'OFFLINE_INTERNAL_ERROR',phase:'api',durationMs:performance.now()-began});
  if(!e.status)return next(e);res.status(e.status).json({ok:false,error:e.code,message:e.message});}};""",
            """  recovery.note('offline_request_failed',SLUG,req.body?.attemptToken,{
   ...recovery.meta(req,req.body),errorCode:e.status?e.code:'OFFLINE_INTERNAL_ERROR',phase:'api',durationMs:performance.now()-began
  });
  if(!e.status)return next(e);
  res.status(e.status).json({ok:false,error:e.code,message:e.message,...(e.held?{held:e.held}:{})});}};""")
    replace("""    row=(await client.query(tables('INSERT INTO assessment.term2_offline_run(attempt_id,session_id,generation,owner_id,policy) VALUES($1,$2,$3,$4,$5) RETURNING *'),[a.attempt_token,a.exam_session_token,body.generation,body.ownerId,POLICY])).rows[0];""",
            """    const limits=recovery.enrollment(current,body.classCode);
    row=(await client.query(tables(§INSERT INTO assessment.term2_offline_run
      (attempt_id,session_id,generation,owner_id,policy¤{limits.length?',submission_hold_hours,submission_hold_limit':''})
      VALUES($1,$2,$3,$4,$5¤{limits.length?',$6,$7':''}) RETURNING *§),
      [a.attempt_token,a.exam_session_token,body.generation,body.ownerId,POLICY,...limits])).rows[0];""")
    replace("preparedAt:run.prepared_at,sendWindowHours:24},",
            """preparedAt:run.prepared_at,sendWindowHours:24,...(recovery.enabled(run)?{submissionRecoveryVersion:1,submissionHoldOnly:true}:{})},""")
    replace("""  const result=await transaction(async client=>{await admitted(client,b,req.get('x-term2-permit'));
   return (await client.query(tables('SELECT receipt FROM assessment.term2_offline_operation WHERE operation_id=$1 AND attempt_id=$2'),[b.operationId,b.attemptToken])).rows[0]?.receipt;});
  res.json({ok:true,persisted:Boolean(result),receipt:result||null});""",
            """  const result=await transaction(async client=>{
   const {a,run}=await admitted(client,b,req.get('x-term2-permit'));
   const receipt=(await client.query(tables('SELECT receipt FROM assessment.term2_offline_operation WHERE operation_id=$1 AND attempt_id=$2'),[b.operationId,a.attempt_token])).rows[0]?.receipt;
   return {receipt,held:await recovery.read(client,req,a,run,b,receipt)};
  });
  res.json({ok:true,persisted:Boolean(result.receipt),receipt:result.receipt||null,...(result.held?{held:result.held}:{})});""")
    before_content = """   if(b.section==='writing'&&typeof p[profile.taskId]!=='string')throw fail('OFFLINE_WRITING_REQUIRED','Chưa có trường bài Writing đúng Task; không coi là bài trắng.',400);
   if(!interruption&&b.section!=='writing'&&!p.answers)throw fail('OFFLINE_ANSWERS_REQUIRED','Chưa có đáp án của bản gửi.',400);
   if(!interruption&&profile.taskNumber===2&&b.section!=='writing'){
    const definition=parseStoredTest(a)[b.section+'_definition'],keys=new Set(definition.questions.flatMap(q=>q.compound?q.compound.keys:[String(q.number)]));
    if(Object.keys(p.answers).some(k=>!keys.has(k)))throw fail('OFFLINE_ANSWER_KEYS','Có ô không thuộc định nghĩa đã ghim; giữ bài để đối soát.',400);
   }"""
    replace(before_content, "   if(!interruption)validateContent(a,b);")
    replace(""" router.post('/:testSlug/offline/operation',onlyThis,draftLimiter,route(async(req,res)=>{
  const b=parse(operation,req.body),hash=digest(b);
  const out=await transaction(async client=>{
   let {a,run}=await admitted(client,b,req.get('x-term2-permit'));
   const previous=(await client.query(tables('SELECT * FROM assessment.term2_offline_operation WHERE operation_id=$1'),[b.operationId])).rows[0];
   if(previous){if(previous.attempt_id!==b.attemptToken||previous.payload_hash!==hash)throw fail('OPERATION_CONFLICT','Mã gửi đã có nội dung khác. Bản trên máy được giữ.');return {receipt:previous.receipt,a};}""",
            """ function validateContent(a,b){
   const p=b.payload;
""" + before_content.replace('!interruption&&','') + """
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
   const recoveryEnabled=recovery.enabled(run);
   if(recoveryEnabled)await recovery.assertIdentity(client,a.attempt_token,b,hash);""")
    replace("""   await client.query(tables('INSERT INTO assessment.term2_offline_operation(operation_id,attempt_id,payload_hash,section,kind,payload,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)'),[b.operationId,b.attemptToken,hash,b.section,b.kind,JSON.stringify(b),JSON.stringify(receipt)]);
   return {receipt,a:await load(client,SLUG,a.attempt_token)};
  });
  record('offline_operation_committed',SLUG,b.attemptToken,{section:b.section,operationId:b.operationId,receiptId:out.receipt.receiptId,phase:'after_commit',revision:b.revision,accepted:out.receipt.status==='accepted',reason:out.receipt.reason});""",
            """   // An opted-in review keeps content only in the expiring store, even if that store is full.
   await client.query(tables('INSERT INTO assessment.term2_offline_operation(operation_id,attempt_id,payload_hash,section,kind,payload,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)'),[b.operationId,a.attempt_token,hash,b.section,b.kind,JSON.stringify(review&&recoveryEnabled?{}:b),JSON.stringify(receipt)]);
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
   ...(hold?{heldAtMs:hold.held.heldAt}:{}),replayed:out.replayed===true});""")
    replace("catch(e){record('offline_writing_start_failed',SLUG,b.attemptToken,{section:'writing',operationId:b.operationId,",
            "catch(e){recovery.note('offline_writing_start_failed',SLUG,b.attemptToken,{...trace,section:'writing',operationId:b.operationId,")
    replace("catch(e){record('offline_writing_start_failed',SLUG,row.attempt_id,", "catch(e){recovery.note('offline_writing_start_failed',SLUG,row.attempt_id,")
    replace("res.json({ok:true,persisted:true,receipt:out.receipt});",
            """res.json({ok:true,persisted:true,receipt:out.receipt,...(hold&&out.receipt.status==='review_required'?{held:hold.held}:{})});""")
    replace("  try{const rows=(await pool.query", "  try{await recovery.expire();const rows=(await pool.query")
    return source


if __name__ == '__main__':
    baseline, candidate = map(lambda arg: Path(arg).resolve(), sys.argv[1:])
    raw = (baseline / 'src' / MODULE).read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED:
        raise ValueError('Shared K56 baseline differs from the observed runtime')
    if candidate.exists():
        raise ValueError('Candidate destination already exists')
    patched = stage(raw.decode('utf8'))
    shutil.copytree(baseline / 'src', candidate / 'src')
    shutil.copytree(baseline / 'term1-offline-20261107', candidate / 'term1-offline-20261107')
    for name in ('term1-submission-hold.mjs', 'k56-submission-recovery.mjs'):
        shutil.copy2(HERE / name, candidate / 'src')
    (candidate / 'src' / MODULE).write_text(patched, encoding='utf8', newline='\n')
    print(hashlib.sha256(patched.encode('utf8')).hexdigest())
