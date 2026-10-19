import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createReadinessFixture} from './helpers/readiness-fixture.js';

test('Làm quen: 100 hồ sơ lưu đủ L/R/W và 10 cửa sổ GV, không gọi audio hoặc tạo lượt thi',
 {skip:!process.env.K67_ORDER_NATIVE_URL,timeout:60000},async t=>{
 // Header WAV 1 giây và mẫu im lặng tự tạo, chỉ để backend đọc metadata; không gửi/tải audio.
 const fakeAudio=Buffer.alloc(8044);fakeAudio.write('RIFF');fakeAudio.writeUInt32LE(8036,4);fakeAudio.write('WAVEfmt ',8);
 fakeAudio.writeUInt32LE(16,16);fakeAudio.writeUInt16LE(1,20);fakeAudio.writeUInt16LE(1,22);
 fakeAudio.writeUInt32LE(8000,24);fakeAudio.writeUInt32LE(8000,28);fakeAudio.writeUInt16LE(1,32);fakeAudio.writeUInt16LE(8,34);
 fakeAudio.write('data',36);fakeAudio.writeUInt32LE(8000,40);
 const f=await createReadinessFixture({audioSource:()=>fakeAudio});t.after(()=>f.db.close());
 // Mô phỏng Nginx cung cấp địa chỉ của bốn mạng; mỗi mạng 25 học viên.
 f.app.set('trust proxy',1);
 const refs=['11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444'];
 for(let i=2;i<100;i++){
  const studentRef=randomUUID();refs.push(studentRef);
  await f.db.query("INSERT INTO mapping.student_mapping_review VALUES($1,1293,$2,$3,'approved')",[studentRef,1000000+i,'Học viên tải giả '+i]);
 }
 const prefix='/api/k67-readiness/v1',metrics={student:[],teacher:[]};
 async function post(index,path,data,expected=200){const start=performance.now();const response=await request(f.app).post(prefix+path)
  .set('X-Forwarded-For','192.0.2.'+(1+Math.floor(index/25))).send(data);metrics.student.push(performance.now()-start);
  assert.equal(response.status,expected,path+': '+JSON.stringify(response.body));return response.body;}
 async function get(path){const start=performance.now();const response=await request(f.app).get(prefix+'/teacher/'+path)
  .set('x-review-token','fixture-only-key').set('X-Forwarded-For','192.0.2.10');metrics.teacher.push(performance.now()-start);
  assert.equal(response.status,200,path+': '+JSON.stringify(response.body));return response.body;}
 const jobs=refs.map(async(studentRef,index)=>{
  const opened=await post(index,'/sessions',{studentRef,classCode:'IC2304',requestId:randomUUID(),openingProof:randomBytes(32).toString('hex')},201);
  const token=opened.token;
  await post(index,'/device',{token,sameComputer:true,sameHeadphones:true});
  await post(index,'/draft',{token,revision:1,answers:{1:'L riêng '+index},heardSeconds:0,cacheState:'unavailable'});
  // Đi đúng lựa chọn bỏ nghe được sản phẩm hỗ trợ; không giả đã nghe và không tải audio.
  await post(index,'/submit',{token,revision:1,heardConfirmed:false});
  await post(index,'/practice/reading/draft',{token,revision:1,data:{1:'R riêng '+index}});
  await post(index,'/practice/writing/draft',{token,revision:1,data:{text:'W riêng '+index}});
 });
 const readers=Array.from({length:10},async()=>{for(let i=0;i<3;i++){
  const list=await get('students?classId=1293');assert.equal(list.students.length,100);
  const student=list.students.find(row=>row.sessions.length);
  if(student)await get('students/'+student.studentRef+'?classId=1293');
 }});
 const settled=await Promise.allSettled([...jobs,...readers]),failures={};
 for(const row of settled)if(row.status==='rejected'){const message=String(row.reason);failures[message]=(failures[message]||0)+1;}
 assert.deepEqual(failures,{});
 const saved=(await f.db.query('SELECT student_ref,answers,reading_draft,writing_draft,heard_confirmed FROM assessment.k67_readiness_session')).rows;
 assert.equal(saved.length,100);
 for(const [index,ref]of refs.entries()){
  const row=saved.find(row=>row.student_ref===ref);assert.equal(row.answers[1],'L riêng '+index);
  assert.equal(row.reading_draft[1],'R riêng '+index);assert.equal(row.writing_draft.text,'W riêng '+index);assert.equal(row.heard_confirmed,false);
 }
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_exam_session')).rows[0].n,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
 const stat=values=>{const rows=[...values].sort((a,b)=>a-b);return{requests:rows.length,p95ms:Math.round(rows[Math.ceil(rows.length*.95)-1]),maxMs:Math.round(rows.at(-1))};};
 t.diagnostic(JSON.stringify({environment:'local-HTTP-native-PostgreSQL-k67_app-pool5',students:100,teacherReaders:10,
  student:stat(metrics.student),teacher:stat(metrics.teacher),audioDownloads:0,simulatedNetworks:4,studentsPerNetwork:25,externalCalls:0}));
});
