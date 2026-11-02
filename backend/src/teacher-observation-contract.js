// Hợp đồng nội bộ: định danh từng người giữ nguyên qua gom nhóm/đảo thứ tự.
// Cookie chỉ đi trong body của lời gọi đã kiểm worker secret, không đi vào URL/frame.
const hex=/^[a-f0-9]{64}$/;
const fail=(code,status)=>Object.assign(Error(code),{code,status,httpStatus:status});
export function teacherObservationActors(inputs){
 if(!Array.isArray(inputs)||inputs.length>1000)throw fail('AUTH_OBSERVATION_INPUT_INVALID',400);
 const seen=new Set();let pairs=0,bytes=0;
 return inputs.map(input=>{
  if(!input||Object.keys(input).some(key=>!['key','cookie','classIds'].includes(key))
   ||typeof input.key!=='string'||!hex.test(input.key)||seen.has(input.key)
   ||typeof input.cookie!=='string'||input.cookie.length>16384||!Array.isArray(input.classIds)||input.classIds.length>1000
   ||input.classIds.some(id=>typeof id!=='string'||!(id==='unlinked'||(/^\d{1,19}$/.test(id)&&BigInt(id)<=9223372036854775807n))))
    throw fail('AUTH_OBSERVATION_INPUT_INVALID',400);
  seen.add(input.key);const classIds=[...new Set(input.classIds)];pairs+=classIds.length;bytes+=Buffer.byteLength(input.cookie);
  if(pairs>2000||bytes>1048576)throw fail('AUTH_OBSERVATION_INPUT_INVALID',400);
  return{key:input.key,cookie:input.cookie,classIds};
 });
}

export function expandTeacherObservation(inputs,batch){
 const wanted=new Map(teacherObservationActors(inputs).map(actor=>[actor.key,actor]));
 const invalid=()=>fail('AUTH_OBSERVATION_DATA_INVALID',503);
 if(!batch||!Array.isArray(batch.actors)||batch.actors.length!==wanted.size)throw invalid();
 const result=new Map();
 for(const row of batch.actors){
  const actor=wanted.get(row?.key);if(!actor||result.has(row.key))throw invalid();
  if(row.ok===false){
   if(Object.keys(row).some(key=>!['key','ok','error','status'].includes(key))
    ||typeof row.error!=='string'||!/^[A-Z0-9_]{3,80}$/.test(row.error)||![401,403,409].includes(row.status))throw invalid();
  }else{
   const reviewer=row.reviewer;
   if(row.ok!==true||Object.keys(row).some(key=>!['key','ok','authSource','reviewer','googleSubject','sessionHash','idleExpiresAt','absoluteExpiresAt','allowedClassIds'].includes(key))
    ||row.authSource!=='session'||!reviewer||Object.keys(reviewer).some(key=>!['email','displayName','role','canAccessAllClasses'].includes(key))
    ||typeof reviewer.email!=='string'||!reviewer.email||typeof reviewer.displayName!=='string'||typeof reviewer.role!=='string'
    ||typeof reviewer.canAccessAllClasses!=='boolean'||typeof row.googleSubject!=='string'||!row.googleSubject
    ||typeof row.sessionHash!=='string'||!hex.test(row.sessionHash)
    ||!['idleExpiresAt','absoluteExpiresAt'].every(key=>typeof row[key]==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(row[key])&&Number.isFinite(Date.parse(row[key])))
    ||!Array.isArray(row.allowedClassIds)||new Set(row.allowedClassIds).size!==row.allowedClassIds.length
    ||row.allowedClassIds.some(id=>!actor.classIds.includes(id)))throw invalid();
  }
  const {key,...entry}=row;result.set(key,entry);
 }
 return result;
}
