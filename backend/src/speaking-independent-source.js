import { createHash } from 'node:crypto';
import { SpeakingHomeworkError } from './speaking-homework.js';
import { buildTeacherClassAccessPredicate } from './teacher-class-access-sql.js';

const active = `m.status='approved' AND m.classroom_user_id IS NOT NULL AND EXISTS
  (SELECT 1 FROM mapping.erp_class_membership_snapshot e
   WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
     AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold'))`;

// Đầu vào: mã bài đã có trong catalogue và lớp/hồ sơ được đối soát.
// Đọc nguồn hiện hành để đường mới không phải có bài giao Classroom. Không sửa lịch sử.
// Trả mẫu, danh sách và quyền xem; mã cũ hoặc lớp chưa duyệt bị từ chối.
export function createIndependentSource({ pool, independentBase='', workerSecret='', call=fetch }) {
  async function template(code) {
    const { rows } = await pool.query(`SELECT * FROM speaking_homework.assignment_template
      WHERE assignment_code=$1 AND course_key='67' AND active`, [code]);
    const t = rows[0];
    const lesson = t?.assignment_code === '67-speaking-paraphrase' && t.page_path === 'index.html' ? 2 : Number(/^lesson-(\d+)\.html$/.exec(t?.page_path || '')?.[1]);
    if (!t || !Number.isInteger(lesson) || lesson < 2)
      throw new SpeakingHomeworkError('UNSUPPORTED_ASSIGNMENT', 'Mã bài Speaking chưa được hỗ trợ trong danh mục khóa 67.', 404);
    const value = { assignmentCode:t.assignment_code, title:t.title, parts:t.parts,
      requiredPracticeCount:t.required_practice_count, doctorEnabled:Boolean(t.doctor_course_key), lesson };
    return { ...value, digest:createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  }
  async function classes(code) {
    await template(code);
    const { rows } = await pool.query(`SELECT s.class_id,s.class_code,c.classroom_course_id AS course_id
      FROM speaking_homework.class_scope s JOIN mapping.classroom_course_mapping c
      ON c.erp_course_class_id=s.class_id AND c.status='approved'
        AND upper(trim(c.erp_class_name_snapshot))=upper(s.class_code)
      WHERE s.course_key='67' AND s.active ORDER BY s.class_code`);
    return rows;
  }
  async function context({ assignmentCode, classCode, studentRef }) {
    let t = await template(assignmentCode);
    const all = await classes(assignmentCode);
    const { rows:exercises } = await pool.query(`SELECT id,title,exercise_url
      FROM speaking_homework.doctor_exercise WHERE active AND course_key='67' ORDER BY id`);
    if (!classCode) return { template:t, classes:all, exercises };
    const scope = all.find(c => c.class_code === classCode);
    if (!scope) throw new SpeakingHomeworkError('CLASS_SCOPE_INVALID','Lớp chưa được đối soát cho khóa 67.',403);
    // Ngưỡng đã giao riêng cho lớp được kế thừa, không tự áp lại mẫu chung.
    if (t.lesson < 6) {
      const { rows:assigned } = await pool.query(`SELECT id,status,required_practice_count,doctor_course_key
        FROM speaking_homework.assignment WHERE class_id=$1 AND course_id=$2
          AND assignment_code=$3`,[scope.class_id,scope.course_id,assignmentCode]);
      if(assigned.length>1) throw new SpeakingHomeworkError('ASSIGNMENT_AMBIGUOUS','Có nhiều bài cùng mã; cần giảng viên đối chiếu.',409);
      if(assigned.length===1) {
        const {rows:parts}=await pool.query(`SELECT part_key,display_title,practice_url,min_questions,position
          FROM speaking_homework.assignment_part WHERE assignment_id=$1 ORDER BY position`,[assigned[0].id]);
        if(parts.length!==t.parts.length || parts.some(p=>!t.parts.some(q=>q.part_key===p.part_key)))
          throw new SpeakingHomeworkError('ASSIGNMENT_CONFIGURATION_CONFLICT','Cấu hình bài đã giao chưa khớp mẫu; cần giảng viên kiểm tra.',409);
        const value={...t,parts,requiredPracticeCount:assigned[0].required_practice_count,doctorEnabled:Boolean(assigned[0].doctor_course_key)};
        delete value.digest;t={...value,assignmentStatus:assigned[0].status||'open',digest:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
      }
    }
    const { rows:students } = await pool.query(`SELECT m.public_id AS student_ref,
      m.erp_student_name_snapshot AS name,m.classroom_user_id AS google_user_id
      FROM mapping.student_mapping_review m WHERE m.erp_course_class_id=$1 AND ${active}
      ORDER BY m.erp_student_name_snapshot,m.public_id`,[scope.class_id]);
    const member = studentRef ? students.find(s => s.student_ref === studentRef) : null;
    if (studentRef && !member) throw new SpeakingHomeworkError('STUDENT_NOT_ACTIVE','Hồ sơ này chưa có đăng ký hợp lệ trong lớp.',403);
    // Danh sách tự chọn lấy tên ERP của lớp đang học, kể cả tài khoản chưa duyệt.
    // Giữ students/member ở trên chỉ gồm mapping approved cho luồng xác nhận nguồn.
    const selectionStudents = studentRef ? [] : (await pool.query(`SELECT m.public_id AS student_ref,
      m.erp_student_name_snapshot AS name FROM mapping.student_mapping_review m
      WHERE m.erp_course_class_id=$1 AND EXISTS
        (SELECT 1 FROM mapping.erp_class_membership_snapshot e
         WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
           AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold'))
      ORDER BY m.erp_student_name_snapshot,m.public_id`,[scope.class_id])).rows;
    const recommendations = member ? (await pool.query(`SELECT exercise_id,recommendation_count,practice_count,
      waiting,proposed_at,last_practiced_at FROM speaking_homework.doctor_recommendation
      WHERE class_id=$1 AND student_ref=$2`,[scope.class_id,studentRef])).rows : [];
    const excludedStudents=(await pool.query(`SELECT m.classroom_user_id AS google_user_id
      FROM mapping.student_mapping_review m WHERE m.erp_course_class_id=$1
        AND m.status='approved' AND m.classroom_user_id IS NOT NULL AND NOT(${active})`,[scope.class_id])).rows;
    return { template:t, scope, students, selectionStudents, excludedStudents, member, exercises, recommendations };
  }
  async function teacher({ classId, reviewer }) {
    if (reviewer.canAccessAllClasses) return true;
    if (!classId || classId==='unlinked') return false;
    const allowed = buildTeacherClassAccessPredicate({reviewerEmailSql:'$2',classIdSql:'c.erp_course_class_id'});
    const { rows }=await pool.query(`SELECT 1 FROM mapping.classroom_course_mapping c
      WHERE c.erp_course_class_id=$1 AND ${allowed}`,[classId,reviewer.email]);
    return rows.length === 1;
  }
  async function scopes() {
    if(!independentBase) return [];
    return sourceRows(`SELECT course_id,course_work_id,assignment_code,class_code,observed_at AS opened_at,
      'docs_cta' AS delivery_mode FROM speaking_independent.route_source WHERE state='PUBLISHED'`);
  }
  async function sourceRows(sql,params=[]) {
    try{return (await pool.query(sql,params)).rows;}
    catch(e){if(e.code==='42P01')return [];throw e;}
  }
  async function forward(req,res,next) {
    if(!independentBase) return next();
    let independent=false;
    if(req.path==='/internal/assignments/register') {
      try {
        const t=await template(req.body.assignmentCode);
        // Nguồn mới đi theo bài web; nguồn đã đăng ký giữ ID và lịch sử cũ.
        independent=t.lesson>=6 || !(await pool.query(`SELECT 1 FROM speaking_homework.assignment
          WHERE course_id=$1 AND (course_work_id=$2 OR assignment_code=$3)`,
          [req.body.courseId,req.body.courseWorkId,req.body.assignmentCode])).rows.length;
      }
      catch(e){if(e.code!=='UNSUPPORTED_ASSIGNMENT')throw e;}
    } else if(req.path.startsWith('/internal/classroom-copies/')) {
      const b=req.body;
      if(b.documentId) independent=(await sourceRows('SELECT 1 FROM speaking_independent.route_document WHERE document_id=$1',[b.documentId])).length>0;
      else independent=(await sourceRows('SELECT 1 FROM speaking_independent.route_source WHERE course_id=$1 AND course_work_id=$2',[b.courseId,b.courseWorkId])).length>0;
    } else if(req.path.startsWith('/internal/alerts/')) {
      const b=req.body;
      if(b.batchId) independent=(await sourceRows('SELECT 1 FROM speaking_independent.route_alert WHERE batch_id=$1',[b.batchId])).length>0;
      else independent=(await sourceRows('SELECT 1 FROM speaking_independent.route_source WHERE course_id=$1 AND course_work_id=$2',[b.courseId,b.courseWorkId])).length>0;
    }
    if(!independent) return next();
    const response=await call(independentBase.replace(/\/$/,'')+req.path,{method:req.method,
      headers:{'content-type':'application/json','x-speaking-worker-secret':workerSecret},body:JSON.stringify(req.body),signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    res.status(response.status).json(data);
  }
  return { context, teacher, scopes, forward };
}
