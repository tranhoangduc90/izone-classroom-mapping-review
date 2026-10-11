import { SpeakingHomeworkError } from './speaking-homework.js';

// Đầu vào là lớp, UUID và mã đã kiểm từ nguồn hiện hành. Bài/Docs cũ có thật
// tiếp tục dùng phiên và biên nhận cũ; chưa có bản sẵn sàng thì nhận trên web.
// Khi nhiều đích hoặc có tiến độ không giải được, báo lỗi và giữ cả lịch sử.
export function createSpeakingLegacyBridge({pool,source,catalog,service}) {
  const fail=(code,message)=>{throw new SpeakingHomeworkError(code,message,409);};
  async function known(input) {
    return (await pool.query(`SELECT a.assignment_code FROM speaking_homework.assignment_document d
      JOIN speaking_homework.assignment a ON a.id=d.assignment_id WHERE d.document_id=$1`,[input.documentId])).rows;
  }
  async function open(input) {
    const rows=await known(input);
    if(!rows.length)return null;
    if(rows.length!==1||rows[0].assignment_code!==input.assignmentCode)
      fail('DOCUMENT_ASSIGNMENT_MISMATCH','File Homework không khớp mã bài đang mở.');
    return service.openAssignment(input);
  }
  async function start(input) {
    const c=await source.context(input);
    if(c.template.lesson>=6)return null;
    if(!c.member)fail('STUDENT_NOT_ACTIVE','Chọn đúng người đang học trong lớp.');
    if(input.documentId) {
      const assignment=await open(input);
      if(!assignment)return null;
      const session=await catalog.startSelected(input);
      return {...session,intakeMode:'legacy'};
    }
    // Giữ bài đã có tiến độ kể cả khi đích Docs chưa được xác minh lại.
    const {rows:progress}=await pool.query(`SELECT DISTINCT g.document_id FROM speaking_homework.access_grant g
      JOIN speaking_homework.assignment a ON a.id=g.assignment_id
      JOIN speaking_homework.submission s ON s.access_grant_id=g.id
      WHERE a.class_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND g.student_ref=$4
        AND g.revoked_at IS NULL AND (s.status='submitted' OR EXISTS
          (SELECT 1 FROM speaking_homework.submission_link l WHERE l.submission_id=s.id))`,
    [c.scope.class_id,c.scope.course_id,input.assignmentCode,input.studentRef]);
    if(progress.length>1)fail('LEGACY_PROGRESS_CONFLICT','Có nhiều bài cũ cùng hồ sơ. Hãy mở từ đúng file Homework để tiếp tục.');
    if(progress.length===1) {
      const session=await catalog.startSelected({...input,documentId:progress[0].document_id});
      return {...session,intakeMode:'legacy'};
    }
    const {rows:docs}=await pool.query(`SELECT d.document_id FROM speaking_homework.assignment_document d
      JOIN speaking_homework.assignment a ON a.id=d.assignment_id
      WHERE a.class_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND a.status='open'
        AND d.student_ref=$4 AND d.classroom_submission_id IS NOT NULL
        AND (a.delivery_mode='direct' OR d.cta_verified_at IS NOT NULL)`,
    [c.scope.class_id,c.scope.course_id,input.assignmentCode,input.studentRef]);
    if(docs.length>1)fail('STUDENT_DOCUMENT_AMBIGUOUS','Có nhiều file Homework; cần mở từ đúng file hoặc nhờ giảng viên đối chiếu.');
    if(!docs.length)return null;
    const session=await catalog.startSelected({...input,documentId:docs[0].document_id});
    return {...session,intakeMode:'legacy'};
  }
  return {open,start};
}
