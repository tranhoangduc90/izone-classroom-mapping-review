import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import {setupDatabase,poolFrom} from './journey-comment-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningRouter} from '../src/learning-routes.js';
import {createProgressLinkCipher} from '../src/learning-journey-comments.js';

const keys={v1:Buffer.alloc(32,17).toString('base64')};
const reviewer={email:'teacher@example.test',displayName:'Cô thử nghiệm',canAccessAllClasses:false};
const ref='60000000-0000-4000-8000-000000000001',other='60000000-0000-4000-8000-000000000002';
const target={classId:'2139',studentRef:ref,sessionNumber:2,reviewer};
const operation=()=>crypto.randomUUID();

test('Hành trình riêng và nhận xét: dữ liệu, quyền, phiên bản, retry và không ghi điểm danh',async t=>{
 const {database}=await setupDatabase();t.after(()=>database.close());
 await database.exec(await readFile(new URL('../ops/learning-migrations/202610070001_student_journey_comments.sql',import.meta.url),'utf8'));
 await database.exec(`INSERT INTO learning.class_journey_plan (erp_course_class_id,total_sessions,test_session_numbers,
   revision,confirmed_by_email,confirmed_at) VALUES (2139,3,ARRAY[2],1,'teacher@example.test',now())`);
 const pool=poolFrom(database),cipher=createProgressLinkCipher({keys}),
   service=createLearningService({pool,journeyCommentsEnabled:true,progressLinkCipher:cipher});
 let link,note;
 await t.test('link đầu tiên không hết hạn, lấy lại ở service/máy khác giữ nguyên, DB không chứa token thô',async()=>{
   const input={...target,operationId:operation()};link=await service.resolveStudentProgressLink(input);
   assert.equal(link.expiresAt,null);assert.equal(link.status,'active');assert.match(link.accessToken,/^[A-Za-z0-9_-]{43}$/);
   const second=createLearningService({pool,journeyCommentsEnabled:true,progressLinkCipher:cipher});
   const again=await second.resolveStudentProgressLink({...target,operationId:operation()});assert.equal(again.accessToken,link.accessToken);
   const replay=await second.resolveStudentProgressLink(input);assert.equal(replay.replayed,true);assert.equal(replay.accessId,link.accessId);
   const rows=await database.query('SELECT * FROM learning.student_progress_access');assert.equal(rows.rows.length,1);
   assert.equal(JSON.stringify(rows.rows).includes(link.accessToken),false);
   await assert.rejects(()=>second.resolveStudentProgressLink({...input,studentRef:other}),e=>e.code==='PROGRESS_LINK_OPERATION_CONFLICT');
   const journey=await second.getStudentCourseJourney({accessToken:link.accessToken});assert.equal(journey.student.studentRef,ref);assert.equal(journey.sessions.length,3);
 });
 await t.test('nhận xét buổi Test chưa có phiếu, Unicode/xuống dòng và retry cùng thao tác',async()=>{
   const input={...target,noteText:'  Em đọc tốt hơn.\n<script>không chạy</script>  ',expectedRevision:0,operationId:operation()};
   note=await service.saveSessionComment(input);assert.equal(note.revision,1);assert.equal(note.noteText,input.noteText.trim());
   assert.equal((await service.saveSessionComment(input)).revision,1);
   await assert.rejects(()=>service.saveSessionComment({...input,noteText:'Khác'}),e=>e.code==='COMMENT_OPERATION_CONFLICT');
   const journey=await service.getStudentCourseJourney({accessToken:link.accessToken});assert.equal(journey.sessions[1].sessionComment.noteText,note.noteText);
   const detail=await service.getStudentCourseSessionDetail({accessToken:link.accessToken,sessionNumber:2});
   assert.equal(detail.definition,null);assert.equal(detail.sessionComment.noteText,note.noteText);assert.deepEqual(detail.responses,{});
   const batch=await service.getStudentSessionComments({accessToken:link.accessToken});assert.equal(batch.comments.length,1);
   assert.equal(JSON.stringify(batch).includes(reviewer.email),false);assert.equal(batch.comments[0].authorDisplayName,reviewer.displayName);
 });
 await t.test('xung đột hai GV giữ một bản, ẩn không xóa lịch sử và không xuất cho HV',async()=>{
   await assert.rejects(()=>service.saveSessionComment({...target,noteText:'bản cũ',expectedRevision:0,operationId:operation()}),e=>e.code==='COMMENT_STALE');
   const input={...target,expectedRevision:1,operationId:operation()};const hidden=await service.hideSessionComment(input);
   assert.equal(hidden.revision,2);assert.equal((await service.hideSessionComment(input)).revision,2);
   assert.deepEqual((await service.getStudentSessionComments({accessToken:link.accessToken})).comments,[]);
   assert.equal((await service.getStudentCourseJourney({accessToken:link.accessToken})).sessions[1].sessionComment,null);
   const history=await service.getSessionCommentHistory(target);assert.equal(history.length,2);assert.equal(history[1].noteText,note.noteText);
   note=await service.saveSessionComment({...target,noteText:'Đã cập nhật',expectedRevision:2,operationId:operation()});assert.equal(note.revision,3);
 });
 await t.test('trống/1001 ký tự/ngoài kế hoạch/trái quyền/trùng tên đều được kiểm trước ghi',async()=>{
   for(const text of ['', ' ', 'a'.repeat(1001)])await assert.rejects(()=>service.saveSessionComment({...target,noteText:text,expectedRevision:3,operationId:operation()}),e=>e.code==='INVALID_SESSION_COMMENT');
   const long=await service.saveSessionComment({...target,studentRef:other,noteText:'😀'.repeat(1000),expectedRevision:0,operationId:operation()});assert.equal([...long.noteText].length,1000);
   await assert.rejects(()=>service.saveSessionComment({...target,sessionNumber:4,noteText:'ngoài',expectedRevision:0,operationId:operation()}),e=>e.code==='COMMENT_SESSION_NOT_CONFIRMED');
   await assert.rejects(()=>service.saveSessionComment({...target,reviewer:{email:'wrong@example.test',canAccessAllClasses:false},noteText:'sai lớp',expectedRevision:3,operationId:operation()}),e=>e.code==='CLASS_ACCESS_DENIED');
   await assert.rejects(()=>database.query('UPDATE learning.class_journey_plan SET total_sessions=1 WHERE erp_course_class_id=2139'),e=>e.code==='23514');
   const person=(await service.getStudentSessionComments({accessToken:link.accessToken})).comments;assert.equal(person.length,1);assert.equal(person[0].noteText,'Đã cập nhật');
 });
 await t.test('thay/thu hồi link đúng expectedAccessId; không tự tái tạo; retry cũ không làm sống link',async()=>{
   const input={...target,expectedAccessId:link.accessId,operationId:operation()};const rotated=await service.rotateStudentProgressLink(input);
   assert.notEqual(rotated.accessToken,link.accessToken);assert.equal((await service.rotateStudentProgressLink(input)).accessId,rotated.accessId);
   await assert.rejects(()=>service.getStudentCourseJourney({accessToken:link.accessToken}),e=>e.code==='PROGRESS_LINK_INVALID');
   await assert.rejects(()=>service.revokeStudentProgressLink({...target,expectedAccessId:link.accessId,operationId:operation()}),e=>e.code==='PROGRESS_LINK_STALE');
   const revoked=await service.revokeStudentProgressLink({...target,expectedAccessId:rotated.accessId,operationId:operation()});assert.equal(revoked.status,'revoked');
   assert.equal((await service.resolveStudentProgressLink({...target,operationId:operation()})).status,'revoked');
   await assert.rejects(()=>service.rotateStudentProgressLink(input),e=>e.code==='PROGRESS_LINK_STALE');
 });
 await t.test('link hash-only giữ nguyên; link hết hạn không được hồi sinh',async()=>{
   const token='legacy-only-hash-token-12345678901234567890';
   await database.query(`INSERT INTO learning.student_progress_access (id,erp_course_class_id,student_ref,token_hash,status,expires_at,created_by_email,operation_key,idempotency_key)
     VALUES ($1,2139,$2,$3,'active',now()+interval '1 day','teacher@example.test','legacy','legacy:write')`,[operation(),other,crypto.createHash('sha256').update(token).digest('hex')]);
   const legacy=await service.resolveStudentProgressLink({...target,studentRef:other,operationId:operation()});assert.equal(legacy.status,'legacy');assert.equal(legacy.accessToken,null);
   assert.equal((await service.getStudentCourseJourney({accessToken:token})).student.studentRef,other);
   await database.query('UPDATE learning.student_progress_access SET expires_at=now()-interval \'1 day\' WHERE id=$1',[legacy.accessId]);
   assert.equal((await service.resolveStudentProgressLink({...target,studentRef:other,operationId:operation()})).status,'expired');
   await assert.rejects(()=>service.getStudentCourseJourney({accessToken:token}),e=>e.code==='PROGRESS_LINK_INVALID');
 });
 await t.test('route strict identity/no-store, chặn client link cũ và không thay đổi attempt/điểm danh',async()=>{
   const app=express();app.use(express.json());app.use('/api/learning',createLearningRouter({pool,journeyCommentsEnabled:true,progressLinkKeys:keys,authenticate:(req,_res,next)=>{req.reviewer=reviewer;next();}}));
   const old=await request(app).post('/api/learning/teacher/student-progress-links').send({});assert.equal(old.status,409);assert.equal(old.body.error,'PROGRESS_LINK_CLIENT_UPGRADE_REQUIRED');
   const bad=await request(app).post('/api/learning/student/session-comments').send({accessToken:'x'.repeat(43),classId:'2139'});assert.equal(bad.status,400);
   const result=await request(app).get('/api/learning/teacher/session-comments/history').query({classId:'2139',studentRef:ref,sessionNumber:2});assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');
   const counts=await database.query(`SELECT (SELECT count(*) FROM learning.attempt)::int AS attempts,
     (SELECT count(*) FROM learning.submission)::int AS submissions,(SELECT count(*) FROM learning.attendance_event)::int AS events,
     (SELECT count(*) FROM learning.outbox_job)::int AS jobs`);assert.deepEqual(counts.rows[0],{attempts:0,submissions:0,events:0,jobs:0});
 });
});

test('AES-GCM gắn đúng lớp/người/ID và hỗ trợ giữ khóa phiên bản cũ',()=>{
 const cipher=createProgressLinkCipher({keys});const row={id:operation(),erp_course_class_id:'2139',student_ref:ref};
 const token='demo-private-random-token';const sealed=cipher.encrypt(token,row);
 const encoded={...row,token_ciphertext:sealed.ciphertext,token_key_version:sealed.version,token_hash:crypto.createHash('sha256').update(token).digest('hex')};
 assert.equal(cipher.decrypt(encoded),token);assert.throws(()=>cipher.decrypt({...encoded,student_ref:other}));
 const second=createProgressLinkCipher({keys:{...keys,v2:Buffer.alloc(32,23).toString('base64')},activeVersion:'v2'});assert.equal(second.decrypt(encoded),token);
});
