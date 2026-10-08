// PostgreSQL thật, nhiều kết nối. Tự tạo database mới chỉ ở 127.0.0.1:54107; không nhận URL production.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {setupDatabase} from './journey-comment-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createProgressLinkCipher} from '../src/learning-journey-comments.js';
const config={host:'127.0.0.1',port:54107,user:'journey_fixture',database:'postgres',max:30};
const ref='60000000-0000-4000-8000-000000000001';
const target={classId:'2139',studentRef:ref,sessionNumber:2,reviewer:{email:'teacher@example.test',displayName:'Cô thử nghiệm',canAccessAllClasses:false}};
const id=()=>crypto.randomUUID();
test('PG16 nhiều kết nối: link duy nhất, retry, stale, ẩn và khóa kế hoạch',{timeout:60000},async t=>{
 const control=new Pool(config),name='journey_fixture_'+id().replaceAll('-','');
 await control.query('CREATE DATABASE '+name);await control.end();
 const pool=new Pool({...config,database:name});t.after(()=>pool.end());
 await setupDatabase({query:(sql,args)=>pool.query(sql,args),exec:sql=>pool.query(sql),close(){}});
 await pool.query(await readFile(new URL('../ops/learning-migrations/202610070001_student_journey_comments.sql',import.meta.url),'utf8'));
 await pool.query(`INSERT INTO learning.class_journey_plan(erp_course_class_id,total_sessions,test_session_numbers,revision,confirmed_by_email,confirmed_at) VALUES(2139,3,ARRAY[2],1,'teacher@example.test',now())`);
 const service=createLearningService({pool,journeyCommentsEnabled:true,progressLinkCipher:createProgressLinkCipher({keys:{v1:Buffer.alloc(32,17).toString('base64')}})});
 await t.test('20 lần lấy link đồng thời trả một link; retry rotate không đổi thêm',async()=>{
  const links=await Promise.all(Array.from({length:20},()=>service.resolveStudentProgressLink({...target,operationId:id()})));
  assert.equal(new Set(links.map(link=>link.accessToken)).size,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM learning.student_progress_access WHERE status='active'")).rows[0].n,1);
  const request={...target,expectedAccessId:links[0].accessId,operationId:id()};
  const rotations=await Promise.all(Array.from({length:10},()=>service.rotateStudentProgressLink(request)));
  assert.equal(new Set(rotations.map(link=>link.accessToken)).size,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM learning.student_progress_access')).rows[0].n,2);
 });
 await t.test('hai GV cùng revision: một bản được lưu, bản kia nhận conflict',async()=>{
  const result=await Promise.allSettled(['Bản A','Bản B'].map(noteText=>service.saveSessionComment({...target,noteText,expectedRevision:0,operationId:id()})));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(result.find(r=>r.status==='rejected').reason.code,'COMMENT_STALE');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM learning.student_session_comment_revision')).rows[0].n,1);
 });
 await t.test('20 retry cùng thao tác chỉ tăng một revision; race ẩn/sửa không ghi đè',async()=>{
  const request={...target,noteText:'Lưu một lần',expectedRevision:1,operationId:id()};
  const retries=await Promise.all(Array.from({length:20},()=>service.saveSessionComment(request)));
  assert.ok(retries.every(note=>note.revision===2));
  const result=await Promise.allSettled([service.hideSessionComment({...target,expectedRevision:2,operationId:id()}),service.saveSessionComment({...target,noteText:'Bản mới',expectedRevision:2,operationId:id()})]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.code,'COMMENT_STALE');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM learning.student_session_comment_revision')).rows[0].n,3);
 });
 await t.test('rút kế hoạch cùng lúc ghi buổi 3: không tạo nhận xét ngoài kế hoạch',async()=>{
  await service.saveSessionComment({...target,sessionNumber:3,noteText:'Giữ buổi 3',expectedRevision:0,operationId:id()});
  const client=await pool.connect();await client.query('BEGIN');await client.query('SELECT 1 FROM learning.class_journey_plan WHERE erp_course_class_id=2139 FOR SHARE');
  let done=false;const shrink=pool.query('UPDATE learning.class_journey_plan SET total_sessions=2 WHERE erp_course_class_id=2139').then(()=>({ok:true}),e=>({code:e.code})).finally(()=>{done=true;});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(done,false);await client.query('COMMIT');client.release();
  assert.equal((await shrink).code,'23514');
 });
 await t.test('role API không được sửa/xóa lịch sử; cấu hình đọc và ghi đủ',async()=>{
  const role=name+'_api';await pool.query('CREATE ROLE '+role+' NOLOGIN');await pool.query('GRANT learning_api TO '+role);
  const client=await pool.connect();try{await client.query('SET ROLE '+role);
   assert.equal((await client.query('SELECT count(*)::int AS n FROM learning.student_session_comment')).rows[0].n,2);
   await assert.rejects(()=>client.query('DELETE FROM learning.student_session_comment_revision'),e=>e.code==='42501');
   await assert.rejects(()=>client.query("UPDATE learning.student_session_comment_revision SET note_text='đổi'"),e=>e.code==='42501');
  }finally{await client.query('RESET ROLE');client.release();}
 });
 await t.test('20 HV × 31 buổi: lưu và đọc song song đúng người, không tạo bài/điểm danh',async()=>{
  const refs=Array.from({length:20},id);
  await pool.query('UPDATE learning.class_journey_plan SET total_sessions=31 WHERE erp_course_class_id=2139');
  for(const [index,studentRef]of refs.entries())await pool.query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES($1,2139,$2,'Học viên tải thử')`,[studentRef,10000+index]);
  const started=performance.now();
  const links=await Promise.all(refs.map(studentRef=>service.resolveStudentProgressLink({...target,studentRef,operationId:id()})));
  await Promise.all(refs.map((studentRef,index)=>service.saveSessionComment({...target,studentRef,sessionNumber:1,noteText:'Nhận xét của người '+index,expectedRevision:0,operationId:id()})));
  const journeys=await Promise.all(links.map(link=>service.getStudentCourseJourney({accessToken:link.accessToken})));
  for(const [index,journey]of journeys.entries()){assert.equal(journey.student.studentRef,refs[index]);assert.equal(journey.sessions.length,31);assert.equal(journey.sessions[0].sessionComment.noteText,'Nhận xét của người '+index);}
  const elapsed=performance.now()-started;assert.ok(elapsed<15000,'Lượt đọc/lưu phải nằm trong hạn chờ 15 giây');
  const counts=await pool.query(`SELECT (SELECT count(*) FROM learning.attempt)::int AS attempts,(SELECT count(*) FROM learning.submission)::int AS submissions,(SELECT count(*) FROM learning.attendance_event)::int AS events,(SELECT count(*) FROM learning.outbox_job)::int AS jobs`);
  assert.deepEqual(counts.rows[0],{attempts:0,submissions:0,events:0,jobs:0});
  t.diagnostic('20 người × 31 buổi, lưu/đọc: '+Math.round(elapsed)+' ms trên PostgreSQL local.');
 });
 await t.test('backfill chỉ bỏ hạn link active còn hiệu lực, giữ hash và không hồi sinh link cũ',async()=>{
  const ids=[];for(const state of ['valid','expired','revoked']){const accessId=id();ids.push(accessId);
   await pool.query(`INSERT INTO learning.student_progress_access(id,erp_course_class_id,student_ref,token_hash,status,expires_at,created_by_email,operation_key,idempotency_key,revoked_at)
     VALUES($1,2139,$2,$3,$4,now()+$5::interval,'teacher@example.test',$6,$7,CASE WHEN $4='revoked' THEN now() ELSE NULL END)`,[accessId,id(),crypto.createHash('sha256').update(state).digest('hex'),state==='revoked'?'revoked':'active',state==='expired'?'-1 day':'90 days',id(),id()]);}
  const before=(await pool.query('SELECT * FROM learning.student_progress_access WHERE id=ANY($1::uuid[])',[ids])).rows;
  await pool.query(await readFile(new URL('../ops/student-journey-link-expiry-backfill.sql',import.meta.url),'utf8'));
  const after=(await pool.query('SELECT * FROM learning.student_progress_access WHERE id=ANY($1::uuid[])',[ids])).rows;
  for(const item of before){const saved=after.find(row=>row.id===item.id);assert.equal(saved.token_hash,item.token_hash);assert.equal(saved.status,item.status);
    if(item.id===ids[0])assert.equal(saved.expires_at,null);else assert.deepEqual(saved.expires_at,item.expires_at);}
 });
});
