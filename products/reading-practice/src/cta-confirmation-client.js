import {readFileSync} from 'node:fs';

const pageOrigin='https://tranhoangduc90.github.io';
const confirmationPath='/izone-ai-team-pages/classroom-confirmation/';

// Đọc đúng assignment và submission theo ID đã lấy từ Classroom. Không dùng
// tên Docs, tài khoản trình duyệt, hoặc kết quả mapping để đoán người nộp.
export function verifyClassroomCopy(auth,{fetcher=fetch}={}) {
  return async event=>{
    const {classroom_course_id:course,coursework_id:work,submission_id:submission,
      student_id:google,doc_id:document}=event;
    const access=await auth.getAccessToken();
    const token=typeof access==='string'?access:access?.token;
    if(!token) throw new Error('CLASSROOM_SOURCE_UNAVAILABLE');
    const path='https://classroom.googleapis.com/v1/courses/'+encodeURIComponent(course)+'/courseWork/'+encodeURIComponent(work);
    async function get(url) {
      const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(5000),
        headers:{authorization:'Bearer '+token}});
      if(!response.ok) throw new Error('CLASSROOM_SOURCE_UNAVAILABLE');
      return response.json();
    }
    const [assignment,copy]=await Promise.all([get(path),get(path+'/studentSubmissions/'+encodeURIComponent(submission))]);
    const templates=(assignment.materials||[]).filter(item=>item.driveFile?.shareMode==='STUDENT_COPY')
      .map(item=>item.driveFile.driveFile?.id).filter(Boolean);
    const attachments=(copy.assignmentSubmission?.attachments||[]).filter(item=>item.driveFile?.id===document);
    if(assignment.id!==work||assignment.courseId!==course||assignment.state!=='PUBLISHED'||
      !templates.length||templates.includes(document)||
      (assignment.assigneeMode==='INDIVIDUAL_STUDENTS'&&!assignment.individualStudentsOptions?.studentIds?.includes(google))||
      copy.id!==submission||copy.courseId!==course||copy.courseWorkId!==work||copy.userId!==google||
      attachments.length!==1) throw new Error('CLASSROOM_COPY_NOT_VERIFIED');
  };
}

// Gửi khóa xuất bản nội bộ. Dùng bộ lập kế hoạch Docs native để chỉ đổi hyperlink,
// khóa đúng revision và chỉ công nhận CTA sau khi đọc lại được.
export function createPendingPublisher({product,base,key,docs,planWrite,fetcher=fetch}) {
  if(!base&&!key) return null;
  if(typeof key!=='string'||key.length<32) throw new Error('CTA_CONFIRMATION_PUBLISHER_KEY_REQUIRED');
  const internal=new URL(base);
  if(!['http:','https:'].includes(internal.protocol)||internal.username||internal.password||internal.search||internal.hash)
    throw new Error('CTA_CONFIRMATION_INTERNAL_URL_INVALID');
  const endpoint=internal.href.replace(/\/$/,'');
  async function request(path,body) {
    const response=await fetcher(endpoint+'/internal/'+path,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(14000),
      headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify(body),
    });
    if(!response.ok) {
      const error=new Error('CTA_CONFIRMATION_PUBLISH_FAILED');
      error.code=response.status===409?'SOURCE_NOT_VERIFIED':'CTA_CONFIRMATION_UNAVAILABLE';
      error.status=response.status===409?409:503;
      throw error;
    }
    const result=await response.json();
    if(result.ok!==true) throw new Error('CTA_CONFIRMATION_PUBLISH_FAILED');
    return result;
  }
  return async ({event,document,binding,fallbackUrl,documentGuard})=>{
    const target=await request('prepare',{product,assignmentCode:binding.code,fallbackPath:fallbackUrl,
      documentId:event.doc_id,courseId:event.classroom_course_id,courseWorkId:event.coursework_id,
      submissionId:event.submission_id,googleUserId:event.student_id,classCode:event.class_name});
    const entry=new URL(target.entryUrl);
    if(entry.origin!==pageOrigin||entry.pathname!==confirmationPath||entry.search||
      !/^[0-9a-f-]{36}$/i.test(target.id)||entry.hash!=='#'+target.id) throw new Error('CTA_CONFIRMATION_LINK_INVALID');
    const job={kind:'cta',payload:{url:entry.href}};
    const plan=planWrite(document,binding,job);
    if(!plan.verified) await docs.write(event.doc_id,plan);
    const current=await docs.read(event.doc_id);
    documentGuard?.(current);
    if(current.documentId!==event.doc_id||!planWrite(current,binding,job).verified) throw new Error('CTA_CONFIRMATION_READBACK_FAILED');
    await request('activate',{id:target.id,product});
    return {status:'verified',assignmentCode:binding.code,code:binding.code,documentId:event.doc_id,
      entryUrl:entry.href,entryMode:'self-confirmation'};
  };
}

export function publisherFromEnv(env,settings) {
  const base=env.RL67_CONFIRMATION_INTERNAL_URL;
  const keyFile=env[`RL67_CONFIRMATION_${settings.product.toUpperCase().replaceAll('-','_')}_KEY_FILE`];
  if(!base&&!keyFile) return null;
  return createPendingPublisher({...settings,base,key:keyFile?readFileSync(keyFile,'utf8').trim():undefined});
}
