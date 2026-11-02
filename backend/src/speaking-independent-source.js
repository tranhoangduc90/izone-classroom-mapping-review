import { createHash } from 'node:crypto';
import { SpeakingHomeworkError } from './speaking-homework.js';
import { buildTeacherClassAccessPredicate } from './teacher-class-access-sql.js';
import { speakingSourceScopes,speakingSourceScopeKey } from './speaking-source-batch.js';

const active = `m.status='approved' AND m.classroom_user_id IS NOT NULL AND EXISTS
  (SELECT 1 FROM mapping.erp_class_membership_snapshot e
   WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
     AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold'))`;
// Chính sách đã có trên live sau bản sửa ERP02/11; chỉ áp dụng đường web hai lớp này.
const erpClasses=['1333','1345'];
const erpWeb=(webEntry,classId)=>webEntry&&erpClasses.includes(String(classId));
const erpName=`(SELECT e.erp_student_name_snapshot FROM mapping.erp_class_membership_snapshot e
  WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id)`;
const webActive=`m.status IN ('approved','pending_review') AND EXISTS
  (SELECT 1 FROM mapping.erp_class_membership_snapshot e
   WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
     AND e.source_state='active' AND e.registration_status='on_going')`;

// Đầu vào: mã bài đã có trong catalogue và lớp/hồ sơ được đối soát.
// Đọc nguồn hiện hành để đường mới không phải có bài giao Classroom. Không sửa lịch sử.
// Trả mẫu, danh sách và quyền xem; mã cũ hoặc lớp chưa duyệt bị từ chối.
export function createIndependentSource({ pool, independentBase='', workerSecret='', call=fetch }) {
  function templateValue(t) {
    const lesson = t?.assignment_code === '67-speaking-paraphrase' && t.page_path === 'index.html' ? 2 : Number(/^lesson-(\d+)\.html$/.exec(t?.page_path || '')?.[1]);
    if (!t || !Number.isInteger(lesson) || lesson < 2)
      throw new SpeakingHomeworkError('UNSUPPORTED_ASSIGNMENT', 'Mã bài Speaking chưa được hỗ trợ trong danh mục khóa 67.', 404);
    const value = { assignmentCode:t.assignment_code, title:t.title, parts:t.parts,
      requiredPracticeCount:t.required_practice_count, doctorEnabled:Boolean(t.doctor_course_key), lesson };
    return { ...value, digest:createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  }
  async function template(code) {
    const { rows } = await pool.query(`SELECT * FROM speaking_homework.assignment_template
      WHERE assignment_code=$1 AND course_key='67' AND active`, [code]);
    return templateValue(rows[0]);
  }
  function assignedTemplate(t,assigned,parts) {
    if(assigned.length>1) throw new SpeakingHomeworkError('ASSIGNMENT_AMBIGUOUS','Có nhiều bài cùng mã; cần giảng viên đối chiếu.',409);
    if(!assigned.length)return t;
    if(parts.length!==t.parts.length || parts.some(p=>!t.parts.some(q=>q.part_key===p.part_key)))
      throw new SpeakingHomeworkError('ASSIGNMENT_CONFIGURATION_CONFLICT','Cấu hình bài đã giao chưa khớp mẫu; cần giảng viên kiểm tra.',409);
    const value={...t,parts,requiredPracticeCount:assigned[0].required_practice_count,doctorEnabled:Boolean(assigned[0].doctor_course_key)};
    delete value.digest;
    return {...value,assignmentStatus:assigned[0].status||'open',digest:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
  }
  async function classes() {
    const { rows } = await pool.query(`SELECT s.class_id,s.class_code,c.classroom_course_id AS course_id
      FROM speaking_homework.class_scope s JOIN mapping.classroom_course_mapping c
      ON c.erp_course_class_id=s.class_id AND c.status='approved'
        AND upper(trim(c.erp_class_name_snapshot))=upper(s.class_code)
      WHERE s.course_key='67' AND s.active ORDER BY s.class_code`);
    return rows;
  }
  async function context({ assignmentCode, classCode, studentRef,webEntry=false }) {
    let t = await template(assignmentCode);
    // Mẫu đã được kiểm ở trên; dùng lại trong yêu cầu này, không giữ quyền sang yêu cầu sau.
    const all = await classes();
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
      if(assigned.length>1) return assignedTemplate(t,assigned,[]);
      if(assigned.length===1) {
        const {rows:parts}=await pool.query(`SELECT part_key,display_title,practice_url,min_questions,position
          FROM speaking_homework.assignment_part WHERE assignment_id=$1 ORDER BY position`,[assigned[0].id]);
        t=assignedTemplate(t,assigned,parts);
      }
    }
    const eligibility=erpWeb(webEntry,scope.class_id)?webActive:active;
    const studentName=erpWeb(true,scope.class_id)?erpName:'m.erp_student_name_snapshot';
    const { rows:students } = await pool.query(`SELECT m.public_id AS student_ref,
      ${studentName} AS name,
      CASE WHEN m.status='approved' THEN m.classroom_user_id ELSE NULL END AS google_user_id
      FROM mapping.student_mapping_review m WHERE m.erp_course_class_id=$1 AND ${eligibility}
      ORDER BY m.erp_student_name_snapshot,m.public_id`,[scope.class_id]);
    const member = studentRef ? students.find(s => s.student_ref === studentRef) : null;
    if (studentRef && !member) throw new SpeakingHomeworkError('STUDENT_NOT_ACTIVE','Hồ sơ này chưa có đăng ký hợp lệ trong lớp.',403);
    // Danh sách tự chọn lấy tên ERP của lớp đang học, kể cả tài khoản chưa duyệt.
    // Giữ students/member ở trên chỉ gồm mapping approved cho luồng xác nhận nguồn.
    const selectionStudents = studentRef ? [] : (await pool.query(`SELECT m.public_id AS student_ref,
      ${studentName} AS name FROM mapping.student_mapping_review m
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
  async function contexts(inputs) {
    const requested=speakingSourceScopes(inputs);
    if(!requested.length)return {classes:[],exercises:[],rosters:[],entries:[]};
    const codes=[...new Set(requested.map(input=>input.assignmentCode))];
    const {rows:templates}=await pool.query(`SELECT * FROM speaking_homework.assignment_template
      WHERE assignment_code=ANY($1::text[]) AND course_key='67' AND active`,[codes]);
    const values=new Map(codes.map(code=>{try{return[code,{template:templateValue(templates.find(t=>t.assignment_code===code))}];}
      catch(error){if(!(error instanceof SpeakingHomeworkError))throw error;return[code,{error}];}}));
    const all=await classes();
    const {rows:exercises}=await pool.query(`SELECT id,title,exercise_url FROM speaking_homework.doctor_exercise
      WHERE active AND course_key='67' ORDER BY id`);
    const scoped=requested.flatMap(input=>{
      const t=values.get(input.assignmentCode).template,scope=all.find(c=>c.class_code===input.classCode);
      return t&&scope?[{assignment_code:input.assignmentCode,class_id:String(scope.class_id),course_id:scope.course_id,lesson:t.lesson}]:[];
    });
    const legacy=scoped.filter(scope=>scope.lesson<6),classIds=[...new Set(scoped.map(scope=>scope.class_id))];
    const assigned=legacy.length?(await pool.query(`SELECT a.id,a.class_id,a.course_id,a.assignment_code,a.status,a.required_practice_count,a.doctor_course_key
      FROM speaking_homework.assignment a WHERE EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb)
        AS x(assignment_code text,class_id bigint,course_id text) WHERE x.assignment_code=a.assignment_code
        AND x.class_id=a.class_id AND x.course_id=a.course_id) ORDER BY a.id`,[JSON.stringify(legacy)])).rows:[];
    const parts=assigned.length?(await pool.query(`SELECT assignment_id,part_key,display_title,practice_url,min_questions,position
      FROM speaking_homework.assignment_part WHERE assignment_id=ANY($1::uuid[]) ORDER BY assignment_id,position`,[assigned.map(a=>a.id)])).rows:[];
    // Cùng điều kiện đăng ký native. Chưa approved chỉ vào danh sách tự chọn của Docs.
    const members=classIds.length?(await pool.query(`SELECT m.erp_course_class_id AS class_id,m.public_id AS student_ref,
      CASE WHEN m.erp_course_class_id=ANY($2::bigint[]) THEN ${erpName}
        ELSE m.erp_student_name_snapshot END AS name,m.classroom_user_id AS google_user_id,m.status,
      EXISTS(SELECT 1 FROM mapping.erp_class_membership_snapshot e
        WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
          AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold')) AS eligible,
      EXISTS(SELECT 1 FROM mapping.erp_class_membership_snapshot e
        WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
          AND e.source_state='active' AND e.registration_status='on_going') AS erp_web_eligible
      FROM mapping.student_mapping_review m WHERE m.erp_course_class_id=ANY($1::bigint[])
      ORDER BY m.erp_student_name_snapshot,m.public_id`,[classIds,erpClasses])).rows:[];
    const rosters=classIds.map(classId=>{
      const rows=members.filter(row=>String(row.class_id)===classId);
      return {classId,students:rows.filter(row=>row.eligible&&row.status==='approved'&&row.google_user_id!==null)
        .map(({student_ref,name,google_user_id})=>({student_ref,name,google_user_id})),
        webStudents:rows.filter(row=>erpWeb(true,classId)
          ?row.erp_web_eligible&&['approved','pending_review'].includes(row.status)
          :row.eligible&&row.status==='approved'&&row.google_user_id!==null)
          .map(({student_ref,name,google_user_id,status})=>({student_ref,name,google_user_id:status==='approved'?google_user_id:null})),
        selectionStudents:rows.filter(row=>row.eligible).map(({student_ref,name})=>({student_ref,name})),
        excludedStudents:rows.filter(row=>!row.eligible&&row.status==='approved'&&row.google_user_id!==null)
          .map(({google_user_id})=>({google_user_id}))};
    });
    const entries=requested.map(input=>{
      const base={...input,key:speakingSourceScopeKey(input)};
      try{
        const value=values.get(input.assignmentCode);if(value.error)throw value.error;
        let t=value.template;
        if(!input.classCode)return {...base,ok:true,template:t};
        const scope=all.find(row=>row.class_code===input.classCode);
        if(!scope)throw new SpeakingHomeworkError('CLASS_SCOPE_INVALID','Lớp chưa được đối soát cho khóa 67.',403);
        if(t.lesson<6){
          const rows=assigned.filter(a=>String(a.class_id)===String(scope.class_id)&&String(a.course_id)===String(scope.course_id)&&a.assignment_code===input.assignmentCode);
          const selected=rows.length===1?parts.filter(p=>p.assignment_id===rows[0].id).map(({assignment_id,...p})=>p):[];
          t=assignedTemplate(t,rows,selected);
        }
        return {...base,ok:true,template:t,scope};
      }catch(error){
        if(!(error instanceof SpeakingHomeworkError)||error.httpStatus>=500)throw error;
        return {...base,ok:false,error:error.code,status:error.httpStatus,message:error.message};
      }
    });
    return {classes:all,exercises,rosters,entries};
  }
  async function teacher({ classId, reviewer }) {
    if (reviewer.canAccessAllClasses) return true;
    if (!classId || classId==='unlinked') return false;
    const allowed = buildTeacherClassAccessPredicate({reviewerEmailSql:'$2',classIdSql:'c.erp_course_class_id'});
    const { rows }=await pool.query(`SELECT 1 FROM mapping.classroom_course_mapping c
      WHERE c.erp_course_class_id=$1 AND ${allowed}`,[classId,reviewer.email]);
    return rows.length === 1;
  }
  async function teachers({classIds,reviewer}) {
    if(!Array.isArray(classIds)||classIds.length>1000||classIds.some(id=>typeof id!=='string'||!/^(\d+|unlinked)$/.test(id)))
      throw new SpeakingHomeworkError('INVALID_CLASS','Danh sách lớp không hợp lệ.',400);
    const ids=[...new Set(classIds)];
    if(reviewer.canAccessAllClasses)return ids;
    const numeric=ids.filter(id=>id!=='unlinked');if(!numeric.length)return [];
    const allowed=buildTeacherClassAccessPredicate({reviewerEmailSql:'$2',classIdSql:'c.erp_course_class_id'});
    const {rows}=await pool.query(`SELECT c.erp_course_class_id AS class_id FROM mapping.classroom_course_mapping c
      WHERE c.erp_course_class_id=ANY($1::bigint[]) AND ${allowed}
      GROUP BY c.erp_course_class_id HAVING count(*)=1`,[numeric,reviewer.email]);
    const matched=new Set(rows.map(row=>String(row.class_id)));
    return ids.filter(id=>matched.has(id));
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
  return { context, contexts, teacher, teachers, scopes, forward };
}
