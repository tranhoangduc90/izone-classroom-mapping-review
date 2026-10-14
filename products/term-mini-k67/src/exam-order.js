import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { findStudentForTermTestSql } from './sql.js';
import { parseStoredTest, gradeSection, buildCombinedResult } from './term-tests.js';

const slugs = ['term-test-1', 'term-test-2', 'mini-test-lesson-5'];
const identity = z.object({classCode:z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/), studentRef:z.uuid(),
  examMode:z.enum(['lis_first','read_first']).default('lis_first'),
  examDelivery:z.enum(['cbt','answer_sheet']).default('cbt'), identityConfirmed:z.literal(true).optional(),
  orderClientVersion:z.literal(1).optional()});
const input = z.object({attemptToken:z.uuid().optional(),examSessionToken:z.uuid().optional(),
  generation:z.number().int().nonnegative().optional(),orderClientVersion:z.literal(1).optional(),
  revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  draftRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  clientSubmissionId:z.uuid().optional(),
  answers:z.record(z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/),z.string().max(120)).optional()});
const error = (code,message,status=409) => Object.assign(new Error(message),{code,status});

// Đầu vào: token lượt K67 và hai snapshot kỹ năng; đầu ra chỉ nêu kỹ năng đã nộp thật.
// Không dùng sự tồn tại của token làm bằng chứng đã nộp Listening.
export function orderState(row) {
  const listeningSubmitted=Boolean(row.listening_submitted_at),readingSubmitted=Boolean(row.reading_submitted_at);
  return {ok:true,examMode:row.exam_mode,examDelivery:row.exam_delivery,attemptMode:row.attempt_mode,
    attemptToken:row.id,examSessionToken:row.exam_session_id,generation:Number(row.generation)||0,
    studentName:row.student_name_snapshot,className:row.class_name_snapshot,
    listeningSubmitted,readingSubmitted,completed:Boolean(row.completed_at),completedAt:row.completed_at,
    nextSection:!readingSubmitted?'reading':!listeningSubmitted?'listening':row.test_slug==='mini-test-lesson-5'?'result':'writing',
    listeningStartedAt:row.session_started_at||null,listeningDeadlineAt:row.session_deadline_at||null,
    readingStartedAt:row.reading_started_at,readingDeadlineAt:row.reading_deadline_at,
    listeningDraft:row.session_draft||{},listeningDraftRevision:Number(row.session_revision)||0,
    readingDraft:row.reading_draft||{},readingDraftRevision:Number(row.reading_draft_revision)||0,
    writingStartedAt:row.writing_started_at,writingDeadlineAt:row.writing_deadline_at,writingSubmittedAt:row.writing_submitted_at,
    policy:{timed:row.attempt_mode!=='answer_sheet',autoSubmit:row.attempt_mode!=='answer_sheet'},
    result:row.combined_result||null,resultAvailable:Boolean(row.completed_at),serverNow:new Date(row.server_now||Date.now()).toISOString()};
}
const select = `SELECT a.*,s.listening_started_at AS session_started_at,s.listening_deadline_at AS session_deadline_at,
  s.listening_draft AS session_draft,s.listening_draft_revision AS session_revision,
  s.listening_draft_updated_at,
  s.superseded_at AS session_superseded_at,s.generation AS session_generation,
  d.slug AS test_slug,d.title AS test_title,d.version AS definition_version,
  d.listening_band_adjustment,d.listening_definition,d.reading_definition,clock_timestamp() AS server_now,
  clock_timestamp()>a.reading_deadline_at AS reading_timed_out,clock_timestamp()<=a.reading_deadline_at+interval '5 minutes' AS reading_grace,
  clock_timestamp()>s.listening_deadline_at AS listening_timed_out,clock_timestamp()<=s.listening_deadline_at+interval '5 minutes' AS listening_grace
  FROM assessment.term_test_attempt a JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
  JOIN assessment.test_definition d ON d.slug=a.test_slug AND d.version=a.definition_version`;

// Nhận yêu cầu Reading trước, khóa cùng học viên/lớp rồi lưu vào SQL thật.
// Bài Listening trước đi tiếp qua tuyến hiện hành; cờ chỉ khóa việc tạo Reading trước mới.
// Lỗi giữ nguyên snapshot đã ghi và trả mã rõ để trình duyệt thử lại hoặc tải bản mới.
export function mountExamOrder(app,{pool,config,assets,requireContext,readLimiter,writeLimiter,draftLimiter,syncComplete,logEvent=()=>{}}) {
  if (config.readFirstNewEnabled === undefined) return;
  const route=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(e){if(e.status)res.status(e.status).json({ok:false,error:e.code,message:e.message});else next(e);}};
  // Chỉ tính giới hạn ở handler thực sự nhận lượt RF; tuyến LF giữ bộ đếm cũ.
  const admit=(req,res,limiter)=>new Promise((resolve,reject)=>{
    const finish=()=>{res.off('finish',finish);resolve(false);};res.once('finish',finish);
    limiter(req,res,err=>{res.off('finish',finish);if(err)reject(err);else resolve(true);});
  });
  async function tx(run) {
    const client=await pool.connect();
    try {await client.query('BEGIN');const out=await run(client);await client.query('COMMIT');return out;}
    catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async function reload(db,id) {return (await db.query(`${select} WHERE a.id=$1 AND a.superseded_at IS NULL
    AND s.superseded_at IS NULL AND s.generation=a.generation`,[id])).rows[0];}
  async function locate(data,slug) {
    if(!data.attemptToken&&!data.examSessionToken)return null;
    return (await pool.query(`${select} WHERE (a.id=$1::uuid OR a.exam_session_id=$2::uuid)
      AND a.test_slug=$3 AND a.exam_mode='read_first'`,[data.attemptToken||null,data.examSessionToken||null,slug])).rows[0];
  }
  function clientCheck(data,row,paper) {
    if(row.superseded_at||row.session_superseded_at)throw error('STALE_ATTEMPT','Lượt bài đã được thay thế. Hãy xác nhận lại tên.');
    if(row.session_generation!==undefined&&Number(row.session_generation)!==Number(row.generation))throw error('STALE_GENERATION','Lượt bài đã được mở lại. Hãy xác nhận lại tên.');
    if(data.orderClientVersion!==1)throw error('ORDER_CLIENT_UPDATE_REQUIRED','Lượt này làm Reading trước. Hãy tải lại trang để dùng phiên bản mới.');
    if(paper!== (row.attempt_mode==='answer_sheet'))throw error('MODE_CONFLICT','Hãy mở đúng cách làm bài đã chọn cho lượt này.');
    if(paper&&data.generation!==Number(row.generation))throw error('STALE_GENERATION','Lượt bài đã được mở lại. Hãy xác nhận lại tên; bản nháp vẫn được giữ.');
  }
  async function locked(db,row) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${row.test_slug}:${row.erp_course_class_id}:${row.erp_student_contact_id}`]);
    await db.query('SELECT id FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE',[row.exam_session_id]);
    await db.query('SELECT id FROM assessment.term_test_attempt WHERE id=$1 FOR UPDATE',[row.id]);
    const current=await reload(db,row.id);
    if(!current)throw error('STALE_ATTEMPT','Lượt bài đã được thay thế. Hãy xác nhận lại tên.');
    if(Number(current.generation)!==Number(row.generation))throw error('STALE_GENERATION','Lượt bài đã được mở lại.');
    return current;
  }
  async function open(req,res,next,paper=false) {
    const slug=paper?'mini-test-lesson-5':req.params.testSlug;
    if(!slugs.includes(slug))return next();
    const p=identity.safeParse(req.body);
    if(!p.success) {
      if(req.body?.examMode==='read_first')throw error('INVALID_REQUEST','Yêu cầu Reading trước không hợp lệ. Hãy tải lại trang.',400);
      return next();
    }
    const data=p.data;
    const found=await pool.query(findStudentForTermTestSql,[data.classCode,slug,data.studentRef]);
    if(found.rowCount!==1)return next();
    const student=found.rows[0];
    const out=await tx(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${slug}:${student.class_id}:${student.student_id}`]);
      const previous=(await db.query(`SELECT * FROM assessment.term_test_attempt WHERE test_slug=$1 AND definition_version=$2
        AND erp_course_class_id=$3 AND erp_student_contact_id=$4 AND superseded_at IS NULL
        ORDER BY (completed_at IS NULL) DESC,created_at DESC LIMIT 1`,[slug,student.definition_version,student.class_id,student.student_id])).rows[0];
      if(previous) {
        if(previous.exam_mode!=='read_first')return null;
        if(!await admit(req,res,writeLimiter))return null;
        const bound=await reload(db,previous.id);
        if(!bound)throw error('STALE_ATTEMPT','Lượt bài đã được mở lại. Hãy xác nhận lại tên.');
        clientCheck({...data,generation:Number(previous.generation)},bound,paper);
        clientCheck({...data,generation:Number(previous.generation)},previous,paper);
        if(previous.exam_delivery!==(paper?'answer_sheet':data.examDelivery))throw error('MODE_CONFLICT','Lượt này đã gắn với cách làm bài khác. Hãy dùng link ban đầu.');
        return bound;
      }
      const oldSession=(await db.query(`SELECT id FROM assessment.term_test_exam_session WHERE test_slug=$1 AND definition_version=$2
        AND erp_course_class_id=$3 AND erp_student_contact_id=$4 AND superseded_at IS NULL
        AND (prepared_at>=now()-interval '8 hours' OR attempt_mode='answer_sheet') LIMIT 1`,[slug,student.definition_version,student.class_id,student.student_id])).rows[0];
      if(oldSession||data.examMode!=='read_first')return null;
      if(!await admit(req,res,writeLimiter))return null;
      if(!config.readFirstNewEnabled)throw error('READ_FIRST_NOT_ENABLED','Phiên bản Reading trước chưa được mở cho lượt mới.');
      if(data.orderClientVersion!==1)throw error('ORDER_CLIENT_UPDATE_REQUIRED','Hãy tải lại trang để dùng phiên bản mới.');
      if(paper&&!data.identityConfirmed)throw error('IDENTITY_REQUIRED','Hãy xác nhận đúng lớp và tên.',400);
      if(!assets)throw error('EXAM_ASSETS_UNAVAILABLE','Chưa cấp được đề thi. Hãy thử lại.',503);
      // Giữ cách hết hạn phòng chờ cũ: chỉ thay phiên Listening chưa nộp, quá 8 giờ.
      await db.query(`UPDATE assessment.term_test_exam_session SET superseded_at=now(),updated_at=now()
        WHERE test_slug=$1 AND definition_version=$2 AND erp_course_class_id=$3 AND erp_student_contact_id=$4
          AND superseded_at IS NULL AND listening_submitted_at IS NULL AND exam_mode='lis_first'
          AND attempt_mode<>'answer_sheet' AND prepared_at<now()-interval '8 hours'`,
        [slug,student.definition_version,student.class_id,student.student_id]);
      const mode=paper?'answer_sheet':data.examDelivery==='cbt'?'cbt':'legacy';
      const session=(await db.query(`INSERT INTO assessment.term_test_exam_session
        (test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot,attempt_mode,exam_mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,'read_first') RETURNING *`,[slug,student.definition_version,student.class_id,student.class_name,student.student_id,student.student_name,mode])).rows[0];
      const attempt=(await db.query(`INSERT INTO assessment.term_test_attempt
        (client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,
         student_name_snapshot,exam_session_id,attempt_mode,exam_mode,exam_delivery)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'read_first',$10) RETURNING id`,
        [randomUUID(),slug,student.definition_version,student.class_id,student.class_name,student.student_id,student.student_name,session.id,mode,paper?'answer_sheet':data.examDelivery])).rows[0];
      await db.query('UPDATE assessment.term_test_exam_session SET attempt_id=$2 WHERE id=$1',[session.id,attempt.id]);
      return reload(db,attempt.id);
    });
    if(res.headersSent)return;
    if(!out) {
      if(req.path.endsWith('/order/open'))return res.json({ok:true,examMode:'lis_first'});
      return next();
    }
    res.json({...orderState(out),studentRef:data.studentRef,
      encryptedAudioUrl:`/api/term-tests/${slug}/session/${out.exam_session_id}/audio`,
      previewAudioUrl:`/api/term-tests/${slug}/session/${out.exam_session_id}/preview`});
  }
  app.post('/api/term-tests/:testSlug/session/prepare',requireContext,route((req,res,next)=>open(req,res,next)));
  app.post('/api/term-tests/:testSlug/order/open',requireContext,route((req,res,next)=>open(req,res,next)));
  app.post('/api/term-tests/mini-test-lesson-5/answer-sheet/open',requireContext,route((req,res,next)=>open(req,res,next,true)));
  // Link hoặc trang đã cache phải nhận diện lượt Reading trước qua danh tính,
  // kể cả trước khi Listening tạo snapshot; không rơi sang tuyến cũ với điểm NULL.
  async function byOwner(req) {
    const p=identity.safeParse({...req.body,orderClientVersion:undefined});
    if(!p.success||!slugs.includes(req.params.testSlug))return null;
    const student=(await pool.query(findStudentForTermTestSql,[p.data.classCode,req.params.testSlug,p.data.studentRef])).rows[0];
    if(!student)return null;
    const row=(await pool.query(`${select} WHERE a.test_slug=$1 AND a.definition_version=$2
      AND a.erp_course_class_id=$3 AND a.erp_student_contact_id=$4
      AND a.exam_mode='read_first' AND a.superseded_at IS NULL ORDER BY a.created_at DESC LIMIT 1`,
      [req.params.testSlug,student.definition_version,student.class_id,student.student_id])).rows[0];
    return row;
  }
  app.post('/api/term-tests/:testSlug/attempt/active',requireContext,route(async(req,res,next)=>{
    const row=await byOwner(req);if(!row)return next();
    if(!await admit(req,res,readLimiter))return;
    clientCheck(req.body,row,false);
    res.json({...orderState(row),active:!row.completed_at});
  }));
  app.post('/api/term-tests/:testSlug/listening',(req,res,next)=>{
    // Bài đang làm bằng token phải tiếp tục được khi bộ đệm lớp tạm cũ.
    if(req.body?.examSessionToken||req.body?.attemptToken)return next('route');
    return next();
  },route(async(req,res,next)=>{
    const row=await byOwner(req);if(!row)return next();
    if(!await admit(req,res,writeLimiter))return;
    clientCheck(req.body,row,false);
    throw error('EXAM_SESSION_REQUIRED','Hãy tải lại lượt bài để tiếp tục Listening đúng thứ tự.');
  }));
  // Lượt Reading trước đã được bind không hết quyền tải audio chỉ vì ở phòng chờ quá 8 giờ.
  // Chỉ cấp audio khi Reading đã nộp; bài giấy không đi qua đường audio trên máy.
  for(const kind of ['audio','preview'])app.get(`/api/term-tests/:testSlug/session/:examSessionToken/${kind}`,route(async(req,res,next)=>{
    const token=z.uuid().safeParse(req.params.examSessionToken);if(!token.success)return next();
    const row=await locate({examSessionToken:token.data},req.params.testSlug);if(!row)return next();
    if(!await admit(req,res,readLimiter))return;
    if(row.superseded_at||row.session_superseded_at)throw error('STALE_ATTEMPT','Lượt bài đã được thay thế. Hãy xác nhận lại tên.');
    if(Number(row.session_generation)!==Number(row.generation))throw error('STALE_GENERATION','Lượt bài đã được mở lại.');
    if(row.exam_delivery!=='cbt'||!row.reading_submitted_at)throw error('SECTION_NOT_OPEN','Audio chỉ mở khi bạn đã nộp Reading và tiếp tục thi trên máy.');
    if(kind==='audio')return assets.streamEncryptedAudio(row.test_slug,token.data,res);
    const preview=await assets.getPreview(row.test_slug);res.set({'Content-Type':'audio/mpeg','Cache-Control':'no-store, private'}).send(preview);
  }));
  app.post('/api/term-tests/:testSlug/session/resume-attempt',route(async(req,res,next)=>{
    const token=z.uuid().safeParse(req.body?.attemptToken);
    const row=token.success?await locate({attemptToken:token.data},req.params.testSlug):null;if(!row)return next();
    if(!await admit(req,res,readLimiter))return;
    clientCheck(req.body,row,false);
    const data=input.safeParse(req.body);if(!data.success)throw error('INVALID_REQUEST','Yêu cầu khôi phục không hợp lệ.',400);
    clientCheck(data.data,row,false);
    const owner=identity.safeParse(req.body);if(!owner.success)throw error('IDENTITY_REQUIRED','Hãy xác nhận lại tên.',400);
    const found=await pool.query(findStudentForTermTestSql,[owner.data.classCode,row.test_slug,owner.data.studentRef]);
    if(found.rows[0]?.student_id!==String(row.erp_student_contact_id)||found.rows[0]?.class_id!==String(row.erp_course_class_id))throw error('ATTEMPT_NOT_FOUND','Không tìm thấy lượt bài của người này.',404);
    res.json({...orderState(row),content:await assets.getContent(row.test_slug),timing:assets.getTiming(row.test_slug)});
  }));
  async function handle(req,res,next,action,paper=false) {
    const slug=paper?'mini-test-lesson-5':req.params.testSlug;
    // Nhận diện token trước validation: payload sai của Reading trước không được rơi vào tuyến cũ.
    const attempt=z.uuid().safeParse(req.body?.attemptToken),session=z.uuid().safeParse(req.body?.examSessionToken);
    const row=await locate({attemptToken:attempt.success?attempt.data:undefined,examSessionToken:session.success?session.data:undefined},slug);
    if(!row) {
      if(req.body?.examMode==='read_first') {
        if(!await admit(req,res,writeLimiter))return;
        throw error('EXAM_SESSION_REQUIRED','Chưa mở được lượt Reading trước. Hãy xác nhận lại tên rồi thử lại.');
      }
      return next();
    }
    if(!await admit(req,res,action==='result'?readLimiter:action.endsWith('draft')?draftLimiter:writeLimiter))return;
    clientCheck(req.body,row,paper);
    if((attempt.success&&attempt.data!==row.id)||(session.success&&session.data!==row.exam_session_id))throw error('TOKEN_MISMATCH','Hai mã lượt bài không thuộc cùng một lượt. Hãy xác nhận lại tên.');
    const parsed=input.safeParse(req.body);if(!parsed.success)throw error('INVALID_REQUEST','Dữ liệu lưu bài không hợp lệ.',400);
    const data=parsed.data;
    clientCheck(data,row,paper);
    const out=await tx(async db=>{
      const r=await locked(db,row);clientCheck(data,r,paper);
      const state=orderState(r),section=action.startsWith('reading')?'reading':'listening';
      if(action==='result')return r;
      if(action.endsWith('start')) {
        if(state.nextSection!==section&&!r[`${section}_submitted_at`])throw error('SECTION_NOT_OPEN','Hãy hoàn thành kỹ năng trước.');
        if(r[`${section}_submitted_at`])return r;
        if(section==='reading')await db.query(`UPDATE assessment.term_test_attempt SET reading_started_at=coalesce(reading_started_at,$3::timestamptz),
          reading_deadline_at=CASE WHEN attempt_mode='answer_sheet' THEN NULL ELSE coalesce(reading_deadline_at,$3::timestamptz+make_interval(mins=>$2)) END,
          updated_at=clock_timestamp() WHERE id=$1`,[r.id,assets.getTiming(slug).readingDurationMinutes,r.server_now]);
        else await db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=coalesce(listening_started_at,$3::timestamptz),
          listening_deadline_at=CASE WHEN attempt_mode='cbt' THEN coalesce(listening_deadline_at,$3::timestamptz+make_interval(secs=>$2::double precision)) ELSE NULL END,
          updated_at=clock_timestamp() WHERE id=$1`,[r.exam_session_id,assets.getTiming(slug).listeningTotalSeconds,r.server_now]);
        return reload(db,r.id);
      }
      if(r[`${section}_submitted_at`]) {
        if(action.endsWith('draft'))throw error(section.toUpperCase()+'_LOCKED','Phần này đã hết giờ hoặc đã được thu bài.');
        return r;
      }
      if(state.nextSection!==section)throw error('SECTION_NOT_OPEN','Hãy hoàn thành kỹ năng trước.');
      if(!data.answers)throw error('INVALID_SUBMISSION','Thiếu đáp án.',400);
      const started=section==='reading'?r.reading_started_at:r.session_started_at;
      // Answer Sheet Term không chạy Listening tự động; lần nộp chính là lúc xác nhận phần nhập.
      if(!started&&!(section==='listening'&&r.exam_delivery==='answer_sheet'))throw error('SECTION_NOT_STARTED','Hãy nhấn bắt đầu phần này trước.');
      const deadline=section==='reading'?r.reading_deadline_at:r.session_deadline_at;
      const draft=section==='reading'?r.reading_draft:r.session_draft;
      const revision=Number(section==='reading'?r.reading_draft_revision:r.session_revision)||0;
      const expired=Boolean(r[`${section}_timed_out`]);
      if(action.endsWith('draft')) {
        if(data.revision===undefined)throw error('INVALID_DRAFT','Thiếu phiên bản nháp.',400);
        if(expired)throw error(section.toUpperCase()+'_LOCKED','Phần này đã hết giờ. Bản đã lưu vẫn được giữ.');
        if(data.revision>revision)await db.query(`UPDATE assessment.${section==='reading'?'term_test_attempt':'term_test_exam_session'}
          SET ${section}_draft=$2,${section}_draft_revision=$3,${section}_draft_updated_at=now(),updated_at=now() WHERE id=$1`,
          [section==='reading'?r.id:r.exam_session_id,JSON.stringify(data.answers),data.revision]);
        return {...await reload(db,r.id),draftAccepted:data.revision>revision,event:{name:'draft_saved',token:section==='reading'?r.id:r.exam_session_id,
          details:{section,revision:Math.max(revision,data.revision),answeredCount:Object.values(data.answers).filter(value=>String(value).trim()).length,accepted:data.revision>revision}}};
      }
      if(section==='listening'&&!data.clientSubmissionId)throw error('INVALID_SUBMISSION','Thiếu mã gửi bài.',400);
      if(section==='listening') {
        // Mã gửi của trình duyệt giữ nguyên cơ chế chống trùng giữa các học viên.
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${slug}:submission:${data.clientSubmissionId}`]);
        const conflict=await db.query(`SELECT id FROM assessment.term_test_attempt WHERE test_slug=$1 AND client_submission_id=$2 AND id<>$3`,
          [slug,data.clientSubmissionId,r.id]);
        if(conflict.rowCount)throw error('SUBMISSION_ID_CONFLICT','Mã gửi bài đã được dùng cho lượt làm khác.');
        await db.query('UPDATE assessment.term_test_attempt SET client_submission_id=$2 WHERE id=$1',[r.id,data.clientSubmissionId]);
      }
      // Hết giờ: giữ snapshot đã ACK; nhận snapshot cuối trong 5 phút nếu cùng/lớn hơn revision đã lưu.
      const grace=Boolean(r[`${section}_grace`]);
      const current=Number.isSafeInteger(data.draftRevision)?data.draftRevision>=revision:revision===0;
      const effective=expired&&!(grace&&current)?draft:data.answers;
      const test=parseStoredTest(r),grade=gradeSection(test[`${section}_definition`],effective,section==='listening'?test.listening_band_adjustment:0);
      const other=section==='reading'?r.listening_result:r.reading_result;
      const combined=other?buildCombinedResult(test,section==='listening'?grade:other,section==='reading'?grade:other):null;
      await db.query(`UPDATE assessment.term_test_attempt SET ${section}_answers=$2,${section}_result=$3,${section}_submitted_at=clock_timestamp(),
        combined_result=$4,completed_at=CASE WHEN $4::jsonb IS NULL THEN NULL ELSE clock_timestamp() END,updated_at=clock_timestamp() WHERE id=$1`,
        [r.id,JSON.stringify(effective),JSON.stringify(grade),combined?JSON.stringify(combined):null]);
      if(section==='listening')await db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=coalesce(listening_started_at,clock_timestamp()),
        listening_submitted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[r.exam_session_id]);
      return {...await reload(db,r.id),event:{name:'submission_completed',token:section==='reading'?r.id:r.exam_session_id,
        details:{section,revision:data.draftRevision,answeredCount:Object.values(effective).filter(value=>String(value).trim()).length,timedOut:expired,
          snapshotSource:expired?(grace&&current?'grace_submission':'saved_draft'):'on_time_submission'}}};
    });
    if(out.event)logEvent(out.event.name,slug,out.event.token,out.event.details);
    const state=orderState(out);
    const syncRow={...out,attempt_token:out.id,test_slug:slug,class_id:String(out.erp_course_class_id),student_id:String(out.erp_student_contact_id),class_name:out.class_name_snapshot,student_name:out.student_name_snapshot};
    const portalSyncStatus=out.completed_at&& !paper ? await syncComplete(syncRow,out.combined_result):paper?'not_applicable':'pending_sections';
    const response={...state,portalSyncStatus,next:state.nextSection};
    if(['reading','listening'].includes(action))response.timedOut=Boolean(out[action+'_timed_out']);
    if(action.endsWith('draft'))Object.assign(response,{accepted:out.draftAccepted,revision:sectionRevision(out,action),draft:action.startsWith('reading')?out.reading_draft:out.session_draft,deadlineAt:action.startsWith('reading')?out.reading_deadline_at:out.session_deadline_at,savedAt:action.startsWith('reading')?out.reading_draft_updated_at:out.listening_draft_updated_at});
    if(action==='listening/start'&&out.exam_delivery==='cbt')Object.assign(response,{content:await assets.getContent(slug),timing:assets.getTiming(slug),
      audioKey:assets.getSessionAudioKey(slug,out.exam_session_id).toString('base64'),audioEnvelope:{magic:'IZTT1',ivBytes:12,tagBytes:16}});
    res.json(response);
  }
  for(const [suffix,action] of [['session/start','listening/start'],['reading/start','reading/start'],['reading/draft','reading/draft'],['listening/draft','listening/draft'],['reading','reading'],['listening','listening']])
    app.post(`/api/term-tests/:testSlug/${suffix}`,route((req,res,next)=>handle(req,res,next,action)));
  for(const action of ['reading/start','reading/draft','listening/draft','reading','listening','result'])
    app.post(`/api/term-tests/mini-test-lesson-5/answer-sheet/${action}`,route((req,res,next)=>handle(req,res,next,action,true)));
  app.post('/api/term-tests/result',route(async(req,res,next)=>{
    const p=z.uuid().safeParse(req.body?.attemptToken);if(!p.success)return next();
    const row=(await pool.query('SELECT test_slug,completed_at FROM assessment.term_test_attempt WHERE id=$1 AND exam_mode=\'read_first\'',[p.data])).rows[0];
    if(!row)return next();
    const bound=await locate({attemptToken:p.data},row.test_slug);clientCheck(req.body,bound,false);
    if(row.completed_at)return next();
    req.params.testSlug=row.test_slug;return handle(req,res,next,'result');
  }));
}
function sectionRevision(row,action) {return Number(action.startsWith('reading')?row.reading_draft_revision:row.session_revision)||0;}
