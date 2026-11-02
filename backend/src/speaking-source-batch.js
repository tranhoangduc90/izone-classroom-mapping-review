// Khóa bài/lớp dùng ở cả nguồn và bộ nhận; không nối bằng tên học viên hoặc vị trí mảng.
export const speakingSourceScopeKey=({assignmentCode,classCode,webEntry})=>JSON.stringify([assignmentCode,classCode||'',webEntry===true]);
const invalid=()=>Object.assign(Error('SOURCE_BATCH_INVALID'),{code:'SOURCE_BATCH_INVALID',status:503});
export function speakingSourceScopes(inputs){
 if(!Array.isArray(inputs)||inputs.length>1000)throw invalid();
 const scopes=new Map();
 for(const input of inputs){
  if(!input||typeof input.assignmentCode!=='string'||input.assignmentCode.length<3||input.assignmentCode.length>100
   ||(input.classCode!==undefined&&(typeof input.classCode!=='string'||!/^[A-Za-z0-9_-]{2,32}$/.test(input.classCode)))
   ||(input.webEntry!==undefined&&typeof input.webEntry!=='boolean')
   ||Object.keys(input).some(key=>!['assignmentCode','classCode','webEntry'].includes(key)))throw invalid();
  const scope={assignmentCode:input.assignmentCode,...(input.classCode?{classCode:input.classCode}:{}),...(input.webEntry?{webEntry:true}:{})};
  scopes.set(speakingSourceScopeKey(scope),scope);
 }
 return [...scopes.values()];
}

// Một bản trả về chỉ dùng cho lượt đọc hiện tại. Roster/catalog chung không lặp theo mỗi bài.
// Thiếu, trùng hoặc lạc định danh làm cả phản hồi lỗi tạm; không coi là đã kiểm quyền.
export function expandSpeakingSourceBatch(inputs,batch){
 const requested=new Map(speakingSourceScopes(inputs).map(input=>[speakingSourceScopeKey(input),input]));
 if(!batch||!Array.isArray(batch.entries)||!Array.isArray(batch.classes)||!Array.isArray(batch.exercises)||!Array.isArray(batch.rosters)
  ||batch.entries.length!==requested.size)throw invalid();
 const rosters=new Map(),result=new Map();
 for(const roster of batch.rosters){
  if(!roster||!/^\d+$/.test(String(roster.classId))||rosters.has(String(roster.classId))
   ||!['students','webStudents','selectionStudents','excludedStudents'].every(key=>Array.isArray(roster[key])))throw invalid();
  rosters.set(String(roster.classId),roster);
 }
 for(const entry of batch.entries){
  const input=requested.get(entry?.key);
  if(!input||result.has(entry.key)||speakingSourceScopeKey(entry)!==entry.key)throw invalid();
  if(entry.ok===false){
   if(typeof entry.error!=='string'||!Number.isInteger(entry.status)||entry.status<400||entry.status>=500)throw invalid();
   result.set(entry.key,{ok:false,error:entry.error,status:entry.status,message:entry.message});continue;
  }
  if(entry.ok!==true||entry.template?.assignmentCode!==input.assignmentCode||!Array.isArray(entry.template.parts)
   ||!/^[a-f0-9]{64}$/.test(entry.template.digest||''))throw invalid();
  if(!input.classCode){
   if(entry.scope)throw invalid();
   result.set(entry.key,{ok:true,context:{template:entry.template,classes:batch.classes,exercises:batch.exercises}});continue;
  }
  const scope=entry.scope,roster=rosters.get(String(scope?.class_id));
  if(scope?.class_code!==input.classCode||!roster||!batch.classes.some(row=>String(row.class_id)===String(scope.class_id)
   &&row.class_code===scope.class_code&&String(row.course_id)===String(scope.course_id)))throw invalid();
  const {classId,webStudents,...members}=roster;
  result.set(entry.key,{ok:true,context:{template:entry.template,scope,...members,students:input.webEntry?webStudents:members.students,
   member:null,exercises:batch.exercises,recommendations:[]}});
 }
 return result;
}
