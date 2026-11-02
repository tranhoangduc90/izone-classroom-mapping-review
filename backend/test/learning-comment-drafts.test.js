import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import {setupDatabase,poolFrom} from './journey-comment-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningRouter} from '../src/learning-routes.js';

const ref='60000000-0000-4000-8000-000000000001';
const reviewer={email:'teacher@example.test',displayName:'Cô thử nghiệm',canAccessAllClasses:false};
const other={...reviewer,email:'second@example.test'};
const target={classId:'2139',studentRef:ref,sessionNumber:2,reviewer};
const id=()=>crypto.randomUUID();

export async function draftFixture(database) {
  for(const name of ['202610070001_student_journey_comments','202610220001_assignment_management','202611020001_teacher_comment_drafts'])
    await database.exec(await readFile(new URL('../ops/learning-migrations/'+name+'.sql',import.meta.url),'utf8'));
  await database.exec(`INSERT INTO learning.class_journey_plan(erp_course_class_id,total_sessions,test_session_numbers,revision,confirmed_by_email,confirmed_at)
    VALUES(2139,3,ARRAY[2],1,'teacher@example.test',now());
    INSERT INTO mapping.reviewer_class_access VALUES('second@example.test',2139);
    INSERT INTO mapping.reviewer_account VALUES('second@example.test','active');`);
}

test('Thẻ 24: nháp riêng, mở máy khác, gửi độc lập, sửa/xóa và retry nguyên tử',async t=>{
  const {database}=await setupDatabase();t.after(()=>database.close());await draftFixture(database);
  const pool=poolFrom(database),service=createLearningService({pool,journeyCommentsEnabled:true});
  let draft,comment;
  await t.test('lưu nháp máy A và mở máy B cùng tài khoản; HV không đọc được',async()=>{
    const input={...target,noteText:'Nháp riêng\n<script>không chạy</script>',expectedRevision:0,expectedDraftRevision:0,operationId:id()};
    draft=await service.saveSessionCommentDraft(input);
    assert.equal(draft.revision,1);assert.equal((await service.saveSessionCommentDraft(input)).replayed,true);
    const deviceB=createLearningService({pool,journeyCommentsEnabled:true});
    const state=await deviceB.getSessionCommentEditor(target);assert.equal(state.draft.noteText,input.noteText);assert.equal(state.comment,null);
    assert.equal((await service.getSessionCommentEditor({...target,reviewer:other})).draft,null);
    assert.deepEqual(await service.readComments('2139',ref,{visibleOnly:true}),[]);
    await assert.rejects(()=>service.saveSessionCommentDraft({...input,noteText:'Khác'}),e=>e.code==='COMMENT_OPERATION_CONFLICT');
    await assert.rejects(()=>service.getSessionCommentEditor({...target,reviewer:{email:'denied@example.test'}}),e=>e.code==='CLASS_ACCESS_DENIED');
  });
  await t.test('gửi từ nội dung đang gõ, dọn nháp riêng và giữ revision chống ABA',async()=>{
    const input={...target,noteText:'Bản gửi đầu',expectedRevision:0,expectedDraftRevision:1,operationId:id()};
    comment=await service.sendSessionComment(input);assert.equal(comment.revision,1);assert.equal(comment.draftRevision,2);
    assert.equal((await service.sendSessionComment(input)).replayed,true);
    const state=await service.getSessionCommentEditor(target);assert.equal(state.draft.noteText,null);assert.equal(state.draft.revision,2);
    assert.equal((await service.readComments('2139',ref,{visibleOnly:true}))[0].noteText,input.noteText);
    await assert.rejects(()=>service.saveSessionCommentDraft({...target,noteText:'Thiết bị cũ',expectedRevision:1,expectedDraftRevision:0,operationId:id()}),e=>e.code==='COMMENT_DRAFT_STALE');
  });
  await t.test('sửa rồi lưu nháp giữ nguyên bản cũ trước học viên; tài khoản khác có nháp riêng',async()=>{
    draft=await service.saveSessionCommentDraft({...target,noteText:'Bản sửa chưa gửi',expectedRevision:1,expectedDraftRevision:2,operationId:id()});
    await service.saveSessionCommentDraft({...target,reviewer:other,noteText:'Nháp giáo viên khác',expectedRevision:1,expectedDraftRevision:0,operationId:id()});
    assert.equal((await service.readComments('2139',ref,{visibleOnly:true}))[0].noteText,'Bản gửi đầu');
    assert.equal((await service.getSessionCommentEditor(target)).draft.noteText,'Bản sửa chưa gửi');
    await assert.rejects(()=>service.sendSessionComment({...target,noteText:'Thiết bị cũ',expectedRevision:1,expectedDraftRevision:2,operationId:id()}),e=>e.code==='COMMENT_DRAFT_STALE');
    comment=await service.sendSessionComment({...target,noteText:'Bản sửa gửi thật',expectedRevision:1,expectedDraftRevision:draft.revision,operationId:id()});
    assert.equal(comment.revision,2);
    assert.equal((await service.getSessionCommentEditor({...target,reviewer:other})).draft.noteText,'Nháp giáo viên khác');
    await assert.rejects(()=>service.saveSessionCommentDraft({...target,reviewer:other,noteText:'Nháp từ bản cũ',expectedRevision:1,expectedDraftRevision:1,operationId:id()}),e=>e.code==='COMMENT_STALE');
  });
  await t.test('gửi thẳng khi chưa từng có nháp và xóa chỉ gỡ công khai, giữ lịch sử/nháp',async()=>{
    const direct=await service.sendSessionComment({...target,sessionNumber:1,noteText:'Gửi thẳng',expectedRevision:0,expectedDraftRevision:0,operationId:id()});
    assert.equal(direct.draftRevision,0);
    const remove={...target,expectedRevision:2,operationId:id()};
    assert.equal((await service.deleteSessionComment(remove)).visibility,'hidden');
    assert.equal((await service.deleteSessionComment(remove)).replayed,true);
    assert.equal((await service.readComments('2139',ref,{visibleOnly:true})).length,1);
    assert.equal((await service.getSessionCommentHistory(target)).length,3);
    assert.equal((await service.getSessionCommentEditor({...target,reviewer:other})).draft.noteText,'Nháp giáo viên khác');
  });
  await t.test('rỗng, quá dài, Unicode và thu hẹp lịch không làm mất nháp',async()=>{
    for(const noteText of ['', ' ', 'a'.repeat(1001), 'a\0b'])await assert.rejects(()=>service.saveSessionCommentDraft({...target,noteText,expectedRevision:3,expectedDraftRevision:4,operationId:id()}),e=>e.code==='INVALID_SESSION_COMMENT');
    await service.saveSessionCommentDraft({...target,sessionNumber:3,noteText:'😀'.repeat(1000),expectedRevision:0,expectedDraftRevision:0,operationId:id()});
    await assert.rejects(()=>database.query('UPDATE learning.class_journey_plan SET total_sessions=2 WHERE erp_course_class_id=2139'),e=>e.code==='23514');
    await assert.rejects(()=>service.saveSessionCommentDraft({...target,sessionNumber:4,noteText:'Ngoài kế hoạch',expectedRevision:0,expectedDraftRevision:0,operationId:id()}),e=>e.code==='COMMENT_SESSION_NOT_CONFIRMED');
  });
  await t.test('lỗi ghi lịch sử rollback cả bản công khai và việc dọn nháp',async()=>{
    const failingPool={...pool,connect:async()=>{const client=await pool.connect();return {...client,query:(sql,params)=>{
      if(sql.includes('INSERT INTO learning.student_session_comment_revision'))throw Error('fixture-write-error');return client.query(sql,params);
    }};}};
    const before=await service.getSessionCommentEditor({...target,sessionNumber:3});
    const failing=createLearningService({pool:failingPool,journeyCommentsEnabled:true});
    await assert.rejects(()=>failing.sendSessionComment({...target,sessionNumber:3,noteText:'Không được ghi một phần',expectedRevision:0,expectedDraftRevision:1,operationId:id()}),/fixture-write-error/);
    assert.deepEqual(await service.getSessionCommentEditor({...target,sessionNumber:3}),before);
  });
  await t.test('API strict, no-store và actor lấy từ phiên; hợp đồng cũ vẫn gửi/ẩn',async()=>{
    const app=express();app.use(express.json());
    app.use('/api/learning',createLearningRouter({pool,journeyCommentsEnabled:true,
      progressLinkKeys:{v1:Buffer.alloc(32,17).toString('base64')},authenticate:(req,_res,next)=>{req.reviewer=reviewer;next();}}));
    const root='/api/learning/teacher/session-comments';
    const data=await request(app).get(root+'/editor').query({classId:'2139',studentRef:ref,sessionNumber:3});
    assert.equal(data.status,200);assert.equal(data.headers['cache-control'],'no-store');assert.equal(data.body.draft.noteText,'😀'.repeat(1000));
    const body={classId:'2139',studentRef:ref,sessionNumber:1,noteText:'Mới',expectedRevision:1,expectedDraftRevision:0,operationId:id()};
    assert.equal((await request(app).put(root+'/draft').send({...body,teacherEmail:other.email})).status,400);
    assert.equal((await request(app).post(root+'/send').send(body)).status,200);
    const legacy={classId:'2139',studentRef:ref,sessionNumber:1,noteText:'Client cũ',expectedRevision:2,operationId:id()};
    assert.equal((await request(app).put(root).send(legacy)).status,200);
    assert.equal((await request(app).post(root+'/hide').send({...legacy,noteText:undefined,expectedRevision:3,operationId:id()})).status,200);
    const counts=await database.query(`SELECT (SELECT count(*) FROM learning.attempt)::int AS attempts,
      (SELECT count(*) FROM learning.submission)::int AS submissions,(SELECT count(*) FROM learning.attendance_event)::int AS events,
      (SELECT count(*) FROM learning.outbox_job)::int AS jobs`);
    assert.deepEqual(counts.rows[0],{attempts:0,submissions:0,events:0,jobs:0});
  });
});
