// Nhận nháp của giảng viên đã đăng nhập: kiểm đúng chủ/lớp, revision và danh mục trước mọi lần ghi.
// Key chỉ trả vào phiên của người sở hữu; mọi save/import không tạo phiếu, roster hoặc Portal job.
import crypto from 'node:crypto';
import {sha256,stableStringify} from './learning-domain.js';
import {withTransaction} from './db.js';
import {authorizeLearningClassSql,authorizeLearningJourneyPlanAssignmentSql} from './learning-sql.js';
import {validateAuthoringPayload,copyAuthoringPayload,FormAuthoringError} from './learning-form-authoring.js';
import {previewFormImport} from './learning-form-import.js';
import {createLearningFormPublishingService} from './learning-form-publishing.js';

function error(code,message,status=409) {return new FormAuthoringError(code,message,[],status);}
function dto(row,{includeKey=true}={}) {
  return {id:row.id,classId:String(row.erp_course_class_id),sessionNumber:Number(row.session_number),
    revision:Number(row.revision),status:row.status,contentHash:row.content_hash,definition:row.public_definition,
    ...(includeKey?{gradingKey:row.private_definition}:{}),approvedRevision:row.approved_revision||null,
    updatedAt:row.updated_at,assignmentId:row.published_assignment_id||null};
}

export function createLearningFormDraftService({pool}) {
  async function authorizeClass(database,classId,reviewer) {
    const result=await database.query(authorizeLearningClassSql,[reviewer.email,reviewer.canAccessAllClasses,classId]);
    if(result.rowCount!==1) throw error('DRAFT_CLASS_ACCESS_DENIED','Bạn chưa được cấp quyền soạn phiếu cho lớp này.',403);
    return result.rows[0];
  }
  async function owned(database,id,reviewer,{lock=false}={}) {
    const result=await database.query(`SELECT * FROM learning.form_draft WHERE id=$1::uuid
      AND lower(owner_email)=lower($2)${lock?' FOR UPDATE':''};`,[id,reviewer.email]);
    if(result.rowCount!==1) throw error('DRAFT_NOT_FOUND','Không tìm thấy nháp thuộc phiên của bạn.',404);
    await authorizeClass(database,result.rows[0].erp_course_class_id,reviewer);
    return result.rows[0];
  }
  async function create({classId,sessionNumber,definition,gradingKey,operationId,sourceAssignmentId=null,reviewer}) {
    const checked=validateAuthoringPayload({definition,gradingKey});
    return withTransaction(pool,async client=>{
      await authorizeClass(client,classId,reviewer);
      const id=crypto.randomUUID();
      await client.query(`INSERT INTO learning.form_draft (id,create_operation_id,owner_email,erp_course_class_id,
        session_number,public_definition,private_definition,content_hash,source_assignment_id)
        VALUES ($1::uuid,$2::uuid,$3,$4::bigint,$5,$6::jsonb,$7::jsonb,$8,$9::uuid)
        ON CONFLICT (create_operation_id) DO NOTHING;`,[id,operationId,reviewer.email,classId,sessionNumber,
        JSON.stringify(checked.definition),JSON.stringify(checked.gradingKey),checked.contentHash,sourceAssignmentId]);
      const saved=await client.query('SELECT * FROM learning.form_draft WHERE create_operation_id=$1::uuid;',[operationId]);
      const row=saved.rows[0];
      if(!row||row.owner_email.toLowerCase()!==reviewer.email.toLowerCase()||String(row.erp_course_class_id)!==String(classId)
        ||Number(row.session_number)!==sessionNumber||row.source_assignment_id!==sourceAssignmentId
        ||(!sourceAssignmentId&&row.content_hash!==checked.contentHash)) {
        throw error('DRAFT_OPERATION_CONFLICT','Mã thao tác đã dùng cho một nháp khác.');
      }
      return {...dto(row),missingAnswers:checked.missingAnswers,replayed:row.id!==id};
    });
  }
  return {
    ...createLearningFormPublishingService({pool,authorizeClass,owned,dto}),
    create,
    async demoSource({grant}) {
      const active=await pool.query(`SELECT account.email,account.role,account.can_access_all_classes,
        EXISTS(SELECT 1 FROM learning.progress_log_admin AS admin WHERE lower(admin.reviewer_email)=lower(account.email)
          AND admin.status='active') AS progress_log_admin
        FROM mapping.reviewer_account AS account WHERE lower(account.email)=lower($1) AND account.status='active';`,[grant.ownerEmail]);
      if(active.rowCount!==1) throw error('DRAFT_PREVIEW_DENIED','Quyền xem thử đã thay đổi.',403);
      const account=active.rows[0],reviewer={email:account.email,canAccessAllClasses:
        account.role==='admin'||account.can_access_all_classes===true||account.progress_log_admin===true};
      const row=await owned(pool,grant.draftId,reviewer);
      if(Number(row.revision)!==grant.revision||row.content_hash!==grant.contentHash) throw error('DRAFT_PREVIEW_STALE','Nháp đã đổi; hãy mở lại bản xem thử.');
      const checked=validateAuthoringPayload({definition:row.public_definition,gradingKey:row.private_definition});
      const target=await authorizeClass(pool,row.erp_course_class_id,reviewer);
      return {sourceDraftId:row.id,sourceRevision:Number(row.revision),contentHash:row.content_hash,
        sourceAssignmentId:null,className:target.class_name,courseCode:checked.definition.courseCode||null,
        sessionNumber:Number(row.session_number),title:checked.definition.title,definitionHash:sha256(stableStringify(checked.definition)),
        definition:checked.definition,gradingKey:checked.gradingKey,blockReleases:[],answerReleaseOverride:null};
    },
    async list({classId,reviewer}) {
      await authorizeClass(pool,classId,reviewer);
      const result=await pool.query(`SELECT id,erp_course_class_id,session_number,revision,status,content_hash,
        public_definition->>'title' AS title,updated_at FROM learning.form_draft
        WHERE erp_course_class_id=$1::bigint AND lower(owner_email)=lower($2) ORDER BY updated_at DESC,id LIMIT 100;`,[classId,reviewer.email]);
      return result.rows.map(row=>({id:row.id,classId:String(row.erp_course_class_id),sessionNumber:Number(row.session_number),
        revision:Number(row.revision),status:row.status,title:row.title,updatedAt:row.updated_at}));
    },
    async get({id,reviewer}) {
      const row=await owned(pool,id,reviewer),value=dto(row);
      if(row.status==='published') {
        const assignment=await pool.query('SELECT public_token::text FROM learning.form_assignment WHERE id=$1::uuid;',[row.published_assignment_id]);
        value.publicToken=assignment.rows[0]?.public_token||null;
      }
      return value;
    },
    async save({id,expectedRevision,sessionNumber,definition,gradingKey,reviewer}) {
      const checked=validateAuthoringPayload({definition,gradingKey});
      return withTransaction(pool,async client=>{
        const row=await owned(client,id,reviewer,{lock:true});
        if(row.status==='published') throw error('DRAFT_ALREADY_PUBLISHED','Phiếu đã phát hành; hãy sao chép thành nháp mới.');
        if(definition.formVersionId!==row.public_definition.formVersionId) throw error('DRAFT_VERSION_CHANGED','Không đổi ID phiên bản của nháp đang sửa.');
        if(Number(row.revision)===expectedRevision+1&&row.content_hash===checked.contentHash&&Number(row.session_number)===sessionNumber) {
          return {...dto(row),missingAnswers:checked.missingAnswers,replayed:true};
        }
        if(Number(row.revision)!==expectedRevision) throw error('DRAFT_STALE','Nháp đã được lưu ở tab khác. Bản đang soạn chưa được ghi đè; hãy đối chiếu phiên bản mới.');
        const saved=await client.query(`UPDATE learning.form_draft SET public_definition=$2::jsonb,
          private_definition=$3::jsonb,content_hash=$4,session_number=$5,revision=revision+1,status='draft',
          approved_hash=NULL,approved_revision=NULL,approved_by_email=NULL,approved_at=NULL,updated_at=now()
          WHERE id=$1::uuid AND revision=$6 RETURNING *;`,[id,JSON.stringify(checked.definition),JSON.stringify(checked.gradingKey),
          checked.contentHash,sessionNumber,expectedRevision]);
        if(saved.rowCount!==1) throw error('DRAFT_STALE','Nháp đã đổi trong lúc lưu.');
        const readback=await client.query('SELECT * FROM learning.form_draft WHERE id=$1::uuid;',[id]);
        const current=readback.rows[0];
        if(!current||Number(current.revision)!==expectedRevision+1||current.content_hash!==checked.contentHash
          ||Number(current.session_number)!==sessionNumber) throw error('DRAFT_READBACK_MISMATCH','Chưa xác nhận được nháp vừa lưu.',500);
        return {...dto(current),missingAnswers:checked.missingAnswers,replayed:false};
      });
    },
    async copyAssignment({assignmentId,classId,sessionNumber,operationId,reviewer}) {
      const access=await pool.query(authorizeLearningJourneyPlanAssignmentSql,[assignmentId,reviewer.email,reviewer.canAccessAllClasses]);
      if(access.rowCount!==1) throw error('DRAFT_SOURCE_ACCESS_DENIED','Không được sao chép phiếu ngoài phạm vi lớp.',403);
      await authorizeClass(pool,classId,reviewer);
      const source=await pool.query(`SELECT version.public_definition,grading.private_definition FROM learning.form_assignment AS assignment
        JOIN learning.form_version AS version ON version.id=assignment.form_version_id
        JOIN learning.form_grading_key AS grading ON grading.form_version_id=version.id
        WHERE assignment.id=$1::uuid AND assignment.status IN ('published','closed');`,[assignmentId]);
      if(source.rowCount!==1) throw error('DRAFT_SOURCE_NOT_FOUND','Phiếu nguồn chưa sẵn sàng để sao chép.',404);
      // Retry copy phải phục hồi nháp cũ, không remap thêm ID rồi báo xung đột giả.
      const prior=await pool.query('SELECT * FROM learning.form_draft WHERE create_operation_id=$1::uuid;',[operationId]);
      if(prior.rowCount) {
        const row=await owned(pool,prior.rows[0].id,reviewer);
        if(String(row.erp_course_class_id)!==String(classId)||Number(row.session_number)!==sessionNumber
          ||row.source_assignment_id!==assignmentId) throw error('DRAFT_OPERATION_CONFLICT','Mã thao tác đã dùng cho nguồn hoặc đích khác.');
        return {...dto(row),replayed:true};
      }
      const copied=copyAuthoringPayload({definition:source.rows[0].public_definition,gradingKey:source.rows[0].private_definition});
      return create({classId,sessionNumber,definition:copied.definition,gradingKey:copied.gradingKey,operationId,sourceAssignmentId:assignmentId,reviewer});
    },
    async previewImport({id,text,expectedRevision,reviewer}) {
      const row=await owned(pool,id,reviewer);
      if(Number(row.revision)!==expectedRevision) throw error('DRAFT_STALE','Nháp đã đổi; hãy đối chiếu trước khi nhập.');
      if(row.status==='published') throw error('DRAFT_ALREADY_PUBLISHED','Hãy tạo bản sao trước khi nhập thêm câu.');
      return {baseRevision:Number(row.revision),...previewFormImport(text,{definition:row.public_definition,gradingKey:row.private_definition})};
    }
  };
}
