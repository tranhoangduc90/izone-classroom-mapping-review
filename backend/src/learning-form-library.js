// Nhận phiếu do GV chọn lưu; giữ kho cá nhân và kho chuẩn có phân quyền riêng.
// Chỉ bản đã duyệt và người có quyền chuyên môn/quản trị được đưa vào Kho IZONE.
// Dùng lại tạo nháp với ID mới; không tự giao lớp hoặc sửa phiên bản đã phát hành.
import {copyAuthoringPayload,validateAuthoringPayload,FormAuthoringError} from './learning-form-authoring.js';
import {sha256,stableStringify} from './learning-domain.js';
import {createHash} from 'node:crypto';
import {withTransaction} from './db.js';
const fail=(code,message,status=409)=>new FormAuthoringError(code,message,[],status);
const dto=row=>({id:row.id,title:row.title,courseCode:row.course_code,scope:row.sharing_scope,createdAt:row.created_at,
  sourceDraftId:row.source_draft_id,
  sourceRevision:Number(row.source_revision),skills:[...new Set(row.public_definition.blocks.flatMap(b=>b.items.flatMap(i=>i.skillCodes||[])))],
  itemCount:row.public_definition.blocks.reduce((n,b)=>n+b.items.length,0)});
export function createLearningFormLibrary({pool,drafts}){
 async function get(id,reviewer){
  const row=(await pool.query(`SELECT * FROM learning.form_library_entry WHERE id=$1::uuid
    AND (sharing_scope='izone' OR lower(owner_email)=lower($2))`,[id,reviewer.email])).rows[0];
  if(!row)throw fail('LIBRARY_ENTRY_NOT_FOUND','Không tìm thấy phiếu trong kho bạn được mở.',404);
  return row;
 }
 return {
  async previewInfo({id,reviewer}){
   const row=await get(id,reviewer),checked=validateAuthoringPayload({definition:row.public_definition,gradingKey:row.private_definition});
   if(checked.contentHash!==row.content_hash)throw fail('LIBRARY_CONTENT_MISMATCH','Nội dung bản chụp trong kho chưa khớp.',500);
   return {id:row.id,revision:Number(row.source_revision),contentHash:row.content_hash};
  },
  async demoSource({grant}){
   const active=await pool.query(`SELECT email FROM mapping.reviewer_account WHERE lower(email)=lower($1) AND status='active'`,[grant.ownerEmail]);
   if(active.rowCount!==1)throw fail('LIBRARY_PREVIEW_DENIED','Quyền xem kho đã thay đổi.',403);
   const row=await get(grant.entryId,{email:active.rows[0].email});
   if(row.content_hash!==grant.contentHash||Number(row.source_revision)!==grant.revision)throw fail('LIBRARY_PREVIEW_STALE','Bản nguồn đã đổi; mở lại bản xem trước.');
   const checked=validateAuthoringPayload({definition:row.public_definition,gradingKey:row.private_definition});
   if(checked.contentHash!==row.content_hash)throw fail('LIBRARY_CONTENT_MISMATCH','Nội dung bản chụp trong kho chưa khớp.',500);
   return {sourceLibraryId:row.id,sourceRevision:Number(row.source_revision),contentHash:row.content_hash,
    sourceAssignmentId:null,className:'Lớp mẫu',courseCode:row.course_code||null,sessionNumber:1,title:checked.definition.title,
    definitionHash:sha256(stableStringify(checked.definition)),definition:checked.definition,gradingKey:checked.gradingKey,
    blockReleases:[],answerReleaseOverride:null};
  },
  async list({scope='personal',skill='',reviewer}){
   if(!['personal','izone'].includes(scope))throw fail('LIBRARY_SCOPE_INVALID','Nguồn kho chưa hợp lệ.',400);
   const rows=(await pool.query(`SELECT * FROM learning.form_library_entry WHERE sharing_scope=$1
     AND ($1='izone' OR lower(owner_email)=lower($2)) ORDER BY created_at DESC,id LIMIT 200`,[scope,reviewer.email])).rows;
   return rows.map(dto).filter(r=>!skill||r.skills.includes(skill));
  },
  async get({id,reviewer}){const row=await get(id,reviewer);return {...dto(row),definition:row.public_definition};},
  async store({draftId,expectedRevision,expectedHash,scope,operationId,reviewer}){
   if(!['personal','izone'].includes(scope))throw fail('LIBRARY_SCOPE_INVALID','Nguồn kho chưa hợp lệ.',400);
   const draft=await drafts.get({id:draftId,reviewer});
   if(draft.revision!==expectedRevision||draft.contentHash!==expectedHash)throw fail('DRAFT_STALE','Nháp đã đổi; đọc lại trước khi lưu vào kho.');
   if(scope==='izone'){
    if(!['approved','published'].includes(draft.status)||draft.approvedRevision!==draft.revision||!draft.definition.courseCode)
      throw fail('LIBRARY_APPROVAL_REQUIRED','Kho IZONE chỉ nhận đúng bản đã duyệt và có mã khóa học.');
    const authority=await pool.query(`SELECT 1 FROM mapping.reviewer_account a WHERE lower(a.email)=lower($1) AND a.status='active'
      AND (a.role='admin' OR EXISTS(SELECT 1 FROM learning.progress_log_admin p WHERE lower(p.reviewer_email)=lower(a.email) AND p.status='active')
      OR EXISTS(SELECT 1 FROM learning.course_content_authority c WHERE lower(c.reviewer_email)=lower(a.email) AND c.course_code=$2 AND c.status='active'))`,[reviewer.email,draft.definition.courseCode]);
    if(authority.rowCount!==1)throw fail('LIBRARY_APPROVAL_DENIED','Chỉ người phụ trách chuyên môn của khóa hoặc quản trị được đưa bài vào Kho IZONE.',403);
   }
   return withTransaction(pool,async database=>{
   const current=(await database.query('SELECT revision,content_hash,status,approved_by_email,approved_hash,approved_at FROM learning.form_draft WHERE id=$1::uuid FOR UPDATE',[draft.id])).rows[0];
   if(!current||Number(current.revision)!==expectedRevision||current.content_hash!==expectedHash
     ||(scope==='izone'&&!['approved','published'].includes(current.status)))throw fail('DRAFT_STALE','Nháp đã đổi; đọc lại trước khi lưu vào kho.');
   await database.query(`INSERT INTO learning.form_library_entry(operation_id,owner_email,sharing_scope,source_draft_id,source_revision,
     course_code,title,public_definition,private_definition,content_hash,approved_by_email,approval_hash,approved_at) VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
     ON CONFLICT(operation_id) DO NOTHING`,[operationId,reviewer.email,scope,draft.id,draft.revision,draft.definition.courseCode||null,
     draft.definition.title,JSON.stringify(draft.definition),JSON.stringify(draft.gradingKey),draft.contentHash,
     current.approved_by_email,current.approved_hash,current.approved_at]);
   const row=(await database.query('SELECT * FROM learning.form_library_entry WHERE operation_id=$1::uuid',[operationId])).rows[0];
   if(!row||row.owner_email!==reviewer.email||row.sharing_scope!==scope||row.content_hash!==draft.contentHash)
     throw fail('LIBRARY_OPERATION_CONFLICT','Mã lưu đã dùng cho phiếu hoặc nguồn khác.');
   return dto(row);
   });
  },
  async copy({id,classId,sessionNumber,operationId,reviewer}){
   const token=createHash('sha256').update(id+':'+operationId).digest('hex');
   operationId=token.slice(0,8)+'-'+token.slice(8,12)+'-4'+token.slice(13,16)+'-a'+token.slice(17,20)+'-'+token.slice(20,32);
   const row=await get(id,reviewer),payload=copyAuthoringPayload({definition:row.public_definition,gradingKey:row.private_definition});
   // create giữ idempotency theo operation; dùng lại payload của nháp trước khi remap nếu đây là retry.
   const prior=(await pool.query('SELECT id,owner_email,erp_course_class_id,session_number FROM learning.form_draft WHERE create_operation_id=$1::uuid',[operationId])).rows[0];
   if(prior){if(prior.owner_email!==reviewer.email||String(prior.erp_course_class_id)!==String(classId)||Number(prior.session_number)!==sessionNumber)
     throw fail('LIBRARY_OPERATION_CONFLICT','Mã sao chép đã dùng cho đích khác.');return drafts.get({id:prior.id,reviewer});}
   return drafts.create({classId,sessionNumber,operationId,...payload,reviewer});
  }
 };
}
