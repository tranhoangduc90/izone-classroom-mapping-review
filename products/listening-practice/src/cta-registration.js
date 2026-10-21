import {createHmac} from 'node:crypto';
import {CODE,fail,hash} from './domain.js';
import {CTA,planDocWrite} from './docs.js';
import {authoredLesson} from './authored-content.js';

// Đọc đủ tab và bảng lồng; chỉ nhận một CTA Listening đi cùng đúng mã ngay phía dưới.
function documentParagraphs(document){
 const paragraphs=[];
 function walk(content,tabId){for(const e of content||[]){
  if(e.paragraph)paragraphs.push({tabId,text:(e.paragraph.elements||[]).map(x=>x.textRun?.content||'').join('').trim()});
  for(const row of e.table?.tableRows||[])for(const cell of row.tableCells||[])walk(cell.content,tabId);
 }}
 function tabs(items){for(const t of items||[]){walk(t.documentTab?.body?.content,t.tabProperties?.tabId);tabs(t.childTabs);}}
 tabs(document.tabs);
 return paragraphs;
}
export function findListeningCta(document,code=CODE){
 const paragraphs=documentParagraphs(document);
 const labels=paragraphs.filter(p=>p.text===CTA),codes=paragraphs.filter(p=>p.text===code);
 if(!labels.length&&!codes.length)return null;
 if(labels.length!==1||codes.length!==1)fail('CTA_SCOPE_AMBIGUOUS','CTA hoặc mã Listening bị thiếu/trùng.');
 const index=paragraphs.indexOf(labels[0]);
 const next=paragraphs.slice(index+1).find(p=>p.text);
 if(next!==codes[0]||next.tabId!==labels[0].tabId)fail('CTA_CODE_MISMATCH','Mã Listening phải nằm ngay dưới đúng CTA trong cùng tab.');
 return{tabId:labels[0].tabId};
}

// Nhận một sự kiện Classroom đã chuẩn hóa; đối chiếu chủ Docs trước đăng ký, giữ link ổn định khi chạy lại.
// Hàng Docs hiện có chịu trách nhiệm ghi/đọc lại; timeout trả lỗi để thử lại an toàn, không báo đã gắn khi mới xếp hàng.
export function createCtaRegistrar({pool,service,context,docs,resolveOwner,entryKey,contentVersion,code=CODE,waitMs=12000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 return async event=>{
  const document=await docs.read(event.doc_id);
  if(document.documentId!==event.doc_id)fail('DOC_IDENTITY_MISMATCH','Nguồn Docs trả sai tài liệu.');
  // Mã hiển thị trong Docs quyết định bài; hyperlink cũ không được dùng để chọn buổi.
  const authoredCodes=documentParagraphs(document).filter(p=>authoredLesson(p.text)).map(p=>p.text);
  if(authoredCodes.length>1)fail('CTA_SCOPE_AMBIGUOUS','Có nhiều mã Listening mới trong tài liệu.');
  const selectedCode=authoredCodes[0]||code,shared=Boolean(authoredLesson(selectedCode));
  const target=findListeningCta(document,selectedCode);
  if(!target)return{documentId:event.doc_id,status:'not_applicable',code};
  const owner=await resolveOwner({courseId:event.classroom_course_id,googleUserId:event.student_id});
  const snapshot=await context.snapshot();
  const found=snapshot.classes.filter(c=>c.erp_course_class_id===owner.classId&&c.erp_class_name_snapshot===event.class_name);
  if(found.length!==1)fail('CTA_CLASS_MISMATCH','Lớp sự kiện không khớp mapping đã duyệt.',403);
  if(shared){
   const registered=await service.registerSharedHomework({code:selectedCode,classId:owner.classId,classCode:event.class_name,studentRef:owner.studentRef,
    documentId:event.doc_id,tabId:target.tabId,courseId:event.classroom_course_id,courseWorkId:event.coursework_id,submissionId:event.submission_id});
   const binding={document_id:event.doc_id,tab_id:target.tabId,code:selectedCode},job={kind:'cta',payload:{url:registered.entryUrl}};
   if(!planDocWrite(document,binding,job).verified)await pool.query(`UPDATE listening_practice.doc_job SET status='pending',available_at=now(),attempts=0,verified_at=null
    WHERE binding_id=$1 AND kind='cta' AND sequence=0 AND status='verified'`,[registered.bindingId]);
   const deadline=Date.now()+waitMs;
   do{
    const state=(await pool.query("SELECT status,error_code FROM listening_practice.doc_job WHERE binding_id=$1 AND kind='cta' AND sequence=0",[registered.bindingId])).rows[0];
    if(state?.status==='blocked')fail('CTA_WRITE_BLOCKED','Chưa gắn được CTA: '+state.error_code,409);
    if(state?.status==='verified'){
     if(!planDocWrite(await docs.read(event.doc_id),binding,job).verified)fail('DOC_READBACK_FAILED','CTA đọc lại chưa khớp link chung.',503);
     return{documentId:event.doc_id,status:'verified',code:selectedCode,entryMode:'shared',bindingId:registered.bindingId,assignmentId:registered.assignmentId};
    }
    if(Date.now()>=deadline)break;
    await sleep(250);
   }while(true);
   fail('CTA_PENDING','CTA chung đang chờ ghi; thử lại cùng sự kiện để kiểm kết quả.',503);
  }
  const old=(await pool.query(`SELECT b.entry_hash,j.payload FROM listening_practice.binding b
   JOIN listening_practice.doc_job j ON j.binding_id=b.id AND j.kind='cta' AND j.sequence=0 WHERE b.document_id=$1`,[event.doc_id])).rows;
  if(old.length>1)fail('CTA_BINDING_AMBIGUOUS','Có nhiều link cho cùng tài liệu.');
  let entryToken=createHmac('sha256',entryKey).update(JSON.stringify([code,event.doc_id,event.classroom_course_id,event.coursework_id,event.submission_id,event.student_id])).digest('base64url');
  if(old.length){
   const previous=new URL(old[0].payload.url);
   entryToken=new URLSearchParams(previous.hash.split('?')[1]).get('entry');
   if(!entryToken||hash(entryToken)!==old[0].entry_hash||previous.searchParams.get('documentId')!==event.doc_id||previous.searchParams.get('assignmentCode')!==code)
    fail('CTA_STORED_LINK_INVALID','Link đã lưu không khớp đăng ký.');
  }
  const registered=await service.register({code,classId:owner.classId,classCode:event.class_name,studentRef:owner.studentRef,
   documentId:event.doc_id,tabId:target.tabId,contentVersion,entryToken,
   courseId:event.classroom_course_id,courseWorkId:event.coursework_id,submissionId:event.submission_id});
  const binding={document_id:event.doc_id,tab_id:target.tabId,code},job={kind:'cta',payload:{url:registered.entryUrl}};
  const initial=planDocWrite(document,binding,job);
  if(!initial.verified)await pool.query(`UPDATE listening_practice.doc_job SET status='pending',available_at=now(),attempts=0,verified_at=null
   WHERE binding_id=$1 AND kind='cta' AND sequence=0 AND status='verified'`,[registered.bindingId]);
  const deadline=Date.now()+waitMs;
  do{
   const state=(await pool.query("SELECT status,error_code FROM listening_practice.doc_job WHERE binding_id=$1 AND kind='cta' AND sequence=0",[registered.bindingId])).rows[0];
   if(state?.status==='blocked')fail('CTA_WRITE_BLOCKED','Chưa gắn được CTA: '+state.error_code,409);
   if(state?.status==='verified'){
    if(!planDocWrite(await docs.read(event.doc_id),binding,job).verified)fail('DOC_READBACK_FAILED','CTA đọc lại chưa khớp link đã đăng ký.',503);
    return{documentId:event.doc_id,status:'verified',code,bindingId:registered.bindingId,assignmentId:registered.assignmentId};
   }
   if(Date.now()>=deadline)break;
   await sleep(250);
  }while(true);
  fail('CTA_PENDING','CTA đang chờ ghi; thử lại cùng sự kiện để kiểm kết quả.',503);
 };
}
