// K56 giữ bộ kiểm quyền/phiên đang chạy; không nhập runtime hoặc quyền của K67.
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {buildTeacherClassAccessPredicate} from './teacher-class-access-sql.js';
import {queryTeacherSessionScope} from './teacher-session-scope.js';

// Chỉ đọc bản máy chủ đã lưu. Không gọi resume/result vì các đường đó có thể thu bài,
// cập nhật đồng hồ hoặc ghi điểm. Mã phiên học viên không được đưa ra dashboard.
export const teacherSavedProgressSql=`WITH target AS (
 SELECT erp_course_class_id,erp_class_name_snapshot FROM mapping.classroom_course_mapping
 WHERE upper(trim(erp_class_name_snapshot))=upper(trim($1))
), allowed AS (
 SELECT * FROM target t WHERE $4::boolean OR ${buildTeacherClassAccessPredicate({reviewerEmailSql:'$3',classIdSql:'t.erp_course_class_id'})}
), identities AS (
 SELECT r.erp_course_class_id,r.erp_student_contact_id,r.student_name_snapshot AS name
 FROM assessment.term_test_roster r JOIN allowed c ON c.erp_course_class_id=r.erp_course_class_id
 WHERE r.test_slug=$2 AND r.student_ref=$5::uuid
 UNION
 SELECT m.erp_course_class_id,m.erp_student_contact_id,m.erp_student_name_snapshot AS name
 FROM mapping.student_mapping_review m JOIN allowed c ON c.erp_course_class_id=m.erp_course_class_id
 WHERE m.public_id=$5::uuid AND m.status<>'superseded'
 UNION
 SELECT t.erp_course_class_id,-t.temporary_student_id,t.student_name_snapshot AS name
 FROM assessment.term_test_temporary_student t JOIN allowed c ON c.erp_course_class_id=t.erp_course_class_id
 WHERE t.test_slug=$2 AND t.student_ref=$5::uuid AND t.active
), identity AS (
 SELECT DISTINCT erp_course_class_id,erp_student_contact_id FROM identities
), progress AS (
 SELECT a.id AS internal_id,a.definition_version,a.created_at,a.superseded_at,
  a.student_name_snapshot AS student_name,a.attempt_mode,a.exam_mode,
  COALESCE(to_jsonb(a)->>'exam_delivery',CASE WHEN a.attempt_mode='answer_sheet' THEN 'answer_sheet' ELSE 'cbt' END) AS exam_delivery,
  a.listening_submitted_at,a.reading_submitted_at,a.writing_submitted_at,a.completed_at,
  s.listening_started_at,s.listening_deadline_at,s.listening_draft_updated_at,
  CASE WHEN a.listening_submitted_at IS NOT NULL THEN a.listening_answers ELSE s.listening_draft END AS listening_answers,
  a.reading_started_at,a.reading_deadline_at,a.reading_draft_updated_at,
  CASE WHEN a.reading_submitted_at IS NOT NULL THEN a.reading_answers ELSE a.reading_draft END AS reading_answers,
  a.writing_started_at,a.writing_deadline_at,a.writing_updated_at,a.writing_task_1,a.writing_task_2
 FROM assessment.term_test_attempt a JOIN identity i
  ON i.erp_course_class_id=a.erp_course_class_id AND i.erp_student_contact_id=a.erp_student_contact_id
 LEFT JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
 WHERE a.test_slug=$2
 UNION ALL
 SELECT s.id,s.definition_version,s.created_at,s.superseded_at,s.student_name_snapshot,s.attempt_mode,COALESCE(to_jsonb(s)->>'exam_mode','lis_first'),
  CASE WHEN s.attempt_mode='answer_sheet' THEN 'answer_sheet' ELSE 'cbt' END,
  s.listening_submitted_at,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,
  s.listening_started_at,s.listening_deadline_at,s.listening_draft_updated_at,s.listening_draft,
  NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,'{}'::jsonb,
  NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,''::text,''::text
 FROM assessment.term_test_exam_session s JOIN identity i
  ON i.erp_course_class_id=s.erp_course_class_id AND i.erp_student_contact_id=s.erp_student_contact_id
 WHERE s.test_slug=$2 AND NOT EXISTS(SELECT 1 FROM assessment.term_test_attempt a WHERE a.exam_session_id=s.id)
)
SELECT (SELECT count(*)::int FROM target) AS class_count,(SELECT count(*)::int FROM allowed) AS allowed_count,
 (SELECT count(*)::int FROM identity) AS identity_count,(SELECT name FROM identities LIMIT 1) AS student_name,
 (SELECT title FROM assessment.test_definition WHERE slug=$2 AND is_active LIMIT 1) AS test_title,
 COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.internal_id) FROM progress p),'[]'::jsonb) AS progress;`;

// Danh mục chỉ đọc metadata và phiên bản hàng; nội dung lớn chỉ được chọn cho
// một viewId thuộc đúng học viên/lớp/bài. Không dùng timestamp làm revision vì
// một lần sửa có thể giữ nguyên thời gian lưu cũ.
const savedViewId=alias=>`encode(sha256(convert_to('teacher-saved-progress:'||${alias}.id::text,'UTF8')),'hex')`;
const rowVersion=alias=>`jsonb_build_array(${alias}.tableoid::text,${alias}.ctid::text,${alias}.xmin::text)`;
export const teacherSavedProgressCompactSql=includeContent=>`WITH target AS (
 SELECT erp_course_class_id,erp_class_name_snapshot FROM mapping.classroom_course_mapping
 WHERE upper(trim(erp_class_name_snapshot))=upper(trim($1))
), allowed AS (
 SELECT * FROM target t WHERE $4::boolean OR ${buildTeacherClassAccessPredicate({reviewerEmailSql:'$3',classIdSql:'t.erp_course_class_id'})}
), identities AS (
 SELECT r.erp_course_class_id,r.erp_student_contact_id,r.student_name_snapshot AS name
 FROM assessment.term_test_roster r JOIN allowed c ON c.erp_course_class_id=r.erp_course_class_id
 WHERE r.test_slug=$2 AND r.student_ref=$5::uuid
 UNION
 SELECT m.erp_course_class_id,m.erp_student_contact_id,m.erp_student_name_snapshot AS name
 FROM mapping.student_mapping_review m JOIN allowed c ON c.erp_course_class_id=m.erp_course_class_id
 WHERE m.public_id=$5::uuid AND m.status<>'superseded'
 UNION
 SELECT t.erp_course_class_id,-t.temporary_student_id,t.student_name_snapshot AS name
 FROM assessment.term_test_temporary_student t JOIN allowed c ON c.erp_course_class_id=t.erp_course_class_id
 WHERE t.test_slug=$2 AND t.student_ref=$5::uuid AND t.active
), identity AS (
 SELECT DISTINCT erp_course_class_id,erp_student_contact_id FROM identities
), progress AS (
 SELECT a.id AS internal_id,a.definition_version,a.created_at,a.superseded_at,
  a.attempt_mode,a.exam_mode,CASE WHEN a.attempt_mode='answer_sheet' THEN 'answer_sheet' ELSE 'cbt' END AS exam_delivery,a.completed_at,
  md5(jsonb_build_array(${rowVersion('a')},${rowVersion('s')})::text) AS revision
  ${includeContent?`,a.listening_submitted_at,a.reading_submitted_at,a.writing_submitted_at,
   s.listening_started_at,s.listening_deadline_at,s.listening_draft_updated_at,
   CASE WHEN a.listening_submitted_at IS NOT NULL THEN a.listening_answers ELSE s.listening_draft END AS listening_answers,
   a.reading_started_at,a.reading_deadline_at,a.reading_draft_updated_at,
   CASE WHEN a.reading_submitted_at IS NOT NULL THEN a.reading_answers ELSE a.reading_draft END AS reading_answers,
   a.writing_started_at,a.writing_deadline_at,a.writing_updated_at,a.writing_task_1,a.writing_task_2`:''}
 FROM assessment.term_test_attempt a JOIN identity i
  ON i.erp_course_class_id=a.erp_course_class_id AND i.erp_student_contact_id=a.erp_student_contact_id
 LEFT JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
 WHERE a.test_slug=$2 AND ($6::text IS NULL OR ${savedViewId('a')}=$6)
 UNION ALL
 SELECT s.id,s.definition_version,s.created_at,s.superseded_at,s.attempt_mode,'lis_first'::text,
  CASE WHEN s.attempt_mode='answer_sheet' THEN 'answer_sheet' ELSE 'cbt' END,NULL::timestamptz,
  md5(jsonb_build_array(${rowVersion('s')})::text)
  ${includeContent?`,s.listening_submitted_at,NULL::timestamptz,NULL::timestamptz,
   s.listening_started_at,s.listening_deadline_at,s.listening_draft_updated_at,s.listening_draft,
   NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,'{}'::jsonb,
   NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,''::text,''::text`:''}
 FROM assessment.term_test_exam_session s JOIN identity i
  ON i.erp_course_class_id=s.erp_course_class_id AND i.erp_student_contact_id=s.erp_student_contact_id
 WHERE s.test_slug=$2 AND ($6::text IS NULL OR ${savedViewId('s')}=$6)
  AND NOT EXISTS(SELECT 1 FROM assessment.term_test_attempt a WHERE a.exam_session_id=s.id)
)
SELECT (SELECT count(*)::int FROM target) AS class_count,(SELECT count(*)::int FROM allowed) AS allowed_count,
 (SELECT count(*)::int FROM identity) AS identity_count,(SELECT name FROM identities LIMIT 1) AS student_name,
 (SELECT title FROM assessment.test_definition WHERE slug=$2 AND is_active LIMIT 1) AS test_title,
 COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.internal_id) FROM progress p),'[]'::jsonb) AS progress;`;

export async function readTeacherSavedProgress(pool,input,req){
 const compact=input.mode==='index'||input.mode==='view';
 const values=[input.class,input.test,req.reviewer.email,Boolean(req.reviewer.canAccessAllClasses),input.student];
 if(compact)values.push(input.viewId||null);
 const {rows:[row]}=await queryTeacherSessionScope(pool,req,compact?teacherSavedProgressCompactSql(input.mode==='view'):teacherSavedProgressSql,values,3,4);
 const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
 if(!row?.test_title)fail(404,'TEST_NOT_FOUND','Bài test chưa được mở.');
 if(Number(row.class_count)!==1)fail(404,'CLASS_NOT_FOUND','Không tìm thấy duy nhất một lớp phù hợp.');
 if(Number(row.allowed_count)!==1)fail(403,'ACCESS_DENIED','Tài khoản chưa có quyền xem lớp này.');
 if(Number(row.identity_count)!==1)fail(404,'STUDENT_NOT_FOUND','Không tìm thấy duy nhất một hồ sơ của học viên trong bài này.');
 const attempts=(row.progress||[]).map(p=>({
  viewId:createHash('sha256').update('teacher-saved-progress:'+p.internal_id).digest('hex'),
  definitionVersion:p.definition_version,createdAt:p.created_at,superseded:Boolean(p.superseded_at),
  mode:p.attempt_mode,order:p.exam_mode,delivery:p.exam_delivery,completedAt:p.completed_at,
  ...(compact?{revision:p.revision}:{}),
  ...(input.mode==='index'?{}:{
  listening:{answers:p.listening_answers||{},startedAt:p.listening_started_at,deadlineAt:p.listening_deadline_at,savedAt:p.listening_draft_updated_at,submittedAt:p.listening_submitted_at},
  reading:{answers:p.reading_answers||{},startedAt:p.reading_started_at,deadlineAt:p.reading_deadline_at,savedAt:p.reading_draft_updated_at,submittedAt:p.reading_submitted_at},
  writing:{task1:p.writing_task_1||'',task2:p.writing_task_2||'',startedAt:p.writing_started_at,deadlineAt:p.writing_deadline_at,savedAt:p.writing_updated_at,submittedAt:p.writing_submitted_at}
  })
 }));
 if(input.mode==='view'&&attempts.length!==1)fail(404,'SAVED_VIEW_NOT_FOUND','Lượt làm này không còn trong hồ sơ đang xem.');
 return {test:{slug:input.test,title:row.test_title},student:{ref:input.student,name:row.student_name},attempts,
  ...(compact?{format:'saved-progress-'+input.mode+'-v1'}:{})};
}

export function mountTeacherSavedProgress(app,{pool,authenticate,limiter}){
 const schema=z.object({class:z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  test:z.enum(['term-test-1-k56','term-test-2-k56','mini-test-k56']),student:z.uuid(),
  mode:z.enum(['index','view']).optional(),viewId:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()
  .refine(value=>value.mode==='view'?Boolean(value.viewId):value.viewId===undefined);
 app.get('/api/term-tests/teacher/saved-progress',limiter,authenticate,async(req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  const parsed=schema.safeParse(req.query);if(!parsed.success)return res.status(400).json({ok:false,error:'INVALID_QUERY',message:'Yêu cầu xem tiến trình không hợp lệ.'});
  try{res.json({ok:true,...await readTeacherSavedProgress(pool,parsed.data,req)});}
  catch(error){if(error.status||error.httpStatus)return res.status(error.status||error.httpStatus).json({ok:false,error:error.code,message:error.message});next(error);}
 });
}
