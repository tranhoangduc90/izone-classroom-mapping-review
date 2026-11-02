import {createHash} from 'node:crypto';
import {createTestObservationHub} from './test-state-runtime.js';
import {speakingSourceScopes,speakingSourceScopeKey} from './speaking-source-batch.js';
import {speakingContentRevision,speakingDocsRevision,speakingObservationView} from './speaking-observation-view.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(JSON.stringify(value));
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status,httpStatus:status});};
const distinct=(values,key)=>[...new Map(values.map(value=>[key(value),value])).values()];
const scopeError=()=>fail('SPEAKING_STATE_INPUT_INVALID',400);
const sorted=rows=>[...rows].sort((a,b)=>String(a.student_ref||a.public_id||'').localeCompare(String(b.student_ref||b.public_id||'')));
function sourceScope(row){
 return{assignmentCode:row.assignment_code,...(row.student_ref?{classCode:row.class_code,
  ...(row.profile_kind==='member'&&row.origin==='web'?{webEntry:true}:{})}:{})};
}
function sourceContext(contexts,input){
 const value=contexts.get(speakingSourceScopeKey(input));
 if(!value)fail('SPEAKING_STATE_CONTEXT_INVALID');
 if(!value.ok)fail(value.error,value.status);return value.context;
}
function independentEntitlement(row,context){
 if(!row.student_ref)return;
 const selected=row.profile_kind==='document'&&!row.course_id;
 const students=selected?context.selectionStudents:context.students;
 if(!Array.isArray(students))fail('SPEAKING_STATE_CONTEXT_INVALID');
 if(!students.some(student=>student.student_ref===row.student_ref))fail('STUDENT_NOT_ACTIVE',403);
}
const problem=error=>({code:error.code||'STATE_UNAVAILABLE',status:error.status||error.httpStatus||503});
function requireSession(session){if(!session)fail('SESSION_INVALID',403);if(session.error)fail(session.error.code,session.error.status);}
const matches=(row,scope)=>String(row.class_id??'unlinked')===scope.classId&&row.assignment_code===scope.code
 &&(!scope.courseId||String(row.course_id)===scope.courseId);
const summary=(row,context)=>({unitId:row.unit_id,studentRef:row.student_ref,status:row.status,documentId:row.document_id,
 receiptId:row.receipt_id,sentLinks:row.sent_links,acceptedLinks:row.accepted_links,savedAt:row.saved_at,
 contentRevision:speakingContentRevision(row,context),docsRevision:speakingDocsRevision(row)});
const docs=row=>({docsProgress:row.docs_progress||null,docsJobs:row.docs_jobs});

// Một hub/reader chung cho HV và GV của một kho native. Guard không gọi SQL/API:
// toàn bộ quyền, metadata và nguồn được đọc theo nhóm trong read() của lượt hiện tại.
// Không mở/nộp/chấm bài hoặc phục hồi Docs; body chỉ được chọn cho yêu cầu view rõ ràng.
export function createSpeakingObservation({schema,data,source,observeTeachers,interval=15000,hubOptions={}}){
 if(!['speaking_independent','speaking_homework'].includes(schema)||typeof data?.read!=='function'
  ||(schema==='speaking_independent'&&typeof source?.contexts!=='function'))throw Error('SPEAKING_STATE_OPTIONS_INVALID');
 async function contextsFor(inputs){
  try{return await source.contexts(inputs);}
  catch{
   // Lỗi cả RPC/nguồn không phải thu hồi quyền của mọi học viên. Các lỗi quyền
   // theo từng scope vẫn giữ403 từ entries; scope không cần nguồn này vẫn đọc được.
   return new Map(inputs.map(input=>[speakingSourceScopeKey(input),{ok:false,error:'SPEAKING_STATE_SOURCE_UNAVAILABLE',status:503}]));
  }
 }

 async function read({scopes,guards}){
  const teacherGuards=guards.filter(guard=>guard.kind==='teacher'),students=guards.filter(guard=>guard.kind==='student');
  const actors=new Map();
  for(const guard of teacherGuards){
   const old=actors.get(guard.hash);
   if(old&&old.cookie!==guard.cookie)fail('SPEAKING_STATE_ACTOR_INVALID');
   if(!old)actors.set(guard.hash,{key:guard.hash,cookie:guard.cookie,classIds:[]});
   actors.get(guard.hash).classIds.push(guard.classId);
  }
  for(const actor of actors.values())actor.classIds=[...new Set(actor.classIds)];
  if(actors.size&&typeof observeTeachers!=='function')fail('STATE_AUTH_OBSERVER_UNAVAILABLE',409);
  let auth=new Map();
  if(actors.size)try{auth=await observeTeachers([...actors.values()]);}
  catch{auth=new Map([...actors.keys()].map(key=>[key,{ok:false,error:'STATE_AUTH_UNAVAILABLE',status:503}]));}
  const sessions=new Map(),states=new Map();
  for(const [key,actor] of actors){
   const entry=auth.get(key);
   sessions.set(key,entry?.ok?{...entry,authRevision:digest(entry)}:{error:{code:entry?.error||'UNAUTHORIZED',status:entry?.status||401}});
  }
  const permitted=scope=>{
   const session=sessions.get(scope.actorKey);
   return session&&!session.error&&session.allowedClassIds.includes(scope.classId);
  };
  const teacherScopes=scopes.filter(scope=>scope.kind==='teacher'&&permitted(scope));
  const teacherInput=scope=>({assignmentCode:scope.code,...(scope.classCode?{classCode:scope.classCode}:{})});
  // Kho cũ chọn đúng Classroom course hiện hành. Đọc nguồn theo nhóm trước SQL,
  // không thêm một lượt tra course riêng cho từng kết nối giảng viên.
  let contexts=schema==='speaking_homework'&&teacherScopes.length
   ?await contextsFor(speakingSourceScopes(teacherScopes.map(teacherInput))):new Map();
  const course=scope=>schema==='speaking_homework'?contexts.get(speakingSourceScopeKey(teacherInput(scope)))?.context?.scope?.course_id:scope.courseId;
  const rows=await data.read({classes:distinct(teacherScopes.filter(scope=>scope.classId!=='unlinked'&&(schema!=='speaking_homework'||course(scope)))
   .map(scope=>({classId:scope.classId,code:scope.code,...(course(scope)?{courseId:String(course(scope))}:{})})),row=>JSON.stringify(row)),
   unitIds:teacherScopes.flatMap(scope=>scope.unitId?[scope.unitId]:[]),
   sessions:distinct(students.map(guard=>({hash:guard.tokenHash,studentRef:guard.studentRef})),row=>row.hash+':'+row.studentRef),
   contentIds:scopes.filter(scope=>scope.kind==='student'&&scope.view&&scope.unitId).map(scope=>scope.unitId)});
  if(rows.some(row=>row.schema!==schema)||new Set(rows.map(row=>row.unit_id)).size!==rows.length)fail('SPEAKING_STATE_DATA_INVALID');
  const studentRows=new Map();
  for(const guard of distinct(students,guard=>guard.hash)){
   const selected=rows.filter(row=>row.matched_sessions.some(session=>session.hash===guard.tokenHash&&session.studentRef===guard.studentRef));
   if(selected.length>1)fail('SPEAKING_STATE_DATA_INVALID');studentRows.set(guard.hash,selected[0]||null);
  }
  if(schema==='speaking_independent'){
   const requested=speakingSourceScopes([...teacherScopes.map(teacherInput),...[...studentRows.values()].filter(Boolean).map(sourceScope)]);
   contexts=requested.length?await contextsFor(requested):new Map();
  }
  for(const guard of distinct(students,guard=>guard.hash)){
   const row=studentRows.get(guard.hash);let context=null,error;
   try{
    if(!row)fail(schema==='speaking_homework'?'SPEAKING_STATE_NOT_READY':'SESSION_INVALID',schema==='speaking_homework'?409:403);
    if(row.local_grant_allowed!==true)fail('SESSION_INVALID',403);
    if(schema==='speaking_independent'){context=sourceContext(contexts,sourceScope(row));independentEntitlement(row,context);}
   }catch(e){error=problem(e);}
   sessions.set(guard.hash,error?{error}:{row,context,authRevision:digest([schema,row.unit_id,row.student_ref,row.identity_ref,row.document_id,context])});
  }
  for(const scope of scopes){
   if(states.has(scope.key))continue;
   if(scope.kind==='student'){
    const session=sessions.get(scope.actorKey);states.set(scope.key,{row:session?.row,context:session?.context});continue;
   }
   let context,error;
   try{context=sourceContext(contexts,teacherInput(scope));}catch(e){error=problem(e);}
   states.set(scope.key,{rows:rows.filter(row=>matches(row,scope)),
    unit:scope.unitId?rows.find(row=>row.unit_id===scope.unitId):null,context,error});
  }
  return{sessions,states};
 }
 const hub=createTestObservationHub({...hubOptions,read,interval});
 function proof(guard,session,verified){
  guard.verify(session);
  if(verified&&session.authRevision!==verified.authRevision)fail('SPEAKING_STATE_AUTH_CHANGED');
 }
 function student(input,{view=false}={}){
  if(!input||Object.keys(input).some(key=>!['accessToken','studentRef','unitId'].includes(key))
   ||typeof input.accessToken!=='string'||!/^[A-Za-z0-9_-]{32,200}$/.test(input.accessToken)
   ||typeof input.studentRef!=='string'||!uuid.test(input.studentRef)||(input.unitId!==undefined&&!uuid.test(input.unitId))
   ||(view&&!input.unitId))scopeError();
  const studentRef=input.studentRef.toLowerCase(),tokenHash=hash(input.accessToken),actorKey='student:'+tokenHash+':'+studentRef;
  const unitId=input.unitId?.toLowerCase()||null,scope={kind:'student',actorKey,unitId,view,key:JSON.stringify(['student',actorKey,unitId,view])};
  let seen=false;
  const guard={kind:'student',hash:actorKey,key:actorKey,tokenHash,studentRef,verify(session){
   if(seen&&session?.error?.code==='SPEAKING_STATE_NOT_READY')fail('SESSION_INVALID',403);
   requireSession(session);if(unitId&&session.row.unit_id!==unitId)fail('SESSION_INVALID',403);seen=true;
   return{authRevision:session.authRevision};
  },assertCurrent(session,verified){proof(guard,session,verified);},state(state){
   if(!state.row)fail('SPEAKING_STATE_NOT_READY',409);
   if(view)return speakingObservationView(state.row,state.context);
   return{kind:'speaking-student-state-v1',...summary(state.row,state.context),...docs(state.row),studentRef};
  }};
  return{scope,guard};
 }
 function teacher(input,principal){
  if(!input||Object.keys(input).some(key=>!['classId','classCode','code','unitId','courseId'].includes(key))
   ||typeof input.classId!=='string'||!(input.classId==='unlinked'||(/^\d{1,19}$/.test(input.classId)&&BigInt(input.classId)<=9223372036854775807n))
   ||typeof input.code!=='string'||input.code.length<3||input.code.length>100
   ||(input.classCode!==undefined&&(typeof input.classCode!=='string'||!/^[A-Za-z0-9_-]{2,32}$/.test(input.classCode)))
   ||(input.unitId!==undefined&&!uuid.test(input.unitId))
   ||(input.courseId!==undefined&&(typeof input.courseId!=='string'||!/^\d+$/.test(input.courseId)))
   ||(input.classId==='unlinked'?(!input.unitId||input.classCode):!input.classCode))scopeError();
  if(principal?.authSource!=='session')fail('STATE_AUTH_COOKIE_REQUIRED',409);
  if(typeof principal.cookie!=='string'||!principal.cookie||typeof principal.reviewer?.email!=='string')fail('UNAUTHORIZED',401);
  const actorKey=hash(principal.cookie),classId=input.classId==='unlinked'?'unlinked':String(BigInt(input.classId));
  const scope={kind:'teacher',...input,classId,unitId:input.unitId?.toLowerCase()||null,actorKey,
   key:JSON.stringify(['teacher',actorKey,classId,input.classCode,input.code,input.unitId?.toLowerCase(),input.courseId])};
  const guard={kind:'teacher',hash:actorKey,key:actorKey+':'+classId,cookie:principal.cookie,classId,verify(session){
   requireSession(session);if(session.reviewer.email!==principal.reviewer.email)fail('UNAUTHORIZED',401);
   if(!session.allowedClassIds.includes(classId))fail('TEACHER_ACCESS_DENIED',403);return{authRevision:session.authRevision};
  },assertCurrent(session,verified){proof(guard,session,verified);},state(state){
   if(state.error)fail(state.error.code,state.error.status);
   if(scope.classId!=='unlinked'&&String(state.context?.scope?.class_id)!==scope.classId)fail('TEACHER_ACCESS_DENIED',403);
   if(scope.courseId&&String(state.context?.scope?.course_id)!==scope.courseId)fail('TEACHER_ACCESS_DENIED',403);
   if(scope.unitId&&(!state.unit||!matches(state.unit,scope)))fail('TEACHER_ACCESS_DENIED',403);
   // Danh sách native chỉ đổi khi nội dung/roster đổi. Docs-only của unit đang
   // đọc có payload riêng để UI không phải đọc/dựng lại toàn bộ chi tiết.
   const values=state.rows.map(row=>{const {docsRevision,...content}=summary(row,state.context);return content;});
   const members={students:sorted(state.context.students||[]),selection:sorted(state.context.selectionStudents||[]),excluded:sorted(state.context.excludedStudents||[])};
   // Native students cũng trả nhãn/cấu hình mẫu hiện hành, trong khi nội dung
   // unit vẫn giữ mẫu đã lưu. Đổi nhãn phải được phát dù bài đã lưu không đổi.
   const template=state.context.template||{},assignment={code:scope.code,title:template.title,parts:template.parts,requiredPracticeCount:template.requiredPracticeCount};
   return{kind:'speaking-teacher-state-v1',classId,code:scope.code,unitId:scope.unitId,
    classRevision:digest([values,members,assignment]),unitRevision:state.unit?digest(summary(state.unit,state.context)):null,
    unitContentRevision:state.unit?speakingContentRevision(state.unit,state.context):null,
    unitDocsRevision:state.unit?speakingDocsRevision(state.unit):null,unitDocs:state.unit?docs(state.unit):null};
  }};
  return{scope,guard};
 }
 return{hub,student,teacher,read,close:()=>hub.close(),wake:()=>hub.wake()};
}
