import {z} from 'zod';
import {fail,CODE,hash} from './domain.js';
import {planDocWrite} from './docs.js';

// Tra UUID đã duyệt từ định danh Classroom; phản hồi phải mới, đúng cặp nguồn và có hash hợp lệ.
export function createOwnerResolver({url,key,fetcher=fetch,clock=Date.now}){
 const schema=z.object({apiVersion:z.literal(1),classId:z.string().regex(/^-?\d{1,19}$/),studentRef:z.uuid(),courseId:z.string(),googleUserId:z.string(),capturedAt:z.iso.datetime(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
 return async({courseId,googleUserId})=>{
  let response;
  try{response=await fetcher(`${url.replace(/\/$/,'')}/v1/owner-by-classroom?courseId=${encodeURIComponent(courseId)}&googleUserId=${encodeURIComponent(googleUserId)}`,{headers:{'x-listening-owner-key':key},signal:AbortSignal.timeout(5000)});}catch{fail('OWNER_SOURCE_UNAVAILABLE','Chưa đối chiếu được chủ bài.',503);}
  if(!response.ok)fail('OWNER_SOURCE_UNAVAILABLE','Không có đúng một mapping đã duyệt cho học viên/lớp.',503);
  const parsed=schema.safeParse(await response.json());if(!parsed.success)fail('OWNER_SOURCE_INVALID','Nguồn mapping trả sai cấu trúc.',503);
  const {capturedAt,sourceRevision,...payload}=parsed.data,age=clock()-Date.parse(capturedAt);
  if(age < -5000||age>120000||hash(JSON.stringify(payload))!==sourceRevision||payload.courseId!==courseId||payload.googleUserId!==googleUserId)
   fail('OWNER_MISMATCH','Định danh Classroom không khớp mapping.',403);
  return payload;
 };
}

// UUID/Google user lấy từ mapping đã duyệt; bản Docs lấy từ đúng submission Classroom. Không nối bằng tên.
export function createOwnerVerifier({url,key,auth,docs,fetcher=fetch,clock=Date.now}){
 const sourceSchema=z.object({apiVersion:z.literal(1),classId:z.string(),studentRef:z.uuid(),courseId:z.string().min(1),googleUserId:z.string().min(1),capturedAt:z.iso.datetime(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
 return async function verify(input){
  if(!input.courseId||!input.courseWorkId||!input.submissionId)fail('OWNER_PROOF_REQUIRED','Bản Docs phải có nguồn bản sao Classroom.',400);
  let response;
  try{response=await fetcher(`${url.replace(/\/$/,'')}/v1/owner?classId=${encodeURIComponent(input.classId)}&studentRef=${encodeURIComponent(input.studentRef)}`,{headers:{'x-listening-owner-key':key},signal:AbortSignal.timeout(5000)});}catch{fail('OWNER_SOURCE_UNAVAILABLE','Chưa đối chiếu được chủ bài.',503);}
  if(!response.ok)fail('OWNER_SOURCE_UNAVAILABLE','Mapping chủ bài chưa hợp lệ hoặc nguồn chưa sẵn sàng.',503);
  const parsed=sourceSchema.safeParse(await response.json());if(!parsed.success)fail('OWNER_SOURCE_INVALID','Nguồn mapping trả sai cấu trúc.',503);
  const source=parsed.data,{capturedAt,sourceRevision,...payload}=source,age=clock()-Date.parse(capturedAt);
  if(age < -5000||age>120000||hash(JSON.stringify(payload))!==sourceRevision||source.classId!==input.classId||source.studentRef!==input.studentRef||source.courseId!==input.courseId)
   fail('OWNER_MISMATCH','Lớp, UUID và nguồn Classroom không khớp.',403);
  const access=await auth.getAccessToken(),ids=[input.courseId,input.courseWorkId,input.submissionId].map(encodeURIComponent);
  const submissionResponse=await fetcher(`https://classroom.googleapis.com/v1/courses/${ids[0]}/courseWork/${ids[1]}/studentSubmissions/${ids[2]}`,{headers:{Authorization:`Bearer ${typeof access==='string'?access:access.token}`},signal:AbortSignal.timeout(10000)});
  if(!submissionResponse.ok)fail('CLASSROOM_SOURCE_UNAVAILABLE','Chưa đọc được bản sao từ Classroom.',503);
  const submission=await submissionResponse.json(),files=submission.assignmentSubmission?.attachments?.filter(x=>x.driveFile?.id===input.documentId)||[];
  if(submission.id!==input.submissionId||submission.courseId!==input.courseId||submission.courseWorkId!==input.courseWorkId||submission.userId!==source.googleUserId||files.length!==1)
   fail('DOCUMENT_OWNER_MISMATCH','Bản Docs không thuộc bài Classroom của đúng học viên.',403);
  const document=await docs.read(input.documentId);
  planDocWrite(document,{document_id:input.documentId,tab_id:input.tabId,code:input.code||CODE,last_doc_text:''},{kind:'cta',payload:{url:'https://example.invalid/listening-owner-check'}});
  return{sourceRevision,courseId:input.courseId,courseWorkId:input.courseWorkId,submissionId:input.submissionId,googleUserId:source.googleUserId,documentId:input.documentId,tabId:input.tabId,code:input.code||CODE,verifiedAt:new Date(clock()).toISOString()};
 };
}

// Đọc mapping đã duyệt bằng UUID và lớp; dùng chung cho link cá nhân và tìm Homework từ link chung.
export async function readOwnerSource({url,key,fetcher=fetch,clock=Date.now},input){
 const schema=z.object({apiVersion:z.literal(1),classId:z.string(),studentRef:z.uuid(),courseId:z.string().min(1),googleUserId:z.string().min(1),capturedAt:z.iso.datetime(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
 let response;
 try{response=await fetcher(`${url.replace(/\/$/,'')}/v1/owner?classId=${encodeURIComponent(input.classId)}&studentRef=${encodeURIComponent(input.studentRef)}`,{headers:{'x-listening-owner-key':key},signal:AbortSignal.timeout(5000)});}catch{fail('OWNER_SOURCE_UNAVAILABLE','Chưa đối chiếu được chủ bài.',503);}
 if(!response.ok)fail('OWNER_SOURCE_UNAVAILABLE','Mapping chủ bài chưa hợp lệ hoặc nguồn chưa sẵn sàng.',503);
 const parsed=schema.safeParse(await response.json());if(!parsed.success)fail('OWNER_SOURCE_INVALID','Nguồn mapping trả sai cấu trúc.',503);
 const source=parsed.data,{capturedAt,sourceRevision,...payload}=source,age=clock()-Date.parse(capturedAt);
 if(age < -5000||age>120000||hash(JSON.stringify(payload))!==sourceRevision||source.classId!==input.classId||source.studentRef!==input.studentRef)
  fail('OWNER_MISMATCH','Lớp, UUID và nguồn Classroom không khớp.',403);
 return source;
}
