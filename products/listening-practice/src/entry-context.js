// Chỉ đọc registry đã được đối chiếu Classroom. Document ID là ngữ cảnh, không phải quyền.
export function createEntryContext({pool,context,schema,fail,lessonFor,resolveCurrentOwner}) {
 async function resolve({documentId,code}) {
  const rows=(await pool.query(`SELECT b.*,a.class_id,a.class_code,c.code,c.version
   FROM ${schema}.binding b JOIN ${schema}.assignment a ON a.id=b.assignment_id
   JOIN ${schema}.content c ON c.id=a.content_id
   WHERE c.code=$2 AND (b.document_id=$1 OR b.owner_proof->'homework'->>'documentId'=$1)`,[documentId,code])).rows;
  if(rows.length!==1)fail('ENTRY_NOT_VERIFIED','Link cá nhân chưa có duy nhất hồ sơ chủ bài đã đối chiếu.',403);
  const b=rows[0],proof=b.document_id?b.owner_proof:b.owner_proof?.homework;
  if(!proof?.verifiedAt||proof.documentId!==documentId||proof.code!==code||!proof.courseId||!proof.courseWorkId||!proof.submissionId||!proof.googleUserId
    ||(!b.document_id&&(proof.classId!==b.class_id||proof.studentRef!==b.student_ref)))
   fail('ENTRY_NOT_VERIFIED','Hồ sơ chủ link chưa đủ thông tin đối chiếu.',403);
  const classes=await context.classes(),selected=classes.find(c=>c.id===b.class_id&&c.classCode===b.class_code);
  const member=selected&&await context.student(b.class_id,b.student_ref);
  if(!member)fail('STUDENT_NOT_ELIGIBLE','Chủ link chưa có hồ sơ đang học hợp lệ trong lớp.',403);
  if(resolveCurrentOwner){const current=await resolveCurrentOwner({classId:b.class_id,studentRef:b.student_ref});
   if(current.courseId!==proof.courseId||current.googleUserId!==proof.googleUserId)fail('ENTRY_NOT_VERIFIED','Mapping chủ link đã đổi. Hãy nhờ giảng viên kiểm tra.',403);
  }
  return {assignmentCode:code,lesson:lessonFor(code),version:b.version,classId:b.class_id,classCode:b.class_code,
   bindingId:b.id,documentId,selectedStudentRef:b.student_ref,entryMode:b.document_id?'homework':'shared',
   students:[{id:b.student_ref,name:member.name}]};
 }
 return {resolve};
}
