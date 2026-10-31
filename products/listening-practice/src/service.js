import {CODE,TOTAL_MS,ListeningError,fail,hash,secret,uuid,emptyDraft,validateContent,grade,statusMessage,
 issueLease,checkpoint,recoverCheckpoint,publicAttempt,checkLease,canonical} from './domain.js';
import {timingFor} from './domain.js';
import {authoredLesson} from './authored-content.js';
import {lessonFor} from './lessons.js';
import {createTeacherProgress} from './teacher-progress.js';
import {createEntryContext} from './entry-context.js';

// Chỉ dùng pool của kho Reading. Mọi thay đổi lượt và job Docs cùng commit hoặc rollback.
export async function transaction(pool,fn){
 const client=await pool.connect();
 try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
const initialState=()=>({attempts:[],events:[],firstCompleted:null,sequence:0});
export function createListeningService({pool,context,clock=Date.now,pageBase,resolveCurrentOwner,verifyBinding=async()=>fail('OWNER_PROOF_REQUIRED','Chưa cấu hình đối chiếu chủ bản Docs.',503)}){
 const entryContext=createEntryContext({pool,context,schema:'listening_practice',fail,lessonFor:code=>authoredLesson(code),resolveCurrentOwner});
 async function guardEntry({documentId,code,token,entryToken}){
  const expected=await entryContext.resolve({documentId,code}),b=await binding(pool,{token,entryToken});
  if(b.id!==expected.bindingId)fail('ENTRY_OWNER_MISMATCH','Phiên đã lưu khác chủ link. Hãy xác nhận đúng người học.',403);
  return expected;
 }
 const teacherUrl=id=>`${pageBase}teacher.html#submission=${id}`;
 async function binding(db,{token,entryToken,bindingId,history=false}){
  const params=[token?hash(token):entryToken?hash(entryToken):bindingId];
  const where=token?'b.id=(SELECT binding_id FROM listening_practice.student_session WHERE token_hash=$1 AND expires_at>now())'
   :entryToken?'b.entry_hash=$1':'b.id=$1';
  const rows=(await db.query(`SELECT b.*,a.class_id,a.class_code,a.status AS assignment_status,a.content_id,
   c.code,c.version,c.definition,c.answer_key,c.explanations FROM listening_practice.binding b
   JOIN listening_practice.assignment a ON a.id=b.assignment_id JOIN listening_practice.content c ON c.id=a.content_id
   WHERE ${where}`,params)).rows;
  if(rows.length!==1)fail('UNAUTHORIZED','Link hoặc phiên bài Reading không còn hợp lệ.',401);
  const b=rows[0];b.member=await context.student(b.class_id,b.student_ref);
  if(!b.member&&!history)fail('STUDENT_NOT_ELIGIBLE','Hồ sơ học viên chưa có quyền mở bài này.',403);
  b.member??={name:'Học viên không còn trong danh sách đang học'};
  return b;
 }
 async function view(db,b,state,{lease,definition=false}={}){
  const jobs=(await db.query('SELECT sequence,status,error_code FROM listening_practice.doc_job WHERE binding_id=$1 ORDER BY sequence',[b.id])).rows;
  const events=state.events.map(e=>({...e,docs:jobs.find(j=>j.sequence===e.sequence)?.status||'pending'}));
  return{identity:{studentRef:b.student_ref,name:b.member.name,classCode:b.class_code,assignmentId:b.assignment_id,
   bindingId:b.id,entryMode:b.document_id?'homework':'shared',documentId:b.document_id||b.owner_proof?.homework?.documentId||null,documentUrl:(b.document_id||b.owner_proof?.homework?.documentId)?`https://docs.google.com/document/d/${b.document_id||b.owner_proof.homework.documentId}/edit?tab=${encodeURIComponent(b.tab_id||b.owner_proof.homework.tabId)}`:null},
   lesson:authoredLesson(b.code),attempts:state.attempts.map(publicAttempt),events,firstCompleted:state.firstCompleted,
   ...(lease?{lease}:{}),...(definition?{definition:b.definition}:{})};
 }
 async function work(db,b){
  await db.query('INSERT INTO listening_practice.work(binding_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING',[b.id,initialState()]);
  return(await db.query('SELECT state FROM listening_practice.work WHERE binding_id=$1 FOR UPDATE',[b.id])).rows[0].state;
 }
 async function save(db,b,state){await db.query('UPDATE listening_practice.work SET state=$2,updated_at=now() WHERE binding_id=$1',[b.id,state]);}
 async function enqueue(db,b,state,a){
  const sequence=++state.sequence,message=statusMessage(a,state.firstCompleted);
  state.events.push({type:a.status==='submitted'?'completed':'started',attempt:a.no,message,at:new Date(clock()).toISOString(),sequence});
  await db.query(`INSERT INTO listening_practice.doc_job(id,binding_id,sequence,kind,payload) VALUES($1,$2,$3,'status',$4)`,
   [uuid(),b.id,sequence,{text:message,link:a.submissionId?teacherUrl(a.submissionId):'',attemptId:a.id,attemptNo:a.no}]);
 }
 async function operation(input,kind,fn){
  if(!/^[0-9a-f-]{36}$/i.test(input.operationId||''))fail('OPERATION_REQUIRED','Thao tác thiếu mã chống gửi lặp.',400);
  return transaction(pool,async db=>{
   const b=await binding(db,{token:input.token}),state=await work(db,b);
   const fingerprint=hash(canonical({kind,...input,token:undefined,operationId:undefined}));
   const old=(await db.query('SELECT fingerprint,response FROM listening_practice.operation WHERE binding_id=$1 AND operation_id=$2',[b.id,input.operationId])).rows[0];
   if(old){
    if(old.fingerprint!==fingerprint)fail('OPERATION_CONFLICT','Mã thao tác đã dùng cho nội dung khác.');
    const proof=old.response.lease,a=state.attempts.at(-1);
    const lease=proof?.id===a?.lease?.id&&['running','paused'].includes(a.status)&&clock()-a.lease.lastSeen<=7000?proof:undefined;
    return view(db,b,state,{lease,definition:Boolean(old.response.definition)});
   }
   const result=await fn(db,b,state);await save(db,b,state);
   await db.query('INSERT INTO listening_practice.operation(binding_id,operation_id,fingerprint,response) VALUES($1,$2,$3,$4)',[b.id,input.operationId,fingerprint,result]);
   return result;
  });
 }
 function active(state,id){
  const a=state.attempts.at(-1);
  if(!a||a.id!==id)fail('ATTEMPT_CHANGED','Lần làm bài đã đổi. Hãy tải lại bài.');
  if(!['running','paused'].includes(a.status))fail('ATTEMPT_CLOSED','Lần này đã được nộp hoặc reset.');
  return a;
 }
 function submitted(a,b,state,method){
  a.status='submitted';a.method=method;a.completedAt=new Date(clock()).toISOString();a.submissionId=uuid();
  if(method==='timeout')a.usedMs=timingFor(b.code).totalMs;
  a.result=grade(a.draft.answers,b.answer_key,b.code,b.definition);a.finalScore=a.result.score;
  state.firstCompleted??=a.no;
  // Giữ proof cuối để gửi lại đúng snapshot đã khóa; không nhận sửa bài sau nộp.
  a.finalDraftHash=hash(JSON.stringify(a.draft));
 }
 function createAttempt(state,owner,code=CODE){
  const a={id:uuid(),no:state.attempts.length+1,status:'running',phase:'listening',usedMs:0,draft:emptyDraft(code),...(authoredLesson(code)?{code}:{}),startedAt:new Date(clock()).toISOString()};
  state.attempts.push(a);const lease=issueLease(a,owner,clock());return{a,lease};
 }
 async function seedContent(bundle){
  validateContent(bundle);const digest=hash(JSON.stringify(bundle));
  const id=bundle.id||uuid();
  const row=(await pool.query(`INSERT INTO listening_practice.content(id,code,version,digest,definition,answer_key,explanations,total_ms)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(code,version) DO UPDATE SET digest=EXCLUDED.digest
   WHERE listening_practice.content.digest=EXCLUDED.digest RETURNING id`,
   [id,bundle.code,bundle.version,digest,bundle.definition,bundle.key,bundle.explanations,bundle.totalMs])).rows[0];
  if(!row)fail('CONTENT_VERSION_CONFLICT','Nội dung đổi phải dùng version mới.');return{id:row.id,digest};
 }
 async function register(input){
  if(!await context.student(input.classId,input.studentRef))fail('STUDENT_NOT_ELIGIBLE','UUID không thuộc hồ sơ đang học của lớp.',403);
  const proof=await verifyBinding(input);
  return transaction(pool,async db=>{
   const content=(await db.query('SELECT id FROM listening_practice.content WHERE code=$1 AND version=$2',[input.code||CODE,input.contentVersion])).rows[0];
   if(!content)fail('CONTENT_NOT_FOUND','Chưa nạp nội dung của bài.',404);
   const assignment=(await db.query(`INSERT INTO listening_practice.assignment(id,class_id,class_code,content_id,status,source_course_id,source_work_id)
    VALUES($1,$2,$3,$4,'draft',$5,$6) ON CONFLICT(class_id,content_id) DO UPDATE SET class_code=EXCLUDED.class_code
    WHERE listening_practice.assignment.class_code=EXCLUDED.class_code
    AND listening_practice.assignment.source_course_id IS NOT DISTINCT FROM EXCLUDED.source_course_id
    AND listening_practice.assignment.source_work_id IS NOT DISTINCT FROM EXCLUDED.source_work_id RETURNING id`,
    [uuid(),input.classId,input.classCode,content.id,input.courseId||null,input.courseWorkId||null])).rows[0];
   if(!assignment)fail('ASSIGNMENT_CONFLICT','Mã lớp không khớp bài đã đăng ký.');
   const token=input.entryToken||secret();
   const b=(await db.query(`INSERT INTO listening_practice.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(document_id) DO UPDATE SET document_id=EXCLUDED.document_id
    WHERE listening_practice.binding.assignment_id=EXCLUDED.assignment_id AND listening_practice.binding.student_ref=EXCLUDED.student_ref
    AND listening_practice.binding.tab_id=EXCLUDED.tab_id AND listening_practice.binding.entry_hash=EXCLUDED.entry_hash RETURNING id`,
    [uuid(),assignment.id,input.studentRef,input.documentId,input.tabId,hash(token),proof])).rows[0];
   if(!b)fail('DOCUMENT_BINDING_CONFLICT','Docs đã gắn với học viên/bài khác hoặc mã link khác.');
   const url=new URL(pageBase);url.searchParams.set('assignmentCode',input.code||CODE);url.searchParams.set('documentId',input.documentId);
   url.hash=`login?entry=${encodeURIComponent(token)}`;
   await db.query(`INSERT INTO listening_practice.doc_job(id,binding_id,sequence,kind,payload) VALUES($1,$2,0,'cta',$3) ON CONFLICT DO NOTHING`,[uuid(),b.id,{url:url.href}]);
   return{bindingId:b.id,assignmentId:assignment.id,entryUrl:url.href};
  });
 }
 async function open({entryToken}){
  const b=await binding(pool,{entryToken});
  const students=await context.roster(b.class_id);
  return{assignmentCode:b.code,lesson:authoredLesson(b.code),classCode:b.class_code,bindingId:b.id,documentId:b.document_id,selectedStudentRef:b.student_ref,status:b.assignment_status,
   students:students.map(s=>({id:s.studentRef,name:s.name})),ready:Boolean(b.cta_verified_at)};
 }
 async function login({entryToken,studentRef,classCode}){
  const b=await binding(pool,{entryToken});
  if(b.student_ref!==studentRef||b.class_code!==classCode)fail('IDENTITY_MISMATCH','Tên được chọn không phải chủ bản Homework này.',403);
  if(!b.cta_verified_at)fail('ASSIGNMENT_NOT_READY','Link bài chưa được kiểm trong Google Docs.');
  const token=secret();await pool.query('INSERT INTO listening_practice.student_session(token_hash,binding_id,expires_at) VALUES($1,$2,$3)',[hash(token),b.id,new Date(clock()+30*86400000).toISOString()]);
  const state=(await pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[b.id])).rows[0]?.state||initialState();
  return{token,...await view(pool,b,state)};
 }
 async function read({token}){
  const b=await binding(pool,{token});const state=(await pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[b.id])).rows[0]?.state||initialState();
  return view(pool,b,state);
 }
 // Link chung chọn từ catalog phía server; không dùng Docs giả hoặc tin tên lớp do client tự gửi.
 async function sharedContent(db,code,{lock=false,allowClosed=false}={}){
  const row=(await db.query(`SELECT c.*,s.status AS shared_status FROM listening_practice.shared_lesson s
   JOIN listening_practice.content c ON c.id=s.content_id WHERE s.code=$1${lock?' FOR SHARE OF s':''}`,[code])).rows[0];
  if(!row||row.code!==code||!allowClosed&&row.shared_status!=='open')fail('LESSON_NOT_OPEN','Bài này chưa mở để luyện tập.',404);
  return row;
 }
 async function configureSharedLesson({code,contentVersion,status}){
  lessonFor(code);
  return transaction(pool,async db=>{
   const content=(await db.query('SELECT id FROM listening_practice.content WHERE code=$1 AND version=$2',[code,contentVersion])).rows[0];
   if(!content)fail('CONTENT_NOT_FOUND','Chưa nạp nội dung của bài.',404);
   const old=(await db.query('SELECT content_id FROM listening_practice.shared_lesson WHERE code=$1 FOR UPDATE',[code])).rows[0];
   if(old&&old.content_id!==content.id)fail('CONTENT_VERSION_CONFLICT','Link chung đã ghim phiên bản; không đổi nội dung các lượt đang lưu.');
   const configured=(await db.query(`INSERT INTO listening_practice.shared_lesson(code,content_id,status) VALUES($1,$2,$3)
    ON CONFLICT(code) DO UPDATE SET status=EXCLUDED.status WHERE listening_practice.shared_lesson.content_id=EXCLUDED.content_id RETURNING code`,[code,content.id,status])).rows[0];
   if(!configured)fail('CONTENT_VERSION_CONFLICT','Link chung đã ghim phiên bản nội dung khác.');
   await db.query("UPDATE listening_practice.assignment a SET status=$2 WHERE a.content_id=$1 AND a.source_course_id IS NULL AND EXISTS(SELECT 1 FROM listening_practice.binding b WHERE b.assignment_id=a.id AND b.document_id IS NULL)",[content.id,status]);
   const url=new URL(pageBase);url.searchParams.set('lesson',lessonFor(code).authored?code:String(lessonFor(code).lesson));
   return{code,version:contentVersion,status,url:url.href};
  });
 }
 async function lessonCatalog({code}){
  const content=await sharedContent(pool,code);
  return{lesson:lessonFor(code),version:content.version,classes:await context.classes()};
 }
 async function lessonRoster({code,classId}){
  await sharedContent(pool,code);
  const selected=(await context.classes()).find(c=>c.id===classId);
  if(!selected)fail('CLASS_NOT_ELIGIBLE','Lớp chưa có danh sách học viên hợp lệ.',403);
  return{...selected,students:(await context.roster(classId)).map(s=>({id:s.studentRef,name:s.name}))};
 }
 // Giữ cùng binding của link chung dù học viên đã làm trước khi giao Homework.
 // Chỉ gắn đích Classroom đã đối chiếu; không đổi document_id sang chế độ link cá nhân.
 async function registerSharedHomework(input){
  const selected=(await context.classes()).find(c=>c.id===input.classId&&c.classCode===input.classCode);
  if(!selected||!await context.student(input.classId,input.studentRef))fail('STUDENT_NOT_ELIGIBLE','Học viên không thuộc lớp đã đối chiếu.',403);
  const proof=await verifyBinding(input);
  return transaction(pool,async db=>{
   const content=await sharedContent(db,input.code,{lock:true});
   const assignment=(await db.query(`INSERT INTO listening_practice.assignment(id,class_id,class_code,content_id,status)
    VALUES($1,$2,$3,$4,'open') ON CONFLICT(class_id,content_id) DO UPDATE SET class_code=EXCLUDED.class_code
    WHERE listening_practice.assignment.source_course_id IS NULL AND listening_practice.assignment.status='open' RETURNING id`,[uuid(),input.classId,input.classCode,content.id])).rows[0];
   if(!assignment)fail('ASSIGNMENT_CONFLICT','Bài đang dùng đường Homework riêng hoặc đã đóng.');
   const bound=(await db.query(`INSERT INTO listening_practice.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof)
    VALUES($1,$2,$3,NULL,NULL,$4,$5) ON CONFLICT(assignment_id,student_ref) DO UPDATE SET student_ref=EXCLUDED.student_ref
    WHERE listening_practice.binding.document_id IS NULL AND listening_practice.binding.owner_proof->>'mode'='shared' RETURNING *`,[uuid(),assignment.id,input.studentRef,hash(secret()),{mode:'shared'}])).rows[0];
   if(!bound)fail('DOCUMENT_BINDING_CONFLICT','Hồ sơ đã dùng link Homework cá nhân.');
   const target={...proof,classId:input.classId,studentRef:input.studentRef,code:input.code,documentId:input.documentId,tabId:input.tabId,
    courseId:input.courseId,courseWorkId:input.courseWorkId,submissionId:input.submissionId};
   const old=bound.owner_proof.homework,keys=['classId','studentRef','code','documentId','tabId','courseId','courseWorkId','submissionId'];
   if(old&&keys.some(k=>old[k]!==target[k]))fail('DOC_IDENTITY_MISMATCH','Hồ sơ đã gắn một Homework khác; giữ nguyên bài và đích cũ.');
   const conflict=(await db.query("SELECT id FROM listening_practice.binding WHERE id<>$1 AND (document_id=$2 OR owner_proof->'homework'->>'documentId'=$2) LIMIT 1",[bound.id,input.documentId])).rows[0];
   if(conflict)fail('DOC_IDENTITY_MISMATCH','Docs đã được gắn với hồ sơ khác.');
   await db.query("UPDATE listening_practice.binding SET owner_proof=jsonb_set(owner_proof,'{homework}',$2::jsonb) WHERE id=$1",[bound.id,JSON.stringify(target)]);
   const generic=new URL(pageBase);generic.searchParams.set('lesson',input.code);
   const url=new URL(generic);url.searchParams.set('mode','student');url.searchParams.set('class',input.classCode);url.searchParams.set('documentId',input.documentId);
   const previous=(await db.query("SELECT payload FROM listening_practice.doc_job WHERE binding_id=$1 AND sequence=0 AND kind='cta' FOR UPDATE",[bound.id])).rows[0];
   if(previous&&previous.payload.url!==url.href){
    if(previous.payload.url!==generic.href)fail('CTA_STORED_LINK_INVALID','Link đã lưu không phải đường chung được phép nâng cấp.');
    await db.query("UPDATE listening_practice.doc_job SET payload=$2,status='pending',available_at=now(),attempts=0,verified_at=null WHERE binding_id=$1 AND sequence=0 AND kind='cta'",[bound.id,{url:url.href}]);
   }
   await db.query(`INSERT INTO listening_practice.doc_job(id,binding_id,sequence,kind,payload) VALUES($1,$2,0,'cta',$3) ON CONFLICT DO NOTHING`,[uuid(),bound.id,{url:url.href}]);
   const stored=(await db.query("SELECT payload FROM listening_practice.doc_job WHERE binding_id=$1 AND sequence=0 AND kind='cta'",[bound.id])).rows[0];
   if(stored?.payload.url!==url.href)fail('CTA_STORED_LINK_INVALID','Link chung đã lưu không khớp bài.');
   return{bindingId:bound.id,assignmentId:assignment.id,entryUrl:url.href};
  });
 }
 async function sharedLogin({code,classId,studentRef,documentId}){
  if(documentId){const expected=await entryContext.resolve({documentId,code});
   if(expected.entryMode!=='shared'||expected.classId!==classId||expected.selectedStudentRef!==studentRef)
    fail('ENTRY_OWNER_MISMATCH','Người hoặc lớp được chọn khác chủ link cá nhân.',403);
  }
  const selected=(await context.classes()).find(c=>c.id===classId);
  if(!selected||!await context.student(classId,studentRef))fail('STUDENT_NOT_ELIGIBLE','Học viên không thuộc danh sách hợp lệ của lớp đã chọn.',403);
  return transaction(pool,async db=>{
   const content=await sharedContent(db,code,{lock:true});
   const assignment=(await db.query(`INSERT INTO listening_practice.assignment(id,class_id,class_code,content_id,status)
    VALUES($1,$2,$3,$4,'open') ON CONFLICT(class_id,content_id) DO UPDATE SET class_code=EXCLUDED.class_code
    WHERE listening_practice.assignment.source_course_id IS NULL AND listening_practice.assignment.status='open' RETURNING id`,[uuid(),classId,selected.classCode,content.id])).rows[0];
   if(!assignment)fail('ASSIGNMENT_CONFLICT','Bài của lớp đang dùng đường Homework riêng hoặc đã đóng.');
   const bound=(await db.query(`INSERT INTO listening_practice.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof)
    VALUES($1,$2,$3,NULL,NULL,$4,$5) ON CONFLICT(assignment_id,student_ref) DO UPDATE SET student_ref=EXCLUDED.student_ref
    WHERE listening_practice.binding.document_id IS NULL AND listening_practice.binding.owner_proof->>'mode'='shared' RETURNING id`,[uuid(),assignment.id,studentRef,hash(secret()),{mode:'shared'}])).rows[0];
   if(!bound)fail('DOCUMENT_BINDING_CONFLICT','Hồ sơ này đã gắn với Homework cá nhân.');
   const token=secret();await db.query('INSERT INTO listening_practice.student_session(token_hash,binding_id,expires_at) VALUES($1,$2,$3)',[hash(token),bound.id,new Date(clock()+30*86400000).toISOString()]);
   const b=await binding(db,{bindingId:bound.id}),state=(await db.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[bound.id])).rows[0]?.state||initialState();
   return{token,...await view(db,b,state)};
  });
 }
 const begin=input=>operation(input,'begin',async(db,b,state)=>{
  if(b.assignment_status!=='open')fail('ASSIGNMENT_CLOSED','Bài chưa mở hoặc đã đóng.');
  if(state.attempts.length)fail('ATTEMPT_EXISTS','Bạn đã có lần làm bài. Dùng Tiếp tục hoặc Reset.');
  const{a,lease}=createAttempt(state,input.owner,b.code);await enqueue(db,b,state,a);return view(db,b,state,{lease,definition:true});
 });
 const resume=input=>operation(input,'resume',async(db,b,state)=>{
  const a=active(state,input.attemptId);
  if(input.recovery){if(!recoverCheckpoint(a,input.recovery.snapshot,input.recovery.lease,clock()))return view(db,b,state);}
  else if(a.progressRecovery)return view(db,b,state);
  if(a.usedMs>=timingFor(b.code).totalMs){submitted(a,b,state,'timeout');await enqueue(db,b,state,a);return view(db,b,state);}
  const lease=issueLease(a,input.owner,clock());return view(db,b,state,{lease,definition:true});
 });
 async function activate(input){
  return transaction(pool,async db=>{
   const b=await binding(db,{token:input.token}),state=await work(db,b),a=active(state,input.attemptId);checkLease(a,input.lease);
   if(a.lease.activationCancelled||a.lease.activated&&a.status!=='running')fail('LEASE_REACTIVATION_REQUIRED','Lần làm bài đã tạm dừng. Nhấn Tiếp tục để mở lại.');
   if(!a.lease.activated){a.lease.activated=true;a.lease.lastSeen=clock();a.lease.startedAt=clock();a.status='running';await save(db,b,state);}
   return view(db,b,state);
  });
 }
 async function pulse(input,pause=false){
  return transaction(pool,async db=>{
   const b=await binding(db,{token:input.token}),state=await work(db,b),a=active(state,input.attemptId);
   checkLease(a,input.lease);
   if(a.status==='paused'&&!pause)fail('ATTEMPT_PAUSED','Lần làm bài đang tạm dừng.');
   if(pause){if(!recoverCheckpoint(a,input.snapshot,input.lease,clock())){await save(db,b,state);return view(db,b,state);}}
   else checkpoint(a,input.snapshot,input.lease,clock());
   if(a.usedMs>=timingFor(b.code).totalMs){submitted(a,b,state,'timeout');await enqueue(db,b,state,a);}
   else if(pause){a.status='paused';a.lease.activationCancelled=true;}
   await save(db,b,state);return view(db,b,state);
  });
 }
 const reset=input=>operation(input,'reset',async(db,b,state)=>{
  if(b.assignment_status!=='open')fail('ASSIGNMENT_CLOSED','Bài đã đóng, chưa thể tạo lượt mới.');
  const old=state.attempts.at(-1);if(!old||old.id!==input.attemptId)fail('ATTEMPT_CHANGED','Lần làm bài đã đổi.');
  if(old.status==='submitted'&&input.lease)fail('ATTEMPT_CLOSED','Lần này vừa được nộp. Xem kết quả trước khi reset.');
  if(['running','paused'].includes(old.status)){
   checkLease(old,input.lease);if(input.snapshot)recoverCheckpoint(old,input.snapshot,input.lease,clock());
   old.status='reset';old.endedAt=new Date(clock()).toISOString();
  }
  const{a,lease}=createAttempt(state,input.owner,b.code);await enqueue(db,b,state,a);return view(db,b,state,{lease,definition:true});
 });
 const submit=input=>operation(input,'submit',async(db,b,state)=>{
  const a=active(state,input.attemptId);if(!recoverCheckpoint(a,input.snapshot,input.lease,clock()))return view(db,b,state);
  if(input.method==='timeout'&&a.usedMs<timingFor(b.code).totalMs)fail('TIME_NOT_EXHAUSTED','Máy chủ chưa xác nhận dùng hết giờ.');
  submitted(a,b,state,a.usedMs>=timingFor(b.code).totalMs?'timeout':'manual');await enqueue(db,b,state,a);return view(db,b,state);
 });
 async function result({token,attemptId}){
  const b=await binding(pool,{token}),state=(await pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[b.id])).rows[0]?.state;
  const a=state?.attempts.find(x=>x.id===attemptId&&x.status==='submitted');
  if(!a)fail('RESULT_NOT_AVAILABLE','Chỉ mở đáp án sau khi nộp bài.',404);
  return{...await view(pool,b,state),attempt:publicAttempt(a),key:b.answer_key,explanations:b.explanations,definition:b.definition,contentVersion:b.version};
 }
 async function teacherResult({submissionId,email,subject}){
  const rows=(await pool.query(`SELECT w.binding_id,w.state,a.class_id FROM listening_practice.work w
   JOIN listening_practice.binding b ON b.id=w.binding_id JOIN listening_practice.assignment a ON a.id=b.assignment_id
   WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(w.state->'attempts') x WHERE x->>'submissionId'=$1)`,[submissionId])).rows;
  if(rows.length!==1)fail('RESULT_NOT_FOUND','Không tìm thấy kết quả.',404);
  if(!await context.teacher(rows[0].class_id,email,subject))fail('ACCESS_DENIED','Tài khoản này chưa có quyền lớp.',403);
  const b=await binding(pool,{bindingId:rows[0].binding_id,history:true}),state=rows[0].state,a=state.attempts.find(x=>x.submissionId===submissionId);
  return{...await view(pool,b,state),attempt:publicAttempt(a),key:b.answer_key,explanations:b.explanations,definition:b.definition,contentVersion:b.version};
 }
 async function audioAccess({token,attemptId}){
  const b=await binding(pool,{token}),state=(await pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[b.id])).rows[0]?.state;
  active(state||initialState(),attemptId);
  return{sha256:b.definition.audio.sha256};
 }
 async function configureAssignment({assignmentId,status}){
  return transaction(pool,async db=>{
   const assignment=(await db.query('SELECT id FROM listening_practice.assignment WHERE id=$1 FOR UPDATE',[assignmentId])).rows[0];
   if(!assignment)fail('ASSIGNMENT_NOT_FOUND','Không tìm thấy bài giao.',404);
   const bindings=(await db.query('SELECT id,cta_verified_at,owner_proof FROM listening_practice.binding WHERE assignment_id=$1',[assignmentId])).rows;
   if(status==='open'&&(!bindings.length||bindings.some(b=>!b.cta_verified_at||!b.owner_proof||b.owner_proof.fixtureOnly)))fail('CTA_NOT_VERIFIED','Chỉ mở bài khi chủ Docs và mọi CTA đã được đọc lại.');
   await db.query('UPDATE listening_practice.assignment SET status=$2 WHERE id=$1',[assignmentId,status]);return{assignmentId,status,bindings:bindings.length};
  });
 }
 async function operationsStatus(){
  const assignments=(await pool.query(`SELECT a.id,a.class_code,a.status,c.version,count(b.id)::int AS bindings,count(b.cta_verified_at)::int AS verified_ctas
   FROM listening_practice.assignment a JOIN listening_practice.content c ON c.id=a.content_id LEFT JOIN listening_practice.binding b ON b.assignment_id=a.id GROUP BY a.id,c.version ORDER BY a.class_code`)).rows;
  const jobs=(await pool.query('SELECT status,count(*)::int AS count,min(created_at) AS oldest FROM listening_practice.doc_job GROUP BY status')).rows;
  const blocked=(await pool.query("SELECT id,binding_id,sequence,error_code,attempts FROM listening_practice.doc_job WHERE status='blocked' ORDER BY created_at LIMIT 50")).rows;
  return{assignments,jobs,blocked};
 }
 async function retryDocJob({jobId}){
  const row=(await pool.query("UPDATE listening_practice.doc_job SET status='pending',available_at=now(),attempts=0,lease_id=null,lease_until=null,error_code=null WHERE id=$1 AND status='blocked' RETURNING id",[jobId])).rows[0];
  if(!row)fail('JOB_NOT_BLOCKED','Chỉ gửi lại công việc đã bị chặn.',409);return{jobId,status:'pending'};
 }
 return{entryContext:entryContext.resolve,guardEntry,audioAccess,seedContent,register,registerSharedHomework,open,login,read,begin,resume,activate,pulse,pause:input=>pulse(input,true),reset,submit,result,teacherResult,configureAssignment,operationsStatus,retryDocJob,configureSharedLesson,lessonCatalog,lessonRoster,sharedLogin,
  teacherProgress:createTeacherProgress({pool,context})};
}
