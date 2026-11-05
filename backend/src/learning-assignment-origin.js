import {FormAuthoringError} from './learning-form-authoring.js';
import {catalogVisible} from './learning-catalog-archive.js';
const denied=()=>new FormAuthoringError('DELIVERY_SOURCE_MISMATCH','Nguồn đã chọn không khớp bản chuẩn bị giao. Mở lại Giao bài.',[],409);

export async function assignmentOrigin(database,publication,origin,reviewer){
 if(origin.source==='library'){
  const entry=(await database.query(`SELECT e.id,e.sharing_scope,e.content_hash FROM learning.form_library_entry e WHERE e.id=$1::uuid
   AND (e.sharing_scope='izone' OR lower(e.owner_email)=lower($2)) AND ${catalogVisible('e.source_draft_id','e.owner_email','e.sharing_scope')}`,[origin.id,reviewer.email])).rows[0];
  if(!entry||![publication.content_hash,publication.source_content_hash].includes(entry.content_hash))throw denied();
  return {scope:entry.sharing_scope,libraryId:entry.id};
 }
 const draft=(await database.query(`SELECT d.id,d.content_hash,d.public_definition FROM learning.form_draft d WHERE d.id=$1::uuid AND lower(d.owner_email)=lower($2) AND ${catalogVisible('d.id','d.owner_email')}`,[origin.id,reviewer.email])).rows[0];
 if(!draft||draft.content_hash!==publication.content_hash||draft.public_definition.formVersionId!==publication.form_version_id)throw denied();
 return {scope:'personal',libraryId:null};
}

export async function withAssignmentOrigins(pool,assignments){
 if(!assignments.length)return assignments;
 const rows=(await pool.query('SELECT assignment_id,source_scope FROM learning.form_assignment_origin WHERE assignment_id=ANY($1::uuid[])',[assignments.map(a=>a.assignment_id)])).rows;
 const origins=new Map(rows.map(r=>[r.assignment_id,r.source_scope]));
 return assignments.map(a=>({...a,origin_scope:origins.get(a.assignment_id)||null}));
}
