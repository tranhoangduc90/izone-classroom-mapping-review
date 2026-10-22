import {createHash} from 'node:crypto';

const slugs=new Set(['term-test-1','term-test-2','mini-test-lesson-5','term-test-1-k56','term-test-2-k56','mini-test-k56']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail=(code,status=409)=>Object.assign(new Error('Chưa xác nhận được bài đã lưu của đúng lượt. Bài trên máy vẫn được giữ.'),{code,status});
export const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b))));

// Chỉ SELECT phiên/lượt theo token hoặc mã gửi đã biết; không đọc roster, mở phiên, chấm hay ghi Portal.
export async function readSubmissionStatus(pool,slug,input,assertOwner=()=>{}){
  if(!slugs.has(slug)||!['listening','reading'].includes(input.section))throw fail('INVALID_SUBMISSION_STATUS',400);
  for(const key of ['examSessionToken','attemptToken','clientSubmissionId'])
    if(input[key]!==undefined&&!uuid(input[key]))throw fail('INVALID_SUBMISSION_STATUS',400);
  if(!input.examSessionToken&&!input.attemptToken&&!input.clientSubmissionId)throw fail('SUBMISSION_TOKEN_REQUIRED',400);
  if(input.generation!==undefined&&(!Number.isSafeInteger(input.generation)||input.generation<0))throw fail('INVALID_GENERATION',400);
  let query,args;
  if(input.examSessionToken){
    query=`SELECT to_jsonb(s) AS session,to_jsonb(a) AS attempt FROM assessment.term_test_exam_session s
      LEFT JOIN assessment.term_test_attempt a ON a.exam_session_id=s.id AND a.superseded_at IS NULL
      WHERE s.id=$1::uuid AND s.test_slug=$2 AND s.superseded_at IS NULL`;
    args=[input.examSessionToken,slug];
  }else{
    const field=input.attemptToken?'id':'client_submission_id';
    query=`SELECT to_jsonb(s) AS session,to_jsonb(a) AS attempt FROM assessment.term_test_attempt a
      LEFT JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
      WHERE a.${field}=$1::uuid AND a.test_slug=$2 AND a.superseded_at IS NULL`;
    args=[input.attemptToken||input.clientSubmissionId,slug];
  }
  const rows=(await pool.query(query,args)).rows;
  if(rows.length!==1)throw fail('SUBMISSION_NOT_FOUND',404);
  const {session:s,attempt:a}=rows[0];
  if(s?.superseded_at||a?.superseded_at)throw fail('STALE_ATTEMPT');
  // Quyền phát audio bảo vệ Listening; Reading giữ hợp đồng đọc theo token cả sau tải lại.
  if(s&&input.section==='listening')assertOwner(s,input);
  const generation=Number(a?.generation??s?.generation??0);
  if((input.generation!==undefined&&input.generation!==generation)||(a&&s&&Number(a.generation||0)!==Number(s.generation||0)))throw fail('STALE_GENERATION');
  if(input.attemptToken&&a?.id!==input.attemptToken)throw fail('TOKEN_MISMATCH');
  if(input.clientSubmissionId&&a?.listening_submitted_at&&a.client_submission_id!==input.clientSubmissionId)throw fail('SUBMISSION_ID_CONFLICT');
  const submittedAt=input.section==='listening'?(a?.listening_submitted_at||s?.listening_submitted_at):(a?.reading_submitted_at||a?.completed_at);
  if(!submittedAt)return{ok:true,persisted:false};
  if(!a)throw fail('SUBMISSION_LINK_INCOMPLETE');
  const answers=a[input.section+'_answers']||{};
  const listeningSubmitted=Boolean(a.listening_submitted_at),readingSubmitted=Boolean(a.reading_submitted_at||a.completed_at);
  const completed=Boolean(a.completed_at),examMode=a.exam_mode||s?.exam_mode||'lis_first';
  return{ok:true,persisted:true,receipt:{version:1,testSlug:slug,section:input.section,generation,
      attemptToken:a.id,examSessionToken:s?.id||null,clientSubmissionId:a.client_submission_id,
      submittedAt:new Date(submittedAt).toISOString(),answers,
      snapshotHash:createHash('sha256').update(canonical(answers)).digest('hex')},
    response:{ok:true,attemptToken:a.id,examSessionToken:s?.id||null,studentName:a.student_name_snapshot,
      generation,examMode,examDelivery:a.attempt_mode||s?.attempt_mode||'legacy',completed,listeningSubmitted,readingSubmitted,
      nextSection:!readingSubmitted?'reading':!listeningSubmitted?'listening':a.writing_submitted_at?'result':'writing',
      readingStartedAt:a.reading_started_at||null,readingDeadlineAt:a.reading_deadline_at||null,
      listeningStartedAt:s?.listening_started_at||null,listeningDeadlineAt:s?.listening_deadline_at||null,
      readingDraft:a.reading_draft||{},readingDraftRevision:Number(a.reading_draft_revision)||0,
      portalSyncStatus:'unknown',result:a.combined_result||{listening:a.listening_result||null,reading:null}}};
}

// Rate limit dùng lại bộ đọc hiện hành; lỗi trả trạng thái rõ, không biến chưa biết thành đã lưu.
export function mountSubmissionStatus(app,{pool,limiter,assertOwner}){
  app.post('/api/term-tests/:testSlug/submission-status',limiter,async(req,res,next)=>{
    try{res.set('Cache-Control','no-store, private').json(await readSubmissionStatus(pool,req.params.testSlug,req.body||{},assertOwner));}
    catch(error){if(error.status)return res.status(error.status).json({ok:false,error:error.code,message:error.message});next(error);}
  });
}
