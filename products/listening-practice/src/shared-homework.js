import {fail} from './domain.js';
import {lessonFor} from './lessons.js';
import {createOwnerVerifier,readOwnerSource} from './owner.js';

const allTabs=list=>(list||[]).flatMap(t=>[t,...allTabs(t.childTabs)]);
function hasMarker(content,code){
 return(content||[]).some(e=>{
  const text=(e.paragraph?.elements||[]).map(p=>p.textRun?.content||'').join('');
  return text.split(/\r?\n/).some(line=>line.trim()===code)||
   (e.table?.tableRows||[]).some(r=>(r.tableCells||[]).some(c=>hasMarker(c.content,code)));
 });
}

// Tìm bản Homework bằng mapping UUID → Google user → submission → mã bài trong tab.
// Không chọn theo tên học viên; thiếu hoặc có nhiều đích thì để job chờ kiểm, không ghi nhầm.
export function createSharedHomeworkResolver({url,key,auth,docs,fetcher=fetch,clock=Date.now}){
 const verify=createOwnerVerifier({url,key,auth,docs,fetcher,clock});
 return async function resolve(binding){
  try{lessonFor(binding.code);}catch{fail('DOC_CODE_MISMATCH','Mã Listening chưa được đăng ký.');}
  if(binding.owner_proof?.mode!=='shared')fail('DOC_CODE_MISMATCH','Hồ sơ không dùng link Listening chung.');
  const identity={classId:binding.class_id,studentRef:binding.student_ref,code:binding.code};
  const cached=binding.owner_proof.homework;
  if(cached){
   if(cached.classId!==identity.classId||cached.studentRef!==identity.studentRef||cached.code!==identity.code)fail('DOC_IDENTITY_MISMATCH','Đích Homework đã lưu không đúng hồ sơ.');
   return{...identity,...await verify({...cached,...identity})};
  }
  const deadline=clock()+40000,source=await readOwnerSource({url,key,fetcher,clock},identity);
  const access=await auth.getAccessToken(),headers={Authorization:`Bearer ${typeof access==='string'?access:access.token}`};
  async function get(path,params={}){
   const remaining=deadline-clock();if(remaining<=0)fail('HOMEWORK_LOOKUP_TIMEOUT','Tìm Homework vượt thời gian; sẽ thử lại.');
   const endpoint=new URL('https://classroom.googleapis.com/v1/'+path);
   for(const [k,v] of Object.entries(params))if(v!==undefined)endpoint.searchParams.set(k,v);
   const r=await fetcher(endpoint.href,{headers,signal:AbortSignal.timeout(Math.min(10000,remaining))});
   if(!r.ok)fail(`HOMEWORK_HTTP_${r.status}`,'Chưa đọc được Homework từ Classroom.',503);
   return r.json();
  }
  async function list(path,field,params){
   const items=[];let pageToken;const seen=new Set();
   do{
    const page=await get(path,{...params,pageSize:'100',pageToken});items.push(...(page[field]||[]));
    pageToken=page.nextPageToken;
    if(pageToken){if(seen.has(pageToken)||seen.size>=9)fail('HOMEWORK_LOOKUP_LIMIT','Danh sách Homework quá lớn; cần kiểm tra.');seen.add(pageToken);}
   }while(pageToken);
   return items;
  }
  const course=encodeURIComponent(source.courseId);
  const works=await list(`courses/${course}/courseWork`,'courseWork',{courseWorkStates:'PUBLISHED'});
  const candidates=new Map();
  for(const work of works){
   if(work.state!=='PUBLISHED')continue;
   if(work.courseId!==source.courseId||!work.id)fail('DOC_IDENTITY_MISMATCH','Bài Homework không khớp lớp Classroom.');
   if(work.assigneeMode==='INDIVIDUAL_STUDENTS'&&!work.individualStudentsOptions?.studentIds?.includes(source.googleUserId))continue;
   const templates=(work.materials||[]).filter(m=>m.driveFile?.shareMode==='STUDENT_COPY').map(m=>m.driveFile.driveFile?.id).filter(Boolean);
   if(templates.length)candidates.set(work.id,templates);
  }
  const targets=[];
  if(candidates.size){
   const submissions=await list(`courses/${course}/courseWork/-/studentSubmissions`,'studentSubmissions',{userId:source.googleUserId});
   const seen=new Set();
   for(const submission of submissions){
    if(submission.userId!==source.googleUserId||submission.courseId!==source.courseId||!submission.courseWorkId||!submission.id)
     fail('DOC_IDENTITY_MISMATCH','Classroom trả bài của người hoặc lớp khác.');
    const templates=candidates.get(submission.courseWorkId);
    if(!templates)continue;
    for(const attachment of submission.assignmentSubmission?.attachments||[]){
     const documentId=attachment.driveFile?.id;
     if(!documentId||templates.includes(documentId)||attachment.driveFile.mimeType&&attachment.driveFile.mimeType!=='application/vnd.google-apps.document')continue;
     const sourceKey=JSON.stringify([submission.courseWorkId,submission.id,documentId]);
     if(seen.has(sourceKey))continue;
     seen.add(sourceKey);
     if(clock()>=deadline)fail('HOMEWORK_LOOKUP_TIMEOUT','Tìm Homework vượt thời gian; sẽ thử lại.');
     const document=await docs.read(documentId);
     if(document.documentId!==documentId)fail('DOC_IDENTITY_MISMATCH','Tài liệu đọc lại khác bản sao Classroom.');
     for(const tab of allTabs(document.tabs))if(hasMarker(tab.documentTab?.body?.content,binding.code)){
      targets.push({...identity,courseId:source.courseId,courseWorkId:submission.courseWorkId,submissionId:submission.id,documentId,tabId:tab.tabProperties?.tabId});
     }
    }
   }
  }
  if(targets.length!==1)fail(targets.length?'DOC_STATUS_AMBIGUOUS':'HOMEWORK_NOT_FOUND',targets.length?'Có nhiều Homework cùng mã; cần kiểm tra.':'Chưa có bản Homework cá nhân đúng mã; sẽ thử lại.');
  return{...identity,...await verify(targets[0])};
 };
}
