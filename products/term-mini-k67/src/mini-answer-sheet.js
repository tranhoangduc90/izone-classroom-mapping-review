import { z } from 'zod';
import { findStudentForTermTestSql, insertProtectedListeningAttemptSql } from './sql.js';
import { parseStoredTest, gradeSection, buildListeningResult, buildCombinedResult } from './term-tests.js';

const slug = 'mini-test-lesson-5';
const prefix = `/api/term-tests/${slug}/answer-sheet`;
const identity = z.object({ classCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  studentRef: z.uuid(), identityConfirmed: z.literal(true) });
const token = z.uuid();
const answers = z.record(z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/), z.string().max(120));
const requestSchema = z.object({ examSessionToken: token.optional(), attemptToken: token.optional(),
  generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative().optional(),
  draftRevision: z.number().int().nonnegative().optional(), clientSubmissionId: token.optional(),
  answers: answers.optional() });

// Nhận dữ liệu từ đúng người đã xác nhận; khóa cùng người/lớp trong một giao dịch.
// Không chạy audio, đồng hồ hoặc chấm Writing/đồng bộ Portal khi mở trang nhập.
async function transaction(pool, run) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function problem(code, message, status=409) { return Object.assign(new Error(message), { code, status }); }
function serialize(row, session=false) {
  return { ok:true, attemptMode:row.attempt_mode, policy:{ timed:false, autoSubmit:false },
    attemptToken: session ? row.attempt_id : row.id, examSessionToken:session ? row.id : row.exam_session_id,
    generation:Number(row.generation), studentName:row.student_name_snapshot, className:row.class_name_snapshot,
    listeningSubmitted:session ? Boolean(row.listening_submitted_at) : true, completed:Boolean(row.completed_at),
    readingStartedAt:row.reading_started_at||null, readingDeadlineAt:null, listeningDeadlineAt:null,
    readingDraft:row.reading_draft||{}, readingDraftRevision:Number(row.reading_draft_revision)||0,
    listeningDraft:row.listening_draft||{}, listeningDraftRevision:Number(row.listening_draft_revision)||0,
    portalSyncStatus:'not_applicable', serverNow:new Date().toISOString(),
    result:row.combined_result||null };
}
export function mountMiniAnswerSheet(app, {pool, requireContext, readLimiter, writeLimiter, draftLimiter}) {
  // Lỗi giữ nháp trên máy; không trả thành công khi chưa xác nhận giao dịch.
  const route = fn => async (req,res,next) => { try { await fn(req,res); } catch(error) {
    if(error.status) res.status(error.status).json({ok:false,error:error.code,message:error.message}); else next(error);
  }};
  app.get(`${prefix}/classes`, readLimiter, requireContext, route(async (_req,res) => {
    const rows=await pool.query(`SELECT c.erp_class_name_snapshot AS name FROM mapping.classroom_course_mapping c
      WHERE c.erp_course_class_id>0 AND EXISTS(SELECT 1 FROM assessment.test_definition WHERE slug=$1 AND is_active)
      ORDER BY c.erp_class_name_snapshot`,[slug]);
    res.json({ok:true,classes:rows.rows});
  }));
  app.post(`${prefix}/open`, writeLimiter, requireContext, route(async (req,res) => {
    const parsed=identity.safeParse(req.body);
    if(!parsed.success) throw problem('IDENTITY_REQUIRED','Hãy chọn lớp, tên và xác nhận đúng người.',400);
    const found=await pool.query(findStudentForTermTestSql,[parsed.data.classCode,slug,parsed.data.studentRef]);
    if(found.rowCount!==1) throw problem('STUDENT_NOT_FOUND','Không tìm thấy học viên trong lớp này.',404);
    const student=found.rows[0];
    const out=await transaction(pool,async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${slug}:${student.class_id}:${student.student_id}`]);
      const latest=(await client.query(`SELECT * FROM assessment.term_test_attempt WHERE test_slug=$1
        AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND definition_version=$4 AND superseded_at IS NULL
        ORDER BY (completed_at IS NULL) DESC,completed_at DESC NULLS LAST,created_at DESC LIMIT 1 FOR UPDATE`,[slug,student.class_id,student.student_id,student.definition_version])).rows[0];
      if(latest) {
        if(latest.attempt_mode!=='answer_sheet' && !latest.completed_at)
          throw problem('MODE_CONFLICT','Lượt cũ chưa được xác nhận là nhập đáp án. Hãy nhờ giảng viên kiểm tra; bài cũ vẫn được giữ.');
        return {...serialize(latest),studentRef:parsed.data.studentRef,
          result:latest.combined_result||buildListeningResult(parseStoredTest(student),latest.listening_result)};
      }
      const current=(await client.query(`SELECT * FROM assessment.term_test_exam_session WHERE test_slug=$1
        AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND definition_version=$4
        AND superseded_at IS NULL AND listening_submitted_at IS NULL ORDER BY prepared_at DESC LIMIT 1 FOR UPDATE`,
        [slug,student.class_id,student.student_id,student.definition_version])).rows[0];
      if(current && current.attempt_mode!=='answer_sheet') throw problem('MODE_CONFLICT','Bạn có lượt thi trên máy đang dở. Hãy tiếp tục bằng link thi trên máy.');
      const session=current||(await client.query(`INSERT INTO assessment.term_test_exam_session
        (test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot,attempt_mode,listening_started_at)
        VALUES($1,$2,$3,$4,$5,$6,'answer_sheet',now()) RETURNING *`,
        [slug,student.definition_version,student.class_id,student.class_name,student.student_id,student.student_name])).rows[0];
      return {...serialize(session,true),studentRef:parsed.data.studentRef};
    });
    res.json(out);
  }));
  // Mọi ghi kiểm thế hệ ngay trong giao dịch; tab trước khi mở lại không thể ghi bài mới.
  async function locked(client, data, session=false, history=false) {
    const table=session?'term_test_exam_session':'term_test_attempt';
    const id=session?data.examSessionToken:data.attemptToken;
    if(!id) throw problem('TOKEN_REQUIRED','Chưa xác nhận được lượt bài.',400);
    // Cùng thứ tự khóa với /open: khóa người/lớp trước, rồi khóa bản ghi.
    // Tải lại đang lúc nộp Listening sẽ chờ và đọc lại attempt vừa tạo.
    const owner=(await client.query(`SELECT erp_course_class_id,erp_student_contact_id FROM assessment.${table}
      WHERE id=$1 AND test_slug=$2`,[id,slug])).rows[0];
    if(!owner) throw problem('MODE_CONFLICT','Không tìm thấy lượt nhập đáp án hiện tại.');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`${slug}:${owner.erp_course_class_id}:${owner.erp_student_contact_id}`]);
    const row=(await client.query(`SELECT * FROM assessment.${table} WHERE id=$1 AND test_slug=$2 FOR UPDATE`,[id,slug])).rows[0];
    if(!row||row.superseded_at||(row.attempt_mode!=='answer_sheet'&&!(history&&row.completed_at))) throw problem('MODE_CONFLICT','Lượt này không thuộc trang nhập đáp án hoặc đã được thay thế.');
    if(Number(row.generation)!==data.generation) throw problem('STALE_GENERATION','Lượt bài đã được mở lại. Giữ nháp và xác nhận lại tên để đọc bản hiện tại.');
    return row;
  }
  function parse(req) {const p=requestSchema.safeParse(req.body);if(!p.success) throw problem('INVALID_REQUEST','Dữ liệu lưu bài không hợp lệ.',400);return p.data;}
  for(const section of ['listening','reading']) {
    app.post(`${prefix}/${section}/draft`,draftLimiter,route(async(req,res)=>{
      const data=parse(req); if(!data.answers||data.revision===undefined) throw problem('INVALID_DRAFT','Thiếu đáp án hoặc phiên bản nháp.',400);
      const row=await transaction(pool,async client=>{
        const row=await locked(client,data,section==='listening');
        if(row[`${section}_submitted_at`]) throw problem('ALREADY_SUBMITTED','Phần này đã nộp; nháp trên máy vẫn được giữ.');
        if(section==='reading'&&!row.reading_started_at) throw problem('READING_NOT_OPEN','Hãy mở phần nhập Reading trước.');
        if(data.revision>Number(row[`${section}_draft_revision`])) return (await client.query(`UPDATE assessment.${section==='listening'?'term_test_exam_session':'term_test_attempt'}
          SET ${section}_draft=$2,${section}_draft_revision=$3,${section}_draft_updated_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,
          [row.id,JSON.stringify(data.answers),data.revision])).rows[0];
        return {...row,stale:true};
      });
      res.json({...serialize(row,section==='listening'),revision:Number(row[`${section}_draft_revision`]),
        accepted:!row.stale,draft:row[`${section}_draft`],deadlineAt:null});
    }));
  }
  app.post(`${prefix}/reading/start`,writeLimiter,route(async(req,res)=>{
    const data=parse(req);const row=await transaction(pool,async client=>{
      const row=await locked(client,data);if(row.completed_at) throw problem('ALREADY_SUBMITTED','Reading đã nộp.');
      return (await client.query(`UPDATE assessment.term_test_attempt SET reading_started_at=coalesce(reading_started_at,now()),
        reading_deadline_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    });res.json(serialize(row));
  }));
  app.post(`${prefix}/listening`,writeLimiter,route(async(req,res)=>{
    const data=parse(req);if(!data.answers||!data.clientSubmissionId) throw problem('INVALID_SUBMISSION','Thiếu đáp án hoặc mã gửi bài.',400);
    const row=await transaction(pool,async client=>{
      const session=await locked(client,data,true);
      if(session.attempt_id) return (await client.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[session.attempt_id])).rows[0];
      const definition=(await client.query('SELECT slug AS test_slug,title AS test_title,version AS definition_version,listening_band_adjustment,listening_definition,reading_definition FROM assessment.test_definition WHERE slug=$1 AND version=$2',[slug,session.definition_version])).rows[0];
      const grade=gradeSection(parseStoredTest(definition).listening_definition,data.answers,definition.listening_band_adjustment);
      const inserted=await client.query(insertProtectedListeningAttemptSql,[data.clientSubmissionId,session.id,slug,JSON.stringify(data.answers),JSON.stringify(grade)]);
      if(!inserted.rows[0]) throw problem('SUBMISSION_ID_CONFLICT','Mã gửi bài đã thuộc lượt khác.');
      return (await client.query(`UPDATE assessment.term_test_attempt SET attempt_mode='answer_sheet',generation=$2 WHERE id=$1 RETURNING *`,[inserted.rows[0].attempt_token,session.generation])).rows[0];
    });res.status(201).json({...serialize(row),next:row.completed_at?'result':'reading'});
  }));
  app.post(`${prefix}/reading`,writeLimiter,route(async(req,res)=>{
    const data=parse(req);if(!data.answers) throw problem('INVALID_SUBMISSION','Thiếu đáp án.',400);
    const out=await transaction(pool,async client=>{
      const row=await locked(client,data);if(row.completed_at) return serialize(row);
      if(!row.reading_started_at) throw problem('READING_NOT_OPEN','Hãy mở phần nhập Reading trước.');
      const definition=(await client.query('SELECT slug AS test_slug,title AS test_title,version AS definition_version,listening_band_adjustment,listening_definition,reading_definition FROM assessment.test_definition WHERE slug=$1 AND version=$2',[slug,row.definition_version])).rows[0];
      const test=parseStoredTest(definition);const reading=gradeSection(test.reading_definition,data.answers);
      const combined=buildCombinedResult(test,row.listening_result,reading);
      const saved=(await client.query(`UPDATE assessment.term_test_attempt SET reading_answers=$2,reading_result=$3,combined_result=$4,
        reading_submitted_at=now(),completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id,JSON.stringify(data.answers),JSON.stringify(reading),JSON.stringify(combined)])).rows[0];
      return serialize(saved);
    });res.json({...out,next:'result'});
  }));
  app.post(`${prefix}/result`,readLimiter,route(async(req,res)=>{
    const data=parse(req);const row=await transaction(pool,client=>locked(client,data,false,true));
    const definition=(await pool.query('SELECT slug AS test_slug,title AS test_title,version AS definition_version,listening_band_adjustment,listening_definition,reading_definition FROM assessment.test_definition WHERE slug=$1 AND version=$2',[slug,row.definition_version])).rows[0];
    res.json({...serialize(row),result:row.combined_result||buildListeningResult(parseStoredTest(definition),row.listening_result)});
  }));
}
