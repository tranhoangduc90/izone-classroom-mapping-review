import {createHash} from 'node:crypto';
import {speakingCheckView} from './speaking-check-retry.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=code=>Object.assign(Error(code),{code,status:503});
const dates=(row,fields)=>Object.fromEntries(Object.entries(row).map(([key,value])=>
 [key,value&&fields.includes(key)?new Date(value):value]));
const picked=(row,fields)=>Object.fromEntries(fields.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
const mainFields=['id','part','revision','share_url','share_id','fingerprint','check_status','check_code',
 'question_count','evidence','typing_warning','voice_confirmed','checked_at'];
const practiceFields=['id','slot','revision','share_url','exercise_id','status','check_code','question_count',
 'evidence','typing_warning','voice_confirmed','analysis_status'];

// Dấu nội dung dùng được cả lúc chỉ đọc metadata. Nguồn catalog phải đã được adapter
// kiểm hiện hành; Docs/job ghi Docs không nằm trong dấu này.
export function speakingContentRevision(row,context){
 if(!row||!/^[a-f0-9]{32}$/.test(row.content_revision||''))throw invalid('SPEAKING_STATE_DATA_INVALID');
 if(row.schema==='speaking_independent'){
  if(!Array.isArray(context?.exercises))throw invalid('SPEAKING_STATE_CONTEXT_INVALID');
  return digest([row.schema,row.unit_id,row.content_revision,context.exercises]);
 }
 if(row.schema!=='speaking_homework')throw invalid('SPEAKING_STATE_SCHEMA_INVALID');
 return digest([row.schema,row.unit_id,row.content_revision]);
}
export const speakingDocsRevision=row=>digest([row.schema,row.unit_id,row.document_id,row.docs_progress,row.docs_jobs]);

// Chuyển snapshot cùng một câu SQL thành đúng hai view open/Doctor native.
// Chưa phải kiểm quyền: route/guard phải xác nhận đúng chủ và nguồn trước khi trả ra web.
export function speakingObservationView(row,context){
 const contentRevision=speakingContentRevision(row,context),body=row.content;
 if(!body||!Array.isArray(body.links)||!Array.isArray(body.jobs)||!Array.isArray(body.recommendations))
  throw invalid('SPEAKING_STATE_CONTENT_REQUIRED');
 const receipt=row.receipt_id?{id:row.receipt_id,created_at:new Date(row.receipt_created_at)}:null;
 const docsProgress=row.docs_progress?dates(row.docs_progress,['verified_at']):null;
 let open,doctor;
 if(row.schema==='speaking_independent'){
  const links=body.links.map(link=>({...dates(link,['created_at','checked_at']),linkId:link.id}));
  open={status:row.status,receipt,workUnitId:row.unit_id,documentId:row.document_id,docsProgress,
   links:links.filter(link=>link.kind==='main').map(link=>speakingCheckView({...link,check_status:link.status},
    body.jobs.find(job=>job.link_id===link.id&&job.kind==='check_main'),'check_status')),
   practiceLinks:links.filter(link=>link.kind==='practice').map(link=>({...speakingCheckView(link,
    body.jobs.find(job=>job.link_id===link.id&&job.kind==='check_practice')),
    analysis_status:body.jobs.find(job=>job.link_id===link.id&&job.kind==='analyze_practice')?.status||null})),
   processing:Object.fromEntries(body.jobs.filter(job=>!job.link_id).map(job=>[job.kind,{status:job.status}]))};
  const personal=body.recommendations.flatMap(rec=>{
   const exercise=context.exercises.find(exercise=>exercise.id===rec.exercise_id);
   return exercise?[{...dates(rec,['proposed_at','last_practiced_at']),title:exercise.title,exercise_url:exercise.exercise_url}]:[];
  });
  personal.sort((a,b)=>Number(b.waiting)-Number(a.waiting)||b.recommendation_count-a.recommendation_count||a.title.localeCompare(b.title));
  const needed=personal.filter(rec=>rec.waiting);
  doctor={needed:needed.slice(0,5),allNeeded:needed,neededCount:needed.length,practiced:personal.filter(rec=>!rec.waiting),personalCount:personal.length,
   sharedCatalog:context.exercises.filter(exercise=>!personal.some(rec=>rec.exercise_id===exercise.id)).map(exercise=>({...exercise,exercise_id:exercise.id}))};
 }else{
  if(!body.assignment||!Array.isArray(body.practiceLinks)||!Array.isArray(body.parts)||!Array.isArray(body.catalog))
   throw invalid('SPEAKING_STATE_CONTENT_REQUIRED');
  open={processing:Object.fromEntries(body.jobs.map(job=>[job.kind,{status:job.status}])),
   assignment:{...body.assignment,classId:row.class_id},student:{ref:row.student_ref,name:row.student_name},status:row.status,
   parts:body.parts,links:body.links.map(link=>speakingCheckView(dates(picked(link,mainFields),['checked_at']),null,'check_status')),
   practiceLinks:body.practiceLinks.map(link=>speakingCheckView(picked(link,practiceFields),{status:link.check_job_status,attempts:link.check_job_attempts})),
   receipt,docsProgress};
  const personal=body.recommendations.map(rec=>dates(rec,['proposed_at','last_practiced_at'])),needed=personal.filter(rec=>rec.waiting);
  const assigned=new Set(personal.map(rec=>rec.exercise_id));
  doctor={needed:needed.slice(0,5),neededCount:needed.length,allNeeded:needed,practiced:personal.filter(rec=>!rec.waiting),
   sharedCatalog:body.catalog.filter(exercise=>!assigned.has(exercise.exercise_id)),personalCount:personal.length};
 }
 return {kind:'speaking-student-view-v1',unitId:row.unit_id,contentRevision,docsRevision:speakingDocsRevision(row),open,doctor};
}
