"""Build the Term 1 K56 candidate from the observed runtime, without deploying it."""
from pathlib import Path
import argparse
import hashlib
import shutil

EXPECTED = '861110b7f26570fb37d678ad498b7a923f3b572c0dc6e67d594e6d6b1de57209'
MODULE = 'term1-skill-offline-core.mjs'


def stage(original):
    def replace(before, after):
        nonlocal original
        before, after = before.replace('§', chr(96)), after.replace('§', chr(96)).replace('¤', '$')
        if original.count(before) != 1:
            raise ValueError(f'Unexpected Term 1 runtime anchor: {before}')
        original = original.replace(before, after)

    replace("import {queueK56Grades} from './k56-ordered-grade-sync.js';", """import {queueK56Grades} from './k56-ordered-grade-sync.js';
import {term1HoldPolicy, term1HoldEnabled, readTerm1Hold, holdTerm1Seal,
  assertTerm1HoldIdentity, clearTerm1Hold, expireTerm1Holds} from './term1-submission-hold.mjs';""")
    replace(" const onlyThis=(req,res,next)=>", """ const holdPolicy=term1HoldPolicy();
 let cleanHolds=profile.tablePrefix==='term1'&&holdPolicy.configured;
 const isHoldRun=run=>profile.tablePrefix==='term1'&&term1HoldEnabled(run);
 const note=(...args)=>{try{Promise.resolve(record?.(...args)).catch(()=>{});}catch{}};
 const requestId=req=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.get('x-exam-journal-request-id')||'')
  ? req.get('x-exam-journal-request-id').toLowerCase() : undefined;
 function validateContent(a,b){
  const p=b.payload;
  if(b.section==='writing'){
   if(typeof p[profile.taskId]!=='string')throw fail('OFFLINE_WRITING_REQUIRED','Chưa có trường bài Writing đúng Task; không coi là bài trắng.',400);
   return;
  }
  if(!p.answers)throw fail('OFFLINE_ANSWERS_REQUIRED','Chưa có đáp án của bản gửi.',400);
  if(profile.taskNumber===2){
   const definition=parseStoredTest(a)[b.section+'_definition'],keys=new Set(definition.questions.flatMap(q=>q.compound?q.compound.keys:[String(q.number)]));
   if(Object.keys(p.answers).some(k=>!keys.has(k)))throw fail('OFFLINE_ANSWER_KEYS','Có ô không thuộc định nghĩa đã ghim; giữ bài để đối soát.',400);
  }
 }
 const onlyThis=(req,res,next)=>""")
    replace("""  record('offline_request_failed',SLUG,req.body?.attemptToken,{section:req.body?.section,operationId:req.body?.operationId,errorCode:e.code||'OFFLINE_INTERNAL_ERROR',phase:'api',durationMs:performance.now()-began});
  if(!e.status)return next(e);res.status(e.status).json({ok:false,error:e.code,message:e.message});}};""",
"""  note('offline_request_failed',SLUG,req.body?.attemptToken,{section:req.body?.section,operationId:req.body?.operationId,
   requestId:requestId(req),errorCode:e.status?e.code:'OFFLINE_INTERNAL_ERROR',phase:'api',durationMs:performance.now()-began});
  if(!e.status)return next(e);
  res.status(e.status).json({ok:false,error:e.code,message:e.message,...(e.held?{held:e.held}:{})});}};""")
    replace("""  return {a,run,grant};
 }
 router.post('/:testSlug/offline/prepare'""", """  if(isHoldRun(run))cleanHolds=true;
  return {a,run,grant};
 }
 router.post('/:testSlug/offline/prepare'""")
    replace("""    row=(await client.query(tables('INSERT INTO assessment.term2_offline_run(attempt_id,session_id,generation,owner_id,policy) VALUES($1,$2,$3,$4,$5) RETURNING *'),[a.attempt_token,a.exam_session_token,body.generation,body.ownerId,POLICY])).rows[0];""",
"""    const enroll=profile.tablePrefix==='term1'&&holdPolicy.admits(current.class_name_snapshot||body.classCode);
    row=(await client.query(tables(§INSERT INTO assessment.term2_offline_run
     (attempt_id,session_id,generation,owner_id,policy¤{enroll?',submission_hold_hours,submission_hold_limit':''})
     VALUES($1,$2,$3,$4,$5¤{enroll?',$6,$7':''}) RETURNING *§),
     [a.attempt_token,a.exam_session_token,body.generation,body.ownerId,POLICY,...(enroll?[holdPolicy.hours,holdPolicy.limit]:[])])).rows[0];""")
    replace("preparedAt:run.prepared_at,sendWindowHours:24},",
"""preparedAt:run.prepared_at,sendWindowHours:24,...(isHoldRun(run)?{submissionRecoveryVersion:1}:{})},""")
    replace("""  const result=await transaction(async client=>{const {a,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));
   return (await client.query(tables(§SELECT receipt FROM assessment.term2_offline_operation
     WHERE operation_id=$1 AND attempt_id=$2 AND ($3::text IS NULL OR section=$3)
       AND receipt->>'attemptToken'=$4§),[b.operationId,a.attempt_token,grant?.section??null,b.attemptToken])).rows[0]?.receipt;});
  res.json({ok:true,persisted:Boolean(result),receipt:result||null});""",
"""  const result=await transaction(async client=>{const {a,run,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));
   const receipt=(await client.query(tables(§SELECT receipt FROM assessment.term2_offline_operation
     WHERE operation_id=$1 AND attempt_id=$2 AND ($3::text IS NULL OR section=$3)
       AND receipt->>'attemptToken'=$4§),[b.operationId,a.attempt_token,grant?.section??null,b.attemptToken])).rows[0]?.receipt;
   if(receipt||grant||!isHoldRun(run))return {receipt};
   const pending=await readTerm1Hold(client,a.attempt_token,b);
   if(pending)await rejectMainSkillIfBound(client,a,pending.section);
   return {receipt,held:pending?.held};
  });
  res.json({ok:true,persisted:Boolean(result.receipt),receipt:result.receipt||null,...(result.held?{held:result.held}:{})});""")
    replace("""   return {receipt,held:pending?.held};
  });
  res.json({ok:true,persisted:Boolean(result.receipt),receipt:result.receipt||null,...(result.held?{held:result.held}:{})});""",
"""   return {receipt,held:pending?.held,section:pending?.section};
  });
  if(result.held)note('offline_submission_hold_read',SLUG,b.attemptToken,{
   operationId:b.operationId,requestId:requestId(req),section:result.section,generation:b.generation,phase:'readback',
   heldAtMs:result.held.heldAt,expiresAtMs:result.held.expiresAt
  });
  res.json({ok:true,persisted:Boolean(result.receipt),receipt:result.receipt||null,...(result.held?{held:result.held}:{})});""")
    replace("""  const b=parse(operation,req.body),hash=digest(b);
  const out=await transaction(async client=>{
   let {a,run,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));
   const previous=(await client.query(tables('SELECT * FROM assessment.term2_offline_operation WHERE operation_id=$1'),[b.operationId])).rows[0];
   if(previous){if(previous.attempt_id!==a.attempt_token||(grant&&previous.section!==grant.section)||previous.payload_hash!==hash)throw fail('OPERATION_CONFLICT','Mã gửi đã có nội dung khác. Bản trên máy được giữ.');return {receipt:previous.receipt,a};}""",
"""  const b=parse(operation,req.body),hash=digest(b);
  const baseMeta={section:b.section,operationId:b.operationId,requestId:requestId(req),revision:b.revision};
  const previousReceipt=async (client,a,grant)=>{
   const previous=(await client.query(tables('SELECT attempt_id,section,payload_hash,receipt FROM assessment.term2_offline_operation WHERE operation_id=$1'),[b.operationId])).rows[0];
   if(previous&&(previous.attempt_id!==a.attempt_token||(grant&&previous.section!==grant.section)
     ||previous.payload_hash!==hash))throw fail('OPERATION_CONFLICT','Mã gửi đã có nội dung khác. Bản trên máy được giữ.');
   return previous?.receipt;
  };
  let hold, observation;
  // Retention ends its transaction before the operation can be rejected by a business guard.
  if(profile.tablePrefix==='term1'&&b.kind==='seal'&&req.get('x-term1-skill-grant')===undefined){
   try{
    hold=await transaction(async client=>{
     const {a,run}=await admitted(client,b,req.get('x-term2-permit'));
     if(!isHoldRun(run)||await previousReceipt(client,a,null))return;
     await rejectMainSkillIfBound(client,a,b.section);
     if(b.payload.interruptionReason!==undefined)throw fail('OFFLINE_INVALID','Trạng thái gián đoạn không khớp kỹ năng.',400);
     validateContent(a,b);
     if(b.section==='writing'?b.payload.answers!==undefined:b.payload[profile.taskId]!==undefined){
      throw fail('OFFLINE_INVALID','Nội dung không khớp kỹ năng của bản gửi.',400);
     }
     observation={generation:b.generation,definitionVersion:Number(a.definition_version),policyVersion:POLICY,
      previousOperationId:b.dependency,startedAtMs:Date.parse(b.payload.startedAt),capturedAtMs:Date.parse(b.occurredAt),
      ...(b.payload.deadlineAt?{deadlineAtMs:Date.parse(b.payload.deadlineAt)}:{}),
      serverAtMs:Date.parse(a.server_now),automatic:b.payload.reason!=='manual',
      ...(b.section==='writing'?{task2Length:b.payload[profile.taskId].length}
        :{answeredCount:Object.values(b.payload.answers).filter(Boolean).length})};
     return holdTerm1Seal(client,a.attempt_token,b,hash,run);
    });
   }catch(error){
    if(error.status)throw error;
    note('offline_hold_unconfirmed',SLUG,b.attemptToken,{...baseMeta,phase:'hold',reason:'HOLD_TRANSACTION_UNCONFIRMED'});
    throw fail('OFFLINE_HOLD_UNAVAILABLE','Chưa lưu được bản đối soát. Hãy giữ bản trên thiết bị.',503);
   }
  }
  if(hold)note('offline_submission_held',SLUG,b.attemptToken,{...baseMeta,phase:'hold',...observation,
   heldAtMs:hold.held.heldAt,expiresAtMs:hold.held.expiresAt,replayed:hold.replayed});
  let out;
  try{
   out=await transaction(async client=>{
   let {a,run,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));
   const previous=await previousReceipt(client,a,grant);
   if(previous)return {receipt:previous,a,replayed:true};
   if(isHoldRun(run))await assertTerm1HoldIdentity(client,a.attempt_token,b,hash);""")
    replace("""   if(b.section==='writing'&&typeof p[profile.taskId]!=='string')throw fail('OFFLINE_WRITING_REQUIRED','Chưa có trường bài Writing đúng Task; không coi là bài trắng.',400);
   if(!interruption&&b.section!=='writing'&&!p.answers)throw fail('OFFLINE_ANSWERS_REQUIRED','Chưa có đáp án của bản gửi.',400);
   if(!interruption&&profile.taskNumber===2&&b.section!=='writing'){
    const definition=parseStoredTest(a)[b.section+'_definition'],keys=new Set(definition.questions.flatMap(q=>q.compound?q.compound.keys:[String(q.number)]));
    if(Object.keys(p.answers).some(k=>!keys.has(k)))throw fail('OFFLINE_ANSWER_KEYS','Có ô không thuộc định nghĩa đã ghim; giữ bài để đối soát.',400);
   }""", """   if(!interruption)validateContent(a,b);""")
    replace("""   return {receipt,a:await load(client,SLUG,a.attempt_token)};
  });
  record('offline_operation_committed',SLUG,out.a.attempt_token,{section:b.section,operationId:b.operationId,receiptId:out.receipt.receiptId,phase:'after_commit',revision:b.revision,accepted:out.receipt.status==='accepted',reason:out.receipt.reason});""",
"""   if(hold)await clearTerm1Hold(client,a.attempt_token,b);
   return {receipt,a:await load(client,SLUG,a.attempt_token),replayed:false};
   });
  }catch(error){
   if(hold&&![401,403,404].includes(error.status)&&error.code!=='TERM1_SKILL_OWNED_BY_FALLBACK'){
    if(!error.status){
     note('offline_submission_unconfirmed',SLUG,b.attemptToken,{...baseMeta,phase:'commit',reason:'SUBMISSION_TRANSACTION_UNCONFIRMED'});
     error=fail('OFFLINE_SUBMISSION_UNAVAILABLE','Chưa xác nhận được bài nộp. Hãy giữ bản trên thiết bị để tra lại.',503);
    }
    error.held=hold.held;
   }
   throw error;
  }
  note('offline_operation_committed',SLUG,out.a.attempt_token,{...baseMeta,receiptId:out.receipt.receiptId,
   phase:'after_commit',accepted:out.receipt.status==='accepted',reason:out.receipt.reason,...observation,
   ...(hold?{heldAtMs:hold.held.heldAt}:{}),replayed:out.replayed});""")
    replace("catch(e){record('offline_writing_start_failed',SLUG,b.attemptToken,", "catch(e){note('offline_writing_start_failed',SLUG,b.attemptToken,")
    replace("catch(e){record('offline_writing_start_failed',SLUG,row.attempt_id,", "catch(e){note('offline_writing_start_failed',SLUG,row.attempt_id,")
    replace("""  try{const rows=(await pool.query""", """  try{
   if(cleanHolds)await expireTerm1Holds(pool).catch(()=>{});
   const rows=(await pool.query""")
    return original



def stage_journal(source):
    old = """    if(testSlug==='term-test-2-k56'||testSlug==='term-test-1-k56'){
      const diagnostics={};for(const key of ['operationId','receiptId','errorCode','phase','durationMs'])if(details[key]!==undefined)diagnostics[key]=details[key];
      if(Object.keys(diagnostics).length)data.checkpointState={...(testSlug==='term-test-2-k56'?{term2OfflineVersion:1}:{term1OfflineVersion:1}),...diagnostics};
    }"""
    if source.count(old) != 1:
        raise ValueError('Unexpected mounted K56 Journal adapter')
    return "import { k56OfflineObservation } from './term-k56-offline.mjs';" + chr(10) + source.replace(
        old, "    const k56Offline = k56OfflineObservation(event, testSlug, details);" + chr(10)
        + "    if (k56Offline) data.checkpointState = k56Offline;")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('--journal-source', required=True, type=Path,
                        help='Directory containing the versioned Exam Journal source.')
    args = parser.parse_args()
    baseline, candidate = args.baseline.resolve(), args.candidate.resolve()
    if candidate.exists():
        raise ValueError('Candidate destination already exists')
    original = (baseline / 'src' / MODULE).read_bytes()
    if hashlib.sha256(original).hexdigest() != EXPECTED:
        raise ValueError('Term 1 baseline hash does not match the observed runtime')
    candidate_source = stage(original.decode('utf8'))
    journal = Path('src/exam-journal-runtime/adapters')
    adapter_source = stage_journal((baseline / journal / 'term.mjs').read_text(encoding='utf8'))
    journal_module = args.journal_source / 'adapters' / 'term-k56-offline.mjs'
    if not journal_module.is_file():
        raise ValueError('K56 evidence module is missing from the Journal source')
    shutil.copytree(baseline / 'src', candidate / 'src')
    (candidate / journal / 'term.mjs').write_text(adapter_source, encoding='utf8', newline=chr(10))
    shutil.copy2(journal_module, candidate / journal)
    (candidate / 'src' / MODULE).write_text(candidate_source, encoding='utf8', newline='\n')
    shutil.copy2(Path(__file__).with_name('term1-submission-hold.mjs'), candidate / 'src')
    print(hashlib.sha256((candidate / 'src' / MODULE).read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
