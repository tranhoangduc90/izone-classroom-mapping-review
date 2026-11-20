import {FormAuthoringError} from './learning-form-authoring.js';
import {sharedLibraryItem} from './learning-shared-library-revisions.js';
export const catalogVisible=(draft,owner,scope="'personal'")=>`NOT EXISTS(SELECT 1 FROM learning.form_catalog_archive archived WHERE archived.source_draft_id=${draft} AND lower(archived.owner_email)=lower(${owner}) AND archived.sharing_scope=${scope})`;
// Catalog operations are rare; one transaction lock gives delete/edit/assign an explicit order.
export async function lockCatalog(db){
 await db.query("INSERT INTO learning.form_publication_lock(source_key) VALUES('catalog') ON CONFLICT DO NOTHING");
 await db.query("SELECT source_key FROM learning.form_publication_lock WHERE source_key='catalog' FOR UPDATE");
}
export async function lockSharedLibraryDraft(database,draftId,enabled){
 if(!enabled)return null;
 const link=(await database.query('SELECT * FROM learning.form_shared_library_revision WHERE draft_id=$1::uuid',[draftId])).rows[0];
 if(!link)return null;
 await lockCatalog(database);
 const item=(await database.query('SELECT * FROM learning.form_shared_library_item WHERE id=$1::uuid',[link.item_id])).rows[0];
 return {...link,item};
}
export async function isCatalogAdmin(db,email){
 return (await db.query(`SELECT 1 FROM mapping.reviewer_account a JOIN learning.progress_log_admin p ON lower(p.reviewer_email)=lower(a.email)
  WHERE lower(a.email)=lower($1) AND a.status='active' AND p.status='active'`,[email])).rowCount===1;
}
export async function sharedArchiveCourses(db,email){
 const {rows}=await db.query(`SELECT grant_row.course_code FROM learning.shared_library_archive_grant grant_row
  JOIN mapping.reviewer_account a ON lower(a.email)=grant_row.reviewer_email
  WHERE grant_row.reviewer_email=lower($1) AND a.status='active' AND grant_row.revoked_at IS NULL`,[email]);
 return rows.map(row=>row.course_code);
}
export function sharedArchiveCourse(row,item){
 const course=row?.course_code;
 return course&&(!row.definition_course||row.definition_course===course)&&(!item||item.course_code===course)?course:null;
}
export async function assertCatalogSource(db,id,owner,scope='personal'){
 const result=await db.query(`SELECT 1 WHERE ${catalogVisible('$1::uuid','$2','$3')}`,[id,owner,scope]);
 if(!result.rowCount)throw new FormAuthoringError('CATALOG_ARCHIVED','Bài đã được xóa khỏi kho; không thể giao hoặc sửa từ nguồn này.',[],409);
}
export async function archiveCatalog({pool,id,source,operationId,expectedRevision,expectedHash,reviewer,sharedRevisionCatalog=false}){
 const {withTransaction}=await import('./db.js');
 return withTransaction(pool,async db=>{
  await lockCatalog(db);
  const shared=source==='izone';
  const admin=shared&&await isCatalogAdmin(db,reviewer.email);
  const courses=shared&&!admin&&sharedRevisionCatalog?await sharedArchiveCourses(db,reviewer.email):[];
  const entry=shared?(await db.query(`SELECT source_draft_id AS id,owner_email,course_code,source_revision,content_hash,
    public_definition->>'courseCode' AS definition_course FROM learning.form_library_entry WHERE id=$1::uuid AND sharing_scope='izone'`,[id])).rows[0]:null;
  const item=shared&&sharedRevisionCatalog?await sharedLibraryItem(db,id):null;
  if(shared&&!admin&&!courses.includes(sharedArchiveCourse(entry,item)))
   throw new FormAuthoringError('CATALOG_ADMIN_REQUIRED','Bạn chưa có quyền Xóa bài trong Kho chung cho khóa này.',[],403);
  if(shared&&entry&&((!admin||expectedRevision!==undefined||expectedHash!==undefined)
    &&(Number(entry.source_revision)!==expectedRevision||entry.content_hash!==expectedHash)))
   throw new FormAuthoringError('LIBRARY_SOURCE_STALE','Bản bài đã đổi. Hãy mở lại từ Kho chung.',[],409);
  if(item){
   if(item.current_entry_id!==id)throw new FormAuthoringError('LIBRARY_SOURCE_STALE','Bài đã có phiên bản mới. Hãy mở lại từ Kho chung.',[],409);
   const changed=await db.query(`UPDATE learning.form_shared_library_item SET archived_at=now(),archived_by_email=lower($2),archive_operation_id=$3
    WHERE id=$1 AND archived_at IS NULL`,[item.id,reviewer.email,operationId]);
   return {archived:true,id,source,courseCode:entry?.course_code,replayed:!changed.rowCount};
  }
  const row=shared?entry:(await db.query(
   "SELECT id,owner_email FROM learning.form_draft WHERE id=$1::uuid AND lower(owner_email)=lower($2) AND draft_scope<>'izone'",[id,reviewer.email])).rows[0];
  if(!row)throw new FormAuthoringError('CATALOG_NOT_FOUND','Không tìm thấy bài trong kho bạn được quản lý.',[],404);
  const related=(await db.query(`SELECT d.id FROM learning.form_draft d WHERE lower(d.owner_email)=lower($2) AND (d.id=$1::uuid OR d.id IN
   (SELECT r.draft_id FROM learning.form_worksheet_revision r WHERE r.worksheet_id=COALESCE((SELECT worksheet_id FROM learning.form_worksheet_revision WHERE draft_id=$1::uuid),$1::uuid)))`,[row.id,row.owner_email])).rows;
  let affected=0;
  for(const draft of related){
   const inserted=await db.query(`INSERT INTO learning.form_catalog_archive(sharing_scope,source_draft_id,owner_email,operation_id,archived_by_email)
    VALUES($1,$2::uuid,lower($3),$4::uuid,$5) ON CONFLICT DO NOTHING`,[shared?'izone':'personal',draft.id,row.owner_email,operationId,reviewer.email]);
   affected+=inserted.rowCount;
  }
  return {archived:true,id,source,courseCode:entry?.course_code,replayed:!affected};
 });
}
