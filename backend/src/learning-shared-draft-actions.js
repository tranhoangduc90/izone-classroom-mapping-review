import {withTransaction} from './db.js';
import {lockCatalog,assertCatalogSource} from './learning-catalog-archive.js';
import {assertSharedCourse} from './learning-shared-course-policy.js';
import {copyAuthoringPayload,FormAuthoringError,validateAuthoringPayload} from './learning-form-authoring.js';
import {sha256,stableStringify} from './learning-domain.js';

const fail=(code,message,status=409)=>new FormAuthoringError(code,message,[],status);
const conflict=()=>fail('DRAFT_OPERATION_CONFLICT','Mã thao tác đã dùng cho một yêu cầu khác.');

export const sharedBaseState=(row)=>row.base_archived_at?'archived':
  row.current_entry_id&&row.current_entry_id!==row.base_entry_id?'superseded':null;

export function createSharedDraftActions({pool,owned,dto,sharedRevisionCatalog}){
  async function source(db,{id,reviewer,expectedRevision,expectedHash}){
    const {rows:[draft]}=await db.query(`SELECT d.* FROM learning.form_draft d
      WHERE d.id=$1::uuid AND lower(d.owner_email)=lower($2) AND d.draft_scope='izone' FOR UPDATE`,[id,reviewer.email]);
    if(!draft)throw fail('DRAFT_NOT_FOUND','Không tìm thấy nháp Kho chung thuộc phiên của bạn.',404);
    await assertSharedCourse(db,reviewer.email,draft.public_definition.courseCode);
    if(Number(draft.revision)!==expectedRevision||draft.content_hash!==expectedHash)
      throw fail('DRAFT_STALE','Nháp đã đổi. Hãy tải lại trước khi tiếp tục.');
    return draft;
  }

  async function unpublished(db,draft){
    const {rowCount}=await db.query(`SELECT 1 FROM learning.form_publication WHERE source_draft_id=$1::uuid
      UNION ALL SELECT 1 FROM learning.form_library_entry WHERE source_draft_id=$1::uuid AND sharing_scope='izone' LIMIT 1`,[draft.id]);
    if(rowCount)throw fail('DRAFT_ALREADY_PUBLISHED','Bản này đã xuất bản. Hãy mở lại từ Kho chung.');
  }

  return {
    async archiveSharedDraft(args){
      const {id,reviewer,operationId,expectedStatus}=args;
      return withTransaction(pool,async db=>{
        await lockCatalog(db);
        const draft=await source(db,args),courseCode=draft.public_definition.courseCode;
        const {rows:marks}=await db.query(`SELECT source_draft_id,owner_email,archived_by_email,sharing_scope
          FROM learning.form_catalog_archive WHERE operation_id=$1::uuid`,[operationId]);
        if(marks.length){
          const mark=marks[0];
          if(marks.length!==1||mark.source_draft_id!==id||mark.sharing_scope!=='izone'||
            mark.owner_email.toLowerCase()!==reviewer.email.toLowerCase()||mark.archived_by_email.toLowerCase()!==reviewer.email.toLowerCase()||
            draft.status!==expectedStatus)throw conflict();
          return {archived:true,id,courseCode,replayed:true};
        }
        await assertCatalogSource(db,id,reviewer.email,'izone');
        await unpublished(db,draft);
        if(draft.status!==expectedStatus||!['draft','approved'].includes(draft.status))
          throw fail('DRAFT_STATE_CHANGED','Trạng thái nháp đã đổi. Hãy mở lại danh sách.');
        await db.query(`INSERT INTO learning.form_catalog_archive
          (sharing_scope,source_draft_id,owner_email,operation_id,archived_by_email)
          VALUES('izone',$1::uuid,lower($2),$3::uuid,lower($2))`,[id,reviewer.email,operationId]);
        return {archived:true,id,courseCode,replayed:false};
      });
    },
    async copySharedDraftToPersonal(args){
      const {id,reviewer,operationId,expectedRevision,expectedHash,title}=args;
      return withTransaction(pool,async db=>{
        await lockCatalog(db);
        const draft=await source(db,args),courseCode=draft.public_definition.courseCode;
        const {rows:[previous]}=await db.query('SELECT * FROM learning.form_draft WHERE create_operation_id=$1::uuid',[operationId]);
        if(previous){
          if(previous.owner_email.toLowerCase()!==reviewer.email.toLowerCase()||previous.draft_scope!=='personal'||
            previous.copied_shared_draft_id!==id||Number(previous.copied_shared_draft_revision)!==expectedRevision||
            previous.copied_shared_draft_hash!==expectedHash||previous.copied_shared_draft_title!==title)throw conflict();
          return {draft:dto(await owned(db,previous.id,reviewer)),courseCode,replayed:true};
        }
        await assertCatalogSource(db,id,reviewer.email,'izone');
        await unpublished(db,draft);
        if(sharedRevisionCatalog){
          const {rowCount}=await db.query(`SELECT 1 FROM learning.form_shared_library_revision r
            JOIN learning.form_shared_library_item i ON i.id=r.item_id WHERE r.draft_id=$1::uuid AND i.archived_at IS NOT NULL`,[id]);
          if(rowCount)throw fail('CATALOG_ARCHIVED','Bài nguồn đã bị gỡ khỏi Kho chung.');
        }
        const original={definition:draft.public_definition,gradingKey:draft.private_definition};
        if(sha256(stableStringify(original))!==expectedHash)throw fail('DRAFT_CONTENT_MISMATCH','Nội dung bản nháp không khớp.',500);
        const payload=copyAuthoringPayload(original);
        payload.definition.title=title;
        const checked=validateAuthoringPayload({...payload,allowIncomplete:true});
        const definition=JSON.stringify(checked.definition),key=JSON.stringify(checked.gradingKey);
        const {rows:[saved]}=await db.query(`INSERT INTO learning.form_draft
          (create_operation_id,owner_email,draft_scope,public_definition,private_definition,content_hash,
           copied_shared_draft_id,copied_shared_draft_revision,copied_shared_draft_hash,copied_shared_draft_title)
          VALUES($1,$2,'personal',$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (create_operation_id) DO NOTHING RETURNING *`,
          [operationId,reviewer.email,definition,key,checked.contentHash,id,expectedRevision,expectedHash,title]);
        if(!saved)throw conflict();
        await db.query(`INSERT INTO learning.form_library_entry
          (operation_id,owner_email,sharing_scope,source_draft_id,source_revision,course_code,title,public_definition,private_definition,content_hash)
          VALUES($1,$2,'personal',$3,$4,$5,$6,$7,$8,$9)`,
          [operationId,reviewer.email,saved.id,saved.revision,courseCode,title,definition,key,checked.contentHash]);
        await db.query('INSERT INTO learning.form_worksheet(id,owner_email,current_draft_id) VALUES($1,$2,$1)',[saved.id,reviewer.email]);
        await db.query('INSERT INTO learning.form_worksheet_revision(draft_id,worksheet_id) VALUES($1,$1)',[saved.id]);
        return {draft:dto(saved),courseCode,replayed:false};
      });
    }
  };
}
