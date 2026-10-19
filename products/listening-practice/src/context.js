import {hash,fail} from './domain.js';
import {parseContextSnapshot} from './context-contract.js';

// Đọc bản chụp đã phiên bản hóa; không ghi hay truy vấn kho dữ liệu của sản phẩm khác.
export function createContext({url,key,fetcher=fetch,clock=Date.now}){
 let cache,pending;
 async function snapshot(){
  if(cache&&clock()-cache.loadedAt<30000&&clock()-Date.parse(cache.value.capturedAt)<120000)return cache.value;
  // Giữ cơ chế đang chạy: gộp lượt đọc nguồn đang chờ và không giữ lỗi.
  if(pending)return pending;
  pending=loadSnapshot();
  try{return await pending;}finally{pending=undefined;}
 }
 async function loadSnapshot(){
  let response;
  try{response=await fetcher(`${url.replace(/\/$/,'')}/v1/snapshot`,{headers:{'x-k67-context-key':key},signal:AbortSignal.timeout(5000)});}
  catch{fail('CONTEXT_UNAVAILABLE','Chưa kiểm được quyền lớp. Hãy thử lại sau.',503);}
  if(!response.ok)fail('CONTEXT_UNAVAILABLE','Nguồn quyền lớp chưa sẵn sàng.',503);
  const raw=await response.text();if(Buffer.byteLength(raw)>1048576)fail('CONTEXT_INVALID','Bản chụp quyền vượt giới hạn.',503);
  let value;try{value=JSON.parse(raw);}catch{fail('CONTEXT_INVALID','Nguồn quyền trả dữ liệu không hợp lệ.',503);}
  const {capturedAt,sourceRevision,...payload}=value;
  const age=clock()-Date.parse(capturedAt);
  if(value.apiVersion!==1||value.productId!=='PRODUCT-TERM-MINI-K67'||!Number.isFinite(age)||age < -5000||age>120000
   ||hash(JSON.stringify(payload))!==sourceRevision||!['classes','students','memberships','accounts','access'].every(k=>Array.isArray(value[k])))
   fail('CONTEXT_INVALID','Bản chụp quyền đã cũ hoặc không đúng hợp đồng.',503);
  try{value=parseContextSnapshot(value,clock());}catch{fail('CONTEXT_INVALID','Cấu trúc hoặc định danh nguồn quyền không hợp lệ.',503);}
  cache={value,loadedAt:clock()};return value;
 }
 async function roster(classId){
  const s=await snapshot();return s.students.filter(x=>x.erp_course_class_id===String(classId)&&x.status==='approved'
   &&s.memberships.some(m=>m.erp_course_class_id===x.erp_course_class_id&&m.erp_student_contact_id===x.erp_student_contact_id&&m.source_state==='active'))
   .map(x=>({studentRef:x.public_id,name:x.erp_student_name_snapshot}));
 }
 async function student(classId,id){return(await roster(classId)).find(x=>x.studentRef===id);}
 async function teacher(classId,email,subject){
  const s=await snapshot(),a=s.accounts.find(x=>x.email===email.toLowerCase()&&x.status==='active');
  return Boolean(a&&(!a.google_subject||a.google_subject===subject)&&(a.role==='admin'||a.can_access_all_classes
   ||s.access.some(x=>x.reviewer_email===a.email&&x.erp_course_class_id===String(classId))));
 }
 // Liệt kê từ cùng snapshot/roster đã kiểm; quyền Google/lớp vẫn kiểm riêng khi đọc.
 async function classes(){
  const s=await snapshot(),result=[];
  for(const row of s.classes){if((await roster(row.erp_course_class_id)).length)result.push({id:row.erp_course_class_id,classCode:row.erp_class_name_snapshot});}
  return result.sort((a,b)=>a.classCode.localeCompare(b.classCode,'vi'));
 }
 return{snapshot,roster,student,teacher,classes};
}
