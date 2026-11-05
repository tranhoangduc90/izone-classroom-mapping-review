import {FormAuthoringError} from './learning-form-authoring.js';
export const catalogVisible=(draft,owner,scope="'personal'")=>`NOT EXISTS(SELECT 1 FROM learning.form_catalog_archive archived WHERE archived.source_draft_id=${draft} AND lower(archived.owner_email)=lower(${owner}) AND archived.sharing_scope=${scope})`;
// Catalog operations are rare; one transaction lock gives delete/edit/assign an explicit order.
export async function lockCatalog(db){
 await db.query("INSERT INTO learning.form_publication_lock(source_key) VALUES('catalog') ON CONFLICT DO NOTHING");
 await db.query("SELECT source_key FROM learning.form_publication_lock WHERE source_key='catalog' FOR UPDATE");
}
export async function isCatalogAdmin(db,email){
 return (await db.query(`SELECT 1 FROM mapping.reviewer_account a JOIN learning.progress_log_admin p ON lower(p.reviewer_email)=lower(a.email)
  WHERE lower(a.email)=lower($1) AND a.status='active' AND p.status='active'`,[email])).rowCount===1;
}
export async function assertCatalogSource(db,id,owner,scope='personal'){
 const result=await db.query(`SELECT 1 WHERE ${catalogVisible('$1::uuid','$2','$3')}`,[id,owner,scope]);
 if(!result.rowCount)throw new FormAuthoringError('CATALOG_ARCHIVED','Bài đã được xóa khỏi kho; không thể giao hoặc sửa từ nguồn này.',[],409);
}
export async function archiveCatalog({pool,id,source,operationId,reviewer}){
 const {withTransaction}=await import('./db.js');
 return withTransaction(pool,async db=>{
  await lockCatalog(db);
  const shared=source==='izone';
  if(shared&&!await isCatalogAdmin(db,reviewer.email))throw new FormAuthoringError('CATALOG_ADMIN_REQUIRED','Chỉ quản trị được xóa bài trong Kho chung.',[],403);
  const row=(await db.query(shared?'SELECT source_draft_id AS id,owner_email FROM learning.form_library_entry WHERE id=$1::uuid AND sharing_scope=\'izone\'':
   'SELECT id,owner_email FROM learning.form_draft WHERE id=$1::uuid AND lower(owner_email)=lower($2)',shared?[id]:[id,reviewer.email])).rows[0];
  if(!row)throw new FormAuthoringError('CATALOG_NOT_FOUND','Không tìm thấy bài trong kho bạn được quản lý.',[],404);
  const related=(await db.query(`SELECT d.id FROM learning.form_draft d WHERE lower(d.owner_email)=lower($2) AND (d.id=$1::uuid OR d.id IN
   (SELECT r.draft_id FROM learning.form_worksheet_revision r WHERE r.worksheet_id=COALESCE((SELECT worksheet_id FROM learning.form_worksheet_revision WHERE draft_id=$1::uuid),$1::uuid)))`,[row.id,row.owner_email])).rows;
  for(const draft of related)await db.query(`INSERT INTO learning.form_catalog_archive(sharing_scope,source_draft_id,owner_email,operation_id,archived_by_email)
   VALUES($1,$2::uuid,lower($3),$4::uuid,$5) ON CONFLICT DO NOTHING`,[shared?'izone':'personal',draft.id,row.owner_email,operationId,reviewer.email]);
  return {archived:true,id,source};
 });
}
