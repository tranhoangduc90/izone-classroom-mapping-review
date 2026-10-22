// Nhận phiếu và giảng viên đã xác thực; gia hạn/thu hồi nguyên tử, chống sửa đè và thao tác trùng.
// Bài làm, nháp, mốc khóa gốc và điểm danh không bị xóa. Lỗi giữ nguyên trạng thái trước giao dịch.
import {withTransaction} from './db.js';
import {buildLearningClassAccessPredicate} from './learning-sql.js';
import {FormAuthoringError} from './learning-form-authoring.js';
import {submissionWindowFromRow} from './learning-submission-deadline.js';
const fail=(code,message,status=409)=>new FormAuthoringError(code,message,[],status);
const access=buildLearningClassAccessPredicate({reviewerEmailSql:'$2',classIdSql:'assignment.erp_course_class_id'});
const snapshot=row=>({status:row.status,closesAt:row.closes_at,extensionClosesAt:row.extension_closes_at,
  revision:Number(row.management_revision),withdrawnAt:row.withdrawn_at||null});
export function createLearningAssignmentManagement({pool}) {
  async function authorized(db,assignmentId,reviewer,lock=false){
    const result=await db.query(`SELECT assignment.*,clock_timestamp() AS server_now FROM learning.form_assignment assignment
      WHERE assignment.id=$1::uuid AND ($3::boolean OR ${access})${lock?' FOR UPDATE OF assignment':''}`,
      [assignmentId,reviewer.email,reviewer.canAccessAllClasses===true]);
    if(result.rowCount!==1)throw fail('ASSIGNMENT_ACCESS_DENIED','Không tìm thấy phiếu trong lớp bạn được cấp quyền.',403);
    return result.rows[0];
  }
  return {
    async get({assignmentId,reviewer}){
      const row=await authorized(pool,assignmentId,reviewer);
      const history=(await pool.query(`SELECT revision,action,reason,actor_email,after_state,created_at
        FROM learning.assignment_management_event WHERE assignment_id=$1::uuid ORDER BY revision DESC`,[assignmentId])).rows;
      return {...snapshot(row),assignmentId,history};
    },
    async history({classId,reviewer}){
      const predicate=buildLearningClassAccessPredicate({reviewerEmailSql:'$2',classIdSql:'assignment.erp_course_class_id'});
      const result=await pool.query(`SELECT assignment.id::text AS "assignmentId",assignment.session_number AS "sessionNumber",
        assignment.title,assignment.withdrawn_at AS "withdrawnAt",assignment.withdrawal_reason AS reason,
        (SELECT count(*)::int FROM learning.submission s WHERE s.assignment_id=assignment.id) AS "submissionCount",
        (SELECT count(*)::int FROM learning.attempt t WHERE t.assignment_id=assignment.id AND t.status='active') AS "draftCount"
        FROM learning.form_assignment assignment WHERE assignment.erp_course_class_id=$1::bigint AND assignment.status='retired'
        AND ($3::boolean OR ${predicate}) ORDER BY assignment.withdrawn_at DESC NULLS LAST,assignment.created_at DESC LIMIT 100`,
        [classId,reviewer.email,reviewer.canAccessAllClasses===true]);
      return result.rows;
    },
    async change({assignmentId,action,reason,closesAt,expectedRevision,operationId,reviewer}){
      if(!['extend','withdraw'].includes(action)||typeof reason!=='string'||!reason.trim()||reason.length>1000)
        throw fail('MANAGEMENT_INPUT_INVALID','Cần chọn thao tác và nhập lý do, tối đa 1.000 ký tự.',400);
      return withTransaction(pool,async db=>{
        const row=await authorized(db,assignmentId,reviewer,true);
        const prior=(await db.query('SELECT * FROM learning.assignment_management_event WHERE operation_id=$1::uuid',[operationId])).rows[0];
        if(prior){
          if(prior.assignment_id!==assignmentId||prior.action!==action||prior.reason!==reason.trim()
            ||(action==='extend'&&Date.parse(prior.after_state.extensionClosesAt)!==Date.parse(closesAt)))
            throw fail('MANAGEMENT_OPERATION_CONFLICT','Mã thao tác đã dùng cho thay đổi khác.');
          return {...snapshot(row),assignmentId,replayed:true};
        }
        if(Number(row.management_revision)!==expectedRevision)throw fail('MANAGEMENT_STALE','Phiếu vừa được người khác thay đổi; tải lại để đối chiếu.');
        if(!['published','closed'].includes(row.status))throw fail('ASSIGNMENT_WITHDRAWN','Phiếu đã thu hồi; chỉ xem lại lịch sử.');
        const before=snapshot(row);
        if(action==='extend'){
          if(typeof closesAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/u.test(closesAt)||!Number.isFinite(Date.parse(closesAt)))
            throw fail('EXTENSION_TIME_INVALID','Thời điểm gia hạn chưa hợp lệ.',400);
          const limit=Date.parse(closesAt),now=Date.parse(row.server_now),window=submissionWindowFromRow({...row,complete_students:0});
          if(limit<=now||(window.effectiveClosesAt&&limit<=Date.parse(window.effectiveClosesAt)))
            throw fail('EXTENSION_NOT_LATER','Hạn mới phải ở tương lai và sau hạn hiện tại.',400);
          await db.query(`UPDATE learning.form_assignment SET extension_closes_at=$2::timestamptz,closes_at=$2::timestamptz,
            status='published',management_revision=management_revision+1,updated_at=now() WHERE id=$1::uuid`,[assignmentId,closesAt]);
        }else{
          await db.query(`UPDATE learning.form_assignment SET status='retired',withdrawn_at=now(),withdrawn_by_email=$2,
            withdrawal_reason=$3,management_revision=management_revision+1,updated_at=now() WHERE id=$1::uuid`,[assignmentId,reviewer.email,reason.trim()]);
        }
        const updated=await authorized(db,assignmentId,reviewer);
        await db.query(`INSERT INTO learning.assignment_management_event(operation_id,assignment_id,revision,action,reason,actor_email,before_state,after_state)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,[operationId,assignmentId,updated.management_revision,action,
          reason.trim(),reviewer.email,JSON.stringify(before),JSON.stringify(snapshot(updated))]);
        return {...snapshot(updated),assignmentId,replayed:false};
      });
    }
  };
}
