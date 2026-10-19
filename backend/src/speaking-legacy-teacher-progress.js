import {SpeakingHomeworkError} from './speaking-homework.js';

// Đọc kho Speaking cũ bằng quyền Google + lớp hiện hành. Không dùng open/start/finish.
// ID có tiền tố để không ghép nhầm lượt cũ với lượt của bộ xử lý độc lập.
export function createLegacySpeakingTeacherProgress({pool,source}) {
 const fail=(code,message,status=403)=>{throw new SpeakingHomeworkError(code,message,status);};
 async function authorize(classId,reviewer){
  if(!await source.teacher({classId:String(classId),reviewer}))fail('TEACHER_ACCESS_DENIED','Tài khoản chưa có quyền xem lớp này.');
 }
 async function entry({assignmentCode,documentId},reviewer){
  const {rows}=await pool.query(`SELECT a.class_id,a.course_id,c.erp_class_name_snapshot AS class_code,d.student_ref,s.id AS unit_id
    FROM speaking_homework.assignment_document d
    JOIN speaking_homework.assignment a ON a.id=d.assignment_id
    JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=a.class_id
    LEFT JOIN speaking_homework.access_grant g ON g.assignment_id=a.id AND g.document_id=d.document_id
      AND g.student_ref=d.student_ref AND g.revoked_at IS NULL
    LEFT JOIN speaking_homework.submission s ON s.access_grant_id=g.id
    WHERE d.document_id=$1 AND a.assignment_code=$2`,[documentId,assignmentCode]);
  if(!rows.length)return {entry:null};
  const first=rows[0];await authorize(first.class_id,reviewer);
  const context=await source.context({assignmentCode,classCode:first.class_code});
  if(String(context.scope.course_id)!==String(first.course_id))fail('TEACHER_ACCESS_DENIED','Nguồn lớp đã thay đổi; hãy kiểm tra lại bài.');
  return {entry:{code:assignmentCode,classId:String(first.class_id),classCode:first.class_code,studentRef:first.student_ref,
    documentId,unitIds:[...new Set(rows.filter(r=>r.unit_id).map(r=>'legacy_'+r.unit_id))]}};
 }
 async function students({assignmentCode,classCode},reviewer){
  const context=await source.context({assignmentCode,classCode});await authorize(context.scope.class_id,reviewer);
  const {rows}=await pool.query(`SELECT s.id,s.status,s.submitted_at,g.student_ref,g.document_id,
    m.erp_student_name_snapshot AS student_name,r.id AS receipt_id,
    progress.link_count,progress.accepted_count,progress.saved_at
    FROM speaking_homework.submission s
    JOIN speaking_homework.access_grant g ON g.id=s.access_grant_id AND g.revoked_at IS NULL
    JOIN speaking_homework.assignment a ON a.id=g.assignment_id
    JOIN mapping.student_mapping_review m ON m.public_id=g.student_ref AND m.erp_course_class_id=a.class_id
    LEFT JOIN speaking_homework.receipt r ON r.submission_id=s.id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS link_count,count(*) FILTER(WHERE status='accepted')::int AS accepted_count,max(created_at) AS saved_at
      FROM (
        (SELECT DISTINCT ON(part) check_status AS status,created_at FROM speaking_homework.submission_link
         WHERE submission_id=s.id ORDER BY part,revision DESC)
        UNION ALL
        (SELECT DISTINCT ON(slot) status,submitted_at AS created_at FROM speaking_homework.practice_link
         WHERE access_grant_id=g.id ORDER BY slot,revision DESC)
      ) latest
    ) progress ON true
    WHERE a.class_id=$1 AND a.course_id=$2 AND a.assignment_code=$3
    ORDER BY s.created_at,s.id`,[context.scope.class_id,context.scope.course_id,assignmentCode]);
  const roster=new Map();
  for(const member of [...(context.selectionStudents||[]),...(context.students||[])])roster.set(member.student_ref,{studentRef:member.student_ref,name:member.name,active:true,units:[]});
  for(const row of rows){
   if(!roster.has(row.student_ref))roster.set(row.student_ref,{studentRef:row.student_ref,name:row.student_name,active:false,units:[]});
   roster.get(row.student_ref).units.push({id:'legacy_'+row.id,intakeMode:'legacy',status:row.status,submittedAt:row.submitted_at,
     documentId:row.document_id,receiptId:row.receipt_id,savedAt:row.saved_at,sentLinks:Number(row.link_count||0),acceptedLinks:Number(row.accepted_count||0)});
  }
  return {students:[...roster.values()]};
 }
 async function detail({id},reviewer){
  const {rows:[unit]}=await pool.query(`SELECT s.id,s.status,s.submitted_at,g.id AS grant_id,g.student_ref,g.document_id,
    a.assignment_code,a.title,a.class_id,a.course_id,a.required_practice_count,
    c.erp_class_name_snapshot AS class_code,m.erp_student_name_snapshot AS student_name,r.id AS receipt_id
    FROM speaking_homework.submission s
    JOIN speaking_homework.access_grant g ON g.id=s.access_grant_id AND g.revoked_at IS NULL
    JOIN speaking_homework.assignment a ON a.id=g.assignment_id
    JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=a.class_id
    JOIN mapping.student_mapping_review m ON m.public_id=g.student_ref AND m.erp_course_class_id=a.class_id
    LEFT JOIN speaking_homework.receipt r ON r.submission_id=s.id WHERE s.id=$1`,[id]);
  if(!unit)fail('TEACHER_WORK_NOT_FOUND','Không tìm thấy bài hoặc bạn chưa có quyền xem.',404);
  await authorize(unit.class_id,reviewer);
  const context=await source.context({assignmentCode:unit.assignment_code,classCode:unit.class_code});
  if(String(context.scope.course_id)!==String(unit.course_id))fail('TEACHER_ACCESS_DENIED','Nguồn lớp đã thay đổi; hãy kiểm tra lại bài.');
  const {rows:parts}=await pool.query(`SELECT part_key,display_title,min_questions FROM speaking_homework.assignment_part
    WHERE assignment_id=(SELECT assignment_id FROM speaking_homework.access_grant WHERE id=$1) ORDER BY position`,[unit.grant_id]);
  const {rows:main}=await pool.query(`SELECT DISTINCT ON(part) part,share_url,check_status,check_code,question_count,checked_at,created_at,revision
    FROM speaking_homework.submission_link WHERE submission_id=$1 ORDER BY part,revision DESC`,[id]);
  const {rows:practice}=await pool.query(`SELECT DISTINCT ON(p.slot) p.slot,p.share_url,p.status,p.check_code,p.question_count,p.checked_at,p.submitted_at AS created_at,p.revision,e.title
    FROM speaking_homework.practice_link p JOIN speaking_homework.doctor_exercise e ON e.id=p.exercise_id
    WHERE p.access_grant_id=$1 ORDER BY p.slot,p.revision DESC`,[unit.grant_id]);
  const {rows:jobs}=await pool.query(`SELECT o.kind,o.status FROM speaking_homework.outbox o
    JOIN speaking_homework.receipt r ON r.id=o.receipt_id WHERE r.submission_id=$1 ORDER BY o.created_at,o.id`,[id]);
  const links=[...main.map(l=>({kind:'main',part:l.part,url:l.share_url,status:l.check_status,checkCode:l.check_code,questionCount:l.question_count,checkedAt:l.checked_at,savedAt:l.created_at,revision:l.revision})),
    ...practice.map(l=>({kind:'practice',part:'practice_'+l.slot,slot:l.slot,title:l.title,url:l.share_url,status:l.status,checkCode:l.check_code,questionCount:l.question_count,checkedAt:l.checked_at,savedAt:l.created_at,revision:l.revision}))];
  return {id:'legacy_'+unit.id,intakeMode:'legacy',status:unit.status,submittedAt:unit.submitted_at,receiptId:unit.receipt_id,documentId:unit.document_id,
    savedAt:links.map(l=>l.savedAt).filter(Boolean).sort((a,b)=>new Date(b)-new Date(a))[0]||null,
    student:{studentRef:unit.student_ref,name:unit.student_name,classCode:unit.class_code},
    assignment:{code:unit.assignment_code,title:unit.title,parts,requiredPracticeCount:unit.required_practice_count},links,processing:jobs};
 }
 return {students,detail,entry};
}
