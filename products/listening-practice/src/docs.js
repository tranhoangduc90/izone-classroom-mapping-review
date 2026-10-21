import {CODE,fail,uuid} from './domain.js';
import {transaction} from './service.js';
import {authoredLesson} from './authored-content.js';

export const STATUS_HEADING='TÌNH TRẠNG NỘP BÀI THỰC CHIẾN';
export const CTA='NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING';
const LINK='nhấn vào đây';
const AUTHORED_STATUS_PREFIX='Listening thực chiến (tự động): ';
const runs=content=>(content||[]).flatMap(e=>e.paragraph?.elements||[]).filter(e=>e.textRun).map(e=>({start:e.startIndex,end:e.endIndex,text:e.textRun.content,link:e.textRun.textStyle?.link?.url||''}));
const text=cell=>runs(cell?.content).map(r=>r.text).join('').replace(/\n$/,'');
function tabs(list){return(list||[]).flatMap(t=>[t,...tabs(t.childTabs)]);}
function walk(content,visitor){for(const e of content||[]){visitor(e);for(const row of e.table?.tableRows||[])for(const cell of row.tableCells||[])walk(cell.content,visitor);}}
function checkedTab(document,binding){
 if(document.documentId!==binding.document_id||!document.revisionId)fail('DOC_IDENTITY_MISMATCH','Docs không đúng bản đã gắn.');
 const tab=tabs(document.tabs).find(t=>t.tabProperties?.tabId===binding.tab_id);
 if(!tab)fail('DOC_TAB_NOT_FOUND','Không còn tab bài tập đã đăng ký.');
 let codeCount=0;walk(tab.documentTab?.body?.content,e=>{codeCount+=runs([e]).map(r=>r.text).join('').split(binding.code||CODE).length-1;});
 if(codeCount!==1)fail('DOC_CODE_MISMATCH','Không tìm thấy đúng một mã bài trong tab.');
 return tab;
}
function statusCell(tab){
 const matches=[];walk(tab.documentTab?.body?.content,e=>{
  const rows=e.table?.tableRows||[];
  for(let i=0;i<rows.length-1;i++)if(text(rows[i].tableCells?.[0]).trim()===STATUS_HEADING&&rows[i+1].tableCells?.[0])matches.push(rows[i+1].tableCells[0]);
 });
 if(matches.length!==1)fail('DOC_STATUS_AMBIGUOUS','Ô tình trạng nộp bài bị thiếu hoặc trùng.');return matches[0];
}
function linkAt(runs,start,end,url){
 let covered=start;
 for(const r of runs.filter(r=>r.end>start&&r.start<end).sort((a,b)=>a.start-b.start)){
  if(r.start>covered||r.link!==url)return false;covered=Math.max(covered,Math.min(r.end,end));
 }
 return covered>=end;
}
// Bài mới kế thừa cách ghi một dòng của Reading: không đụng chữ/link thủ công, retry không nhân đôi.
function authoredStatusPlan(document,binding,job,tab){
 const cell=statusCell(tab),rs=runs(cell.content),existing=text(cell),tabId=binding.tab_id;
 const target=AUTHORED_STATUS_PREFIX+job.payload.text;
 const managed=existing.split('\n').filter(line=>line.startsWith(AUTHORED_STATUS_PREFIX));
 if(managed.length>1)fail('DOC_STATUS_AMBIGUOUS','Có nhiều dòng trạng thái Listening tự động.');
 function indexAt(offset){
  let used=0;
  for(const r of rs){if(offset<used+r.text.length)return r.start+offset-used;used+=r.text.length;}
  fail('DOC_STATUS_INVALID','Không xác định được vị trí dòng trạng thái.');
 }
 const old=managed[0],offset=old?existing.indexOf(old):existing.length,start=indexAt(offset);
 const labelOffset=target.indexOf(LINK),linkStart=start+labelOffset,linkEnd=linkStart+LINK.length;
 if(old===target&&(!job.payload.link||linkAt(rs,linkStart,linkEnd,job.payload.link)))return{revisionId:document.revisionId,requests:[],verified:true};
 if(old&&old!==AUTHORED_STATUS_PREFIX+binding.last_doc_text&&old!==target)fail('DOC_MANUAL_CONFLICT','Dòng tự động đã được sửa tay; giữ nguyên để kiểm tra.');
 const requests=[];
 if(old)requests.push({deleteContentRange:{range:{startIndex:start,endIndex:start+old.length,tabId}}});
 const prefix=!old&&existing?'\n':'',textStart=start+prefix.length;
 requests.push({insertText:{location:{index:start,tabId},text:prefix+target}},
  {updateTextStyle:{range:{startIndex:textStart,endIndex:textStart+target.length,tabId},textStyle:{bold:false,foregroundColor:{color:{rgbColor:{red:0.082,green:0.169,blue:0.306}}},fontSize:{magnitude:11,unit:'PT'}},fields:'link,bold,foregroundColor,fontSize'}});
 if(job.payload.link){
  if(labelOffset<0)fail('DOC_LINK_LABEL_INVALID','Thiếu nhãn mở kết quả.');
  requests.push({updateTextStyle:{range:{startIndex:textStart+labelOffset,endIndex:textStart+labelOffset+LINK.length,tabId},textStyle:{link:{url:job.payload.link},underline:true},fields:'link,underline'}});
 }
 return{revisionId:document.revisionId,requests,verified:false};
}
// Chỉ thay ô do Listening quản lý. Revision khóa việc ghi; ô người dùng sửa tay được giữ nguyên.
export function planDocWrite(document,binding,job){
 const tab=checkedTab(document,binding),tabId=binding.tab_id;
 if(job.kind==='cta'){
  const matches=[];walk(tab.documentTab?.body?.content,e=>{
   const rs=runs([e]),value=rs.map(r=>r.text).join(''),index=value.indexOf(CTA);
   if(index>=0)matches.push({start:rs[0].start+index,end:rs[0].start+index+CTA.length,runs:rs});
  });
  if(matches.length!==1)fail('DOC_CTA_AMBIGUOUS','Nút mở bài bị thiếu hoặc trùng.');
  const match=matches[0];
  const good=linkAt(match.runs,match.start,match.end,job.payload.url);
  return{revisionId:document.revisionId,requests:good?[]:[{updateTextStyle:{range:{startIndex:match.start,endIndex:match.end,tabId},textStyle:{link:{url:job.payload.url},underline:false,foregroundColor:{color:{rgbColor:{red:1,green:1,blue:1}}}},fields:'link,underline,foregroundColor'}}],verified:good};
 }
 if(authoredLesson(binding.code))return authoredStatusPlan(document,binding,job,tab);
 const cell=statusCell(tab),rs=runs(cell.content),existing=text(cell),target=job.payload.text;
 const start=rs[0]?.start;if(!Number.isInteger(start))fail('DOC_STATUS_INVALID','Ô nộp bài không có đoạn văn hợp lệ.');
 const linkStart=start+target.indexOf(LINK),linkEnd=linkStart+LINK.length;
 const good=existing===target&&(!job.payload.link||linkAt(rs,linkStart,linkEnd,job.payload.link));
 if(good)return{revisionId:document.revisionId,requests:[],verified:true};
 if(existing!==binding.last_doc_text)fail('DOC_MANUAL_CONFLICT','Ô tình trạng đã được sửa tay; cần giảng viên kiểm tra.');
 const requests=[];
 if(existing)requests.push({deleteContentRange:{range:{startIndex:start,endIndex:start+existing.length,tabId}}});
 requests.push({insertText:{location:{index:start,tabId},text:target}},
  {updateTextStyle:{range:{startIndex:start,endIndex:start+target.length,tabId},textStyle:{bold:false,foregroundColor:{color:{rgbColor:{red:0.082,green:0.169,blue:0.306}}},fontSize:{magnitude:11,unit:'PT'}},fields:'link,bold,foregroundColor,fontSize'}});
 if(job.payload.link){
  if(!target.includes(LINK))fail('DOC_LINK_LABEL_INVALID','Thiếu nhãn mở kết quả.');
  requests.push({updateTextStyle:{range:{startIndex:linkStart,endIndex:linkEnd,tabId},textStyle:{link:{url:job.payload.link},underline:true},fields:'link,underline'}});
 }
 return{revisionId:document.revisionId,requests,verified:false};
}
export function createDocsAdapter(auth){
 async function call(documentId,suffix,body){
  const access=await auth.getAccessToken();
  const response=await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}${suffix}`,{
   method:body?'POST':'GET',headers:{Authorization:`Bearer ${typeof access==='string'?access:access.token}`,'Content-Type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  if(!response.ok){const e=new Error('Google Docs request failed');e.code=[401,403,404].includes(response.status)?`DOC_HTTP_${response.status}`:'DOC_RETRY';throw e;}
  return response.json();
 }
 return{read:id=>call(id,'?includeTabsContent=true'),write:(id,plan)=>call(id,':batchUpdate',{requests:plan.requests,writeControl:{requiredRevisionId:plan.revisionId}})};
}
// Hàng xử lý có thứ tự theo học viên. Ghi xong phải đọc lại chữ và link trước khi báo verified.
export function createDocsWorker({pool,docs,resolveSharedHomework}){
 async function once(){
  const job=await transaction(pool,async db=>{
   const row=(await db.query(`SELECT j.* FROM listening_practice.doc_job j WHERE
    ((j.status='pending' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<now()))
    AND NOT EXISTS(SELECT 1 FROM listening_practice.doc_job old WHERE old.binding_id=j.binding_id AND old.sequence<j.sequence AND old.status<>'verified')
    ORDER BY j.created_at,j.sequence LIMIT 1 FOR UPDATE OF j SKIP LOCKED`)).rows[0];
   if(!row)return null;
   const leaseId=uuid();await db.query("UPDATE listening_practice.doc_job SET status='processing',lease_id=$2,lease_until=now()+interval '180 seconds',attempts=attempts+1 WHERE id=$1",[row.id,leaseId]);
   return{...row,leaseId,attempts:row.attempts+1};
  });
  if(!job)return false;
  try{
   let b=(await pool.query('SELECT b.*,a.class_id,c.code FROM listening_practice.binding b JOIN listening_practice.assignment a ON a.id=b.assignment_id JOIN listening_practice.content c ON c.id=a.content_id WHERE b.id=$1',[job.binding_id])).rows[0];
   if(!b.document_id){
    if(b.owner_proof?.mode!=='shared'||!resolveSharedHomework)fail('DOC_OWNER_UNAVAILABLE','Chưa cấu hình đối chiếu Homework cho link chung.');
    const target=await resolveSharedHomework(b);
    if(!target?.documentId||!target.tabId||target.classId!==b.class_id||target.studentRef!==b.student_ref||target.code!==b.code)fail('DOC_IDENTITY_MISMATCH','Homework tìm được không khớp hồ sơ Listening.');
    await pool.query("UPDATE listening_practice.binding SET owner_proof=jsonb_set(owner_proof,'{homework}',$2::jsonb) WHERE id=$1 AND document_id IS NULL AND owner_proof->>'mode'='shared'",[b.id,JSON.stringify(target)]);
    b={...b,document_id:target.documentId,tab_id:target.tabId};
   }
   let plan=planDocWrite(await docs.read(b.document_id),b,job);
   if(!plan.verified){await docs.write(b.document_id,plan);plan=planDocWrite(await docs.read(b.document_id),{...b,last_doc_text:job.kind==='status'?job.payload.text:b.last_doc_text},job);}
   if(!plan.verified)fail('DOC_READBACK_FAILED','Google Docs chưa khớp chữ và link.');
   await transaction(pool,async db=>{
    const verified=(await db.query("UPDATE listening_practice.doc_job SET status='verified',verified_at=now(),error_code=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='processing' RETURNING id",[job.id,job.leaseId])).rows.length;
    if(!verified)return;
    if(job.kind==='cta')await db.query('UPDATE listening_practice.binding SET cta_verified_at=now() WHERE id=$1',[b.id]);
    else await db.query('UPDATE listening_practice.binding SET last_doc_sequence=$2,last_doc_text=$3,last_doc_link=$4 WHERE id=$1 AND last_doc_sequence<$2',[b.id,job.sequence,job.payload.text,job.payload.link]);
   });
  }catch(error){
   // Homework có thể được giao sau ngày mở bài: chờ năm phút rồi đối chiếu lại đúng người/mã.
   // Việc chưa có đích không phải lỗi ghi; giữ thứ tự và bài làm, không hết lượt thử sau tám lần.
   const code=error.code||'DOC_RETRY',waitingForHomework=code==='HOMEWORK_NOT_FOUND';
   const blocked=!waitingForHomework&&(/^DOC_(IDENTITY|TAB|CODE|STATUS|CTA|MANUAL|LINK|HTTP_)/.test(code)||job.attempts>=8);
   const delay=waitingForHomework?300:Math.min(300,2**Math.min(job.attempts,9));
   await pool.query("UPDATE listening_practice.doc_job SET status=$3,error_code=$4,available_at=now()+$5*interval '1 second',lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='processing'",[job.id,job.leaseId,blocked?'blocked':'pending',code,delay]);
  }
  return true;
 }
 return{once};
}
