import {FormAuthoringError} from './learning-form-authoring.js';
const denied=()=>new FormAuthoringError('DELIVERY_SOURCE_MISMATCH','Nguồn đã chọn không khớp bản chuẩn bị giao. Mở lại Giao bài.',[],409);

export async function assignmentOrigin(database,publication,origin,reviewer){
 if(origin.source==='library'){
  const entry=(await database.query(`SELECT id,sharing_scope,content_hash FROM learning.form_library_entry WHERE id=$1::uuid
   AND (sharing_scope='izone' OR lower(owner_email)=lower($2))`,[origin.id,reviewer.email])).rows[0];
  if(!entry||![publication.content_hash,publication.source_content_hash].includes(entry.content_hash))throw denied();
  return {scope:entry.sharing_scope,libraryId:entry.id};
 }
 const draft=(await database.query(`SELECT id,content_hash,public_definition FROM learning.form_draft WHERE id=$1::uuid AND lower(owner_email)=lower($2)`,[origin.id,reviewer.email])).rows[0];
 if(!draft||draft.content_hash!==publication.content_hash||draft.public_definition.formVersionId!==publication.form_version_id)throw denied();
 return {scope:'personal',libraryId:null};
}

export async function withAssignmentOrigins(pool,assignments){
 if(!assignments.length)return assignments;
 const rows=(await pool.query('SELECT assignment_id,source_scope FROM learning.form_assignment_origin WHERE assignment_id=ANY($1::uuid[])',[assignments.map(a=>a.assignment_id)])).rows;
 const origins=new Map(rows.map(r=>[r.assignment_id,r.source_scope]));
 return assignments.map(a=>({...a,origin_scope:origins.get(a.assignment_id)||null}));
}
