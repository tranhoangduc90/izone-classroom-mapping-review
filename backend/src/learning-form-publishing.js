// Nhận nháp đã lưu và người duyệt: kiểm lại quyền lớp/khóa, revision và đáp án.
// Phát hành trong một giao dịch có khóa lớp; lỗi giữ nguyên nháp và không tạo phiếu dở dang.
import {withTransaction} from './db.js';
import {validateAuthoringPayload,FormAuthoringError} from './learning-form-authoring.js';
import {sha256,stableStringify} from './learning-domain.js';
import {fetchCourseCurrentRosterSql} from './learning-course-overview.js';
import {insertLearningAssignmentSql,insertLearningAssignmentRosterSql,
  insertLearningAssignmentBlockReleaseSql,fetchLearningRosterForClassSql} from './learning-sql.js';

const fail=(code,message,status=409)=>new FormAuthoringError(code,message,[],status);
const scored=definition=>definition.blocks.some(block=>block.items.some(item=>item.graderType!=='none'||item.maxScore>0));

export function createLearningFormPublishingService({pool,authorizeClass,owned,dto}) {
  async function authority(database,email,definition,ownerEmail) {
    if(!scored(definition)) return email.toLowerCase()===ownerEmail.toLowerCase();
    if(!definition.courseCode) return false;
    const result=await database.query(`SELECT authority.can_self_approve_scored_forms FROM learning.course_content_authority AS authority
      JOIN mapping.reviewer_account AS account ON lower(account.email)=lower(authority.reviewer_email) AND account.status='active'
      WHERE lower(authority.reviewer_email)=lower($1) AND authority.course_code=$2 AND authority.status='active';`,[email,definition.courseCode]);
    return result.rowCount===1&&(email.toLowerCase()!==ownerEmail.toLowerCase()||result.rows[0].can_self_approve_scored_forms===true);
  }
  async function reviewable(database,id,reviewer,{lock=false}={}) {
    const result=await database.query(`SELECT * FROM learning.form_draft WHERE id=$1::uuid${lock?' FOR UPDATE':''};`,[id]);
    const row=result.rows[0];
    if(!row) throw fail('DRAFT_NOT_FOUND','Không tìm thấy nháp.',404);
    await authorizeClass(database,row.erp_course_class_id,reviewer);
    if(row.owner_email.toLowerCase()!==reviewer.email.toLowerCase()
      &&(!['pending_review','approved'].includes(row.status)||!await authority(database,reviewer.email,row.public_definition,row.owner_email))) {
      throw fail('DRAFT_REVIEW_ACCESS_DENIED','Bạn chưa được cấp quyền duyệt nháp này.',403);
    }
    return row;
  }
  async function assertCourse(database,row) {
    const classes=await database.query(`SELECT DISTINCT course_code FROM learning.form_assignment
      WHERE erp_course_class_id=$1::bigint AND status IN ('published','closed') AND course_code IS NOT NULL AND course_code<>'';`,[row.erp_course_class_id]);
    if(classes.rows.some(existing=>existing.course_code!==row.public_definition.courseCode)) {
      throw fail('DRAFT_COURSE_MISMATCH','Khóa của nháp khác các phiếu đã gán cho lớp. Hãy đối chiếu trước khi duyệt.');
    }
  }
  async function published(database,row,{replayed=false}={}) {
    const result=await database.query(`SELECT assignment.id::text AS assignment_id,assignment.public_token::text,
      assignment.form_version_id::text,version.definition_hash,version.public_definition,grading.content_hash AS grading_hash,
      (SELECT count(*)::integer FROM learning.form_assignment_roster WHERE assignment_id=assignment.id) AS roster_count,
      (SELECT count(*)::integer FROM learning.assignment_block_release WHERE assignment_id=assignment.id) AS block_count
      FROM learning.form_assignment AS assignment JOIN learning.form_version AS version ON version.id=assignment.form_version_id
      JOIN learning.form_grading_key AS grading ON grading.form_version_id=version.id WHERE assignment.id=$1::uuid;`,[row.published_assignment_id]);
    const current=result.rows[0];
    if(!current||current.form_version_id!==row.public_definition.formVersionId
      ||current.definition_hash!==sha256(stableStringify(row.public_definition))
      ||current.grading_hash!==sha256(stableStringify(row.private_definition))
      ||current.roster_count<1||current.block_count!==row.public_definition.blocks.length) {
      throw fail('PUBLISH_READBACK_MISMATCH','Chưa xác nhận đủ phiên bản, đáp án và danh sách vừa phát hành.',500);
    }
    return {assignmentId:current.assignment_id,publicToken:current.public_token,formVersionId:current.form_version_id,
      definitionHash:current.definition_hash,rosterCount:current.roster_count,blockCount:current.block_count,replayed};
  }
  return {
    async reviewQueue({classId,reviewer}) {
      await authorizeClass(pool,classId,reviewer);
      const result=await pool.query(`SELECT * FROM learning.form_draft WHERE erp_course_class_id=$1::bigint
        AND status='pending_review' ORDER BY updated_at,id LIMIT 100;`,[classId]);
      const rows=[];
      for(const row of result.rows) if(await authority(pool,reviewer.email,row.public_definition,row.owner_email)) rows.push(dto(row,{includeKey:false}));
      return rows;
    },
    async getReview({id,reviewer}) {return dto(await reviewable(pool,id,reviewer));},
    async requestReview({id,expectedRevision,reviewer}) {
      return withTransaction(pool,async client=>{
        const row=await owned(client,id,reviewer,{lock:true});
        if(Number(row.revision)!==expectedRevision) throw fail('DRAFT_STALE','Nháp đã đổi; tải và đối chiếu trước khi gửi duyệt.');
        if(row.status==='published') throw fail('DRAFT_ALREADY_PUBLISHED','Phiếu đã phát hành.');
        validateAuthoringPayload({definition:row.public_definition,gradingKey:row.private_definition,requireAnswers:true});
        await assertCourse(client,row);
        const result=await client.query(`UPDATE learning.form_draft SET status='pending_review',approved_hash=NULL,
          approved_revision=NULL,approved_by_email=NULL,approved_at=NULL,updated_at=now() WHERE id=$1::uuid RETURNING *;`,[id]);
        return dto(result.rows[0]);
      });
    },
    async approve({id,expectedRevision,expectedHash,reviewer}) {
      return withTransaction(pool,async client=>{
        const row=await reviewable(client,id,reviewer,{lock:true});
        if(Number(row.revision)!==expectedRevision||row.content_hash!==expectedHash) throw fail('DRAFT_STALE','Nháp đã đổi sau khi mở bản duyệt.');
        if(row.status==='published') throw fail('DRAFT_ALREADY_PUBLISHED','Phiếu đã phát hành.');
        validateAuthoringPayload({definition:row.public_definition,gradingKey:row.private_definition,requireAnswers:true});
        if(!await authority(client,reviewer.email,row.public_definition,row.owner_email)) throw fail('DRAFT_APPROVAL_DENIED','Bạn chưa có quyền duyệt nội dung có điểm của đúng khóa.',403);
        await assertCourse(client,row);
        const result=await client.query(`UPDATE learning.form_draft SET status='approved',approved_hash=content_hash,
          approved_revision=revision,approved_by_email=$2,approved_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING *;`,[id,reviewer.email.toLowerCase()]);
        return dto(result.rows[0]);
      });
    },
    async publish({id,expectedRevision,operationId,reviewer}) {
      return withTransaction(pool,async client=>{
        const row=await owned(client,id,reviewer,{lock:true});
        if(Number(row.revision)!==expectedRevision) throw fail('DRAFT_STALE','Nháp đã đổi; cần duyệt lại trước khi phát hành.');
        if(row.status==='published') {
          if(row.publish_operation_id!==operationId) throw fail('DRAFT_ALREADY_PUBLISHED','Phiếu đã phát hành. Mở phiếu đã có hoặc sao chép để sửa.');
          return published(client,row,{replayed:true});
        }
        if(row.status!=='approved'||row.approved_revision!==row.revision||row.approved_hash!==row.content_hash) throw fail('DRAFT_APPROVAL_REQUIRED','Cần duyệt đúng bản nháp hiện tại trước khi phát hành.');
        if(!await authority(client,row.approved_by_email,row.public_definition,row.owner_email)) throw fail('DRAFT_APPROVAL_REVOKED','Quyền duyệt đã thay đổi; hãy gửi người có quyền duyệt lại.',403);
        const checked=validateAuthoringPayload({definition:row.public_definition,gradingKey:row.private_definition,requireAnswers:true});
        await assertCourse(client,row);
        const target=await authorizeClass(client,row.erp_course_class_id,reviewer);
        // Khóa một dòng lớp để hai nháp cùng buổi không vượt qua bước kiểm trùng đồng thời.
        await client.query('INSERT INTO learning.form_draft_class_lock VALUES ($1::bigint) ON CONFLICT DO NOTHING;',[row.erp_course_class_id]);
        await client.query('SELECT erp_course_class_id FROM learning.form_draft_class_lock WHERE erp_course_class_id=$1::bigint FOR UPDATE;',[row.erp_course_class_id]);
        const conflict=await client.query(`SELECT id FROM learning.form_assignment WHERE erp_course_class_id=$1::bigint
          AND session_number=$2 AND status IN ('published','closed') LIMIT 1;`,[row.erp_course_class_id,row.session_number]);
        if(conflict.rowCount) throw fail('ASSIGNMENT_SESSION_CONFLICT','Buổi này đã có phiếu. Không tạo phiếu thứ hai hoặc thay bài đã nộp.');
        const currentRoster=await client.query(fetchCourseCurrentRosterSql,[row.erp_course_class_id]);
        if(!currentRoster.rowCount||currentRoster.rows.some(student=>student.membership_verified!==true)) throw fail('DRAFT_ROSTER_UNVERIFIED','Cần đọc lại danh sách ERP của lớp trước khi phát hành phiếu.');
        const refs=new Set(currentRoster.rows.map(student=>student.student_ref));
        const roster=(await client.query(fetchLearningRosterForClassSql,[row.erp_course_class_id])).rows.filter(student=>refs.has(student.student_ref));
        if(roster.length!==refs.size) throw fail('DRAFT_ROSTER_CHANGED','Danh sách học viên cần được đối chiếu lại.');
        const definition=checked.definition,key=checked.gradingKey;
        const template=await client.query(`INSERT INTO learning.form_template(title,kind,created_by_email) VALUES ($1,$2,$3) RETURNING id;`,[definition.title,definition.kind,row.owner_email]);
        await client.query(`INSERT INTO learning.form_version(id,template_id,version,public_definition,definition_hash,status,
          created_by_email,approved_by_email,published_at) VALUES ($1::uuid,$2::uuid,1,$3::jsonb,$4,'published',$5,$6,now());`,
          [definition.formVersionId,template.rows[0].id,JSON.stringify(definition),sha256(stableStringify(definition)),row.owner_email,row.approved_by_email]);
        await client.query(`INSERT INTO learning.form_grading_key(form_version_id,schema_version,grader_version,private_definition,content_hash)
          VALUES ($1::uuid,'FormGradingKeyV1',$2,$3::jsonb,$4);`,[definition.formVersionId,key.graderVersion,JSON.stringify(key),sha256(stableStringify(key))]);
        const assignment=(await client.query(insertLearningAssignmentSql,[definition.formVersionId,definition.courseCode||null,
          row.erp_course_class_id,target.class_name,row.session_number,definition.title,null,null,row.owner_email])).rows[0];
        for(const student of roster) await client.query(insertLearningAssignmentRosterSql,[assignment.assignment_id,student.student_ref,student.student_id,student.student_name,student.display_discriminator]);
        const firstCheckpoint=Math.min(...definition.blocks.map(block=>block.checkpoint));
        for(const block of definition.blocks) await client.query(insertLearningAssignmentBlockReleaseSql,[assignment.assignment_id,
          block.blockId,block.checkpoint,block.checkpoint===firstCheckpoint?'open':'locked',reviewer.email]);
        const saved=await client.query(`UPDATE learning.form_draft SET status='published',published_assignment_id=$2::uuid,
          publish_operation_id=$3::uuid,updated_at=now() WHERE id=$1::uuid RETURNING *;`,[id,assignment.assignment_id,operationId]);
        return published(client,saved.rows[0]);
      }).catch(error=>{
        if(error.code==='23505')throw fail('DRAFT_PUBLISH_CONFLICT','Mã thao tác hoặc phiên bản đã được dùng. Mở phiếu đã có hoặc tạo bản sao mới.');
        throw error;
      });
    }
  };
}
