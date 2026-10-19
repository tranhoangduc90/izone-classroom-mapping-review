import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// 100 học viên và 10 cửa sổ GV gọi HTTP thật; chỉ dữ liệu giả, không khởi động Docs worker.
// Pool của fixture là PostgreSQL nhúng một kết nối: kiểm xen kẽ hành vi, không đo sức VPS.
export async function checkTeacherMixedLoad(t,{fixture,createApp,uuid,secret,schema,request}){
 const f=await fixture();t.after(f.close);
 const members=new Map([[f.studentRef,{studentRef:f.studentRef,name:'Học viên giả 0'}]]);
 f.context.student=async(classId,ref)=>classId==='1124'?members.get(ref):undefined;
 f.context.roster=async()=>[...members.values()];
 f.context.classes=async()=>[{id:'1124',classCode:'FIXTURE 67'}];
 const students=[{studentRef:f.studentRef,token:f.token,index:0}];
 for(let i=1;i<100;i++){
  const studentRef=uuid(),entryToken=secret();members.set(studentRef,{studentRef,name:'Học viên giả '+i});
  await f.service.register({...f.registration,studentRef,documentId:'fixture_document_'+String(i).padStart(20,'0'),entryToken});
  // Dữ liệu dựng sẵn giả: đánh dấu CTA của từng hồ sơ như fixture gốc, không gọi Docs.
  await f.pool.query(`UPDATE ${schema}.binding SET cta_verified_at=now() WHERE student_ref=$1`,[studentRef]);
  const login=await f.service.login({entryToken,studentRef,classCode:'FIXTURE 67'});students.push({studentRef,token:login.token,index:i});
 }
 const app=createApp({service:f.service,pool:f.pool,origins:['https://fixture.test'],googleClientId:'fixture',adminKey:'fixture-admin-key',
  verifyGoogle:async()=>({email:'teacher@example.test',sub:'google-fixture',email_verified:true})});
 const teacherLogin=await request(app).post('/api/teacher/login').send({credential:'fake-google-token',remember:true});
 assert.equal(teacherLogin.status,200);const cookie=teacherLogin.headers['set-cookie'].map(value=>value.split(';')[0]).join(';');
 const times={student:[],teacher:[]};
 async function post(student,path,input){const started=performance.now();const response=await request(app).post('/api/'+path).set('Authorization','Bearer '+student.token).send(input);
  times.student.push(performance.now()-started);assert.equal(response.status,200,path+': '+response.body.error?.code);return response.body;}
 async function get(path){const started=performance.now();const response=await request(app).get('/api/teacher/progress/'+path).set('Cookie',cookie);
  times.teacher.push(performance.now()-started);assert.equal(response.status,200,path+': '+response.body.error?.code);return response.body;}
 const jobs=students.map(async student=>{
  const started=await post(student,'begin',{owner:'fixture-device-'+student.index,operationId:uuid()}),attempt=started.attempts.at(-1),lease=started.lease;
  await post(student,'activate',{attemptId:attempt.id,lease});
  const draft=f.draft();draft.sequence=1;draft.notes='Nháp riêng học viên '+student.index;
  const first=Object.keys(f.content.key)[0];draft.answers={[first]:f.content.key[first][0]};
  await post(student,'pulse',{attemptId:attempt.id,lease,snapshot:draft});
  const done=await post(student,'submit',{attemptId:attempt.id,lease,snapshot:draft,operationId:uuid(),method:'manual'});
  assert.equal(done.attempts.at(-1).notes,draft.notes);assert.equal(done.attempts.at(-1).finalScore,1);
 });
 const teacherJobs=Array.from({length:10},async()=>{
  for(let i=0;i<3;i++){
   const list=await get('students?'+new URLSearchParams({classId:'1124',code:f.content.code}));assert.equal(list.students.length,100);
   const unit=list.students.flatMap(student=>student.units).find(unit=>unit.attemptId);
   if(unit){const detail=await get('units/'+unit.id);assert.equal(detail.id,unit.id);assert.equal(detail.definition.audio,undefined);}
  }
 });
 const outcomes=await Promise.allSettled([...jobs,...teacherJobs]);
 const failures=outcomes.filter(outcome=>outcome.status==='rejected');assert.deepEqual(failures.map(outcome=>String(outcome.reason)),[]);
 const final=await get('students?'+new URLSearchParams({classId:'1124',code:f.content.code}));
 assert.equal(final.students.filter(student=>student.units.some(unit=>unit.status==='submitted')).length,100);
 const rows=(await f.pool.query(`SELECT state FROM ${schema}.work`)).rows;assert.equal(rows.length,100);
 const notes=new Set(rows.map(row=>row.state.attempts.at(-1).draft.notes));assert.equal(notes.size,100);
 const stat=samples=>{const sorted=[...samples].sort((a,b)=>a-b);return{requests:samples.length,p95ms:Math.round(sorted[Math.ceil(sorted.length*.95)-1]),maxMs:Math.round(sorted.at(-1))};};
 t.diagnostic(JSON.stringify({environment:f.pool.fixtureEnvironment||'local-HTTP-embedded-PostgreSQL-single-connection',students:100,teacherReaders:10,
  student:stat(times.student),teacher:stat(times.teacher),externalCalls:0,docsWorkerStarted:false,audioDownloads:0}));
}
