// Chỉnh sửa cùng phiếu logic; mọi bản đã xuất bản và assignment tiếp tục bất biến.
import {randomUUID} from 'node:crypto';
import {withTransaction} from './db.js';
import {copyAuthoringPayload,FormAuthoringError,importReviewContent,validateAuthoringPayload} from './learning-form-authoring.js';
import {sha256} from './learning-domain.js';

export function createWorksheetEditing({pool,owned,dto}){
 return async function editWorksheet({id,operationId,reviewer}){
  return withTransaction(pool,async db=>{
   const source=await owned(db,id,reviewer);
   const relation=(await db.query('SELECT worksheet_id FROM learning.form_worksheet_revision WHERE draft_id=$1::uuid',[id])).rows[0];
   const root=relation?.worksheet_id||source.id;
   await db.query(`INSERT INTO learning.form_worksheet(id,owner_email,current_draft_id) VALUES($1::uuid,$2,$3::uuid) ON CONFLICT(id) DO NOTHING`,[root,reviewer.email,id]);
   const head=(await db.query('SELECT * FROM learning.form_worksheet WHERE id=$1::uuid FOR UPDATE',[root])).rows[0];
   if(head.owner_email.toLowerCase()!==reviewer.email.toLowerCase())throw new FormAuthoringError('DRAFT_NOT_FOUND','Không tìm thấy phiếu thuộc phiên của bạn.',[],404);
   await db.query('INSERT INTO learning.form_worksheet_revision(draft_id,worksheet_id) VALUES($1::uuid,$2::uuid) ON CONFLICT(draft_id) DO NOTHING',[root,root]);
   const token=sha256('worksheet-edit:'+root+':'+operationId),op=token.slice(0,8)+'-'+token.slice(8,12)+'-4'+token.slice(13,16)+'-a'+token.slice(17,20)+'-'+token.slice(20,32);
   const prior=(await db.query('SELECT id FROM learning.form_draft WHERE create_operation_id=$1::uuid',[op])).rows[0];
   if(prior){
    if(prior.id!==head.current_draft_id)throw new FormAuthoringError('DRAFT_STALE','Phiếu đã có bản mới. Hãy mở lại Sửa bài.',[],409);
    return {...dto(await owned(db,prior.id,reviewer)),worksheetId:root};
   }
   const current=await owned(db,head.current_draft_id,reviewer,{lock:true});
   const frozen=current.status==='published'||(await db.query(`SELECT 1 FROM learning.form_publication WHERE source_draft_id=$1::uuid OR form_version_id::text=$2 LIMIT 1`,[current.id,current.public_definition.formVersionId])).rowCount>0;
   if(!frozen)return {...dto(current),worksheetId:root};
   const payload=copyAuthoringPayload({definition:current.public_definition,gradingKey:current.private_definition}),next=randomUUID();
   const oldItems=current.public_definition.blocks.flatMap(b=>b.items),newItems=payload.definition.blocks.flatMap(b=>b.items);
   for(const [index,old]of oldItems.entries()){
    const review=current.private_definition.importReviews?.[old.itemVersionId],item=newItems[index];
    if(review?.reviewedContent===importReviewContent(old,current.private_definition)&&payload.gradingKey.importReviews?.[item.itemVersionId])payload.gradingKey.importReviews[item.itemVersionId].reviewedContent=importReviewContent(item,payload.gradingKey);
   }
   const hash=validateAuthoringPayload({...payload,allowIncomplete:true}).contentHash;
   const row=(await db.query(`INSERT INTO learning.form_draft(id,create_operation_id,owner_email,erp_course_class_id,session_number,public_definition,private_definition,content_hash)
    VALUES($1::uuid,$2::uuid,$3,$4::bigint,$5,$6::jsonb,$7::jsonb,$8) RETURNING *`,[next,op,reviewer.email,current.erp_course_class_id,current.session_number,JSON.stringify(payload.definition),JSON.stringify(payload.gradingKey),hash])).rows[0];
   await db.query('INSERT INTO learning.form_worksheet_revision(draft_id,worksheet_id,parent_draft_id) VALUES($1::uuid,$2::uuid,$3::uuid)',[next,root,current.id]);
   await db.query('UPDATE learning.form_worksheet SET current_draft_id=$2::uuid,updated_at=now() WHERE id=$1::uuid',[root,next]);
   return {...dto(row),worksheetId:root};
  });
 };
}
