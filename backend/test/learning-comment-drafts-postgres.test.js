import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {postgresFixture} from './learning-postgres-fixture.js';
import {createLearningService} from '../src/learning-service.js';
const id=()=>crypto.randomUUID();

test('Thẻ 24 PostgreSQL quyền API và nhiều kết nối: nháp, gửi, replay, xung đột và lịch sử',{timeout:60000},async t=>{
  const fixture=await postgresFixture({asApplication:true,studentCount:20});t.after(()=>fixture.close());
  for(const name of ['202610070001_student_journey_comments','202611020001_teacher_comment_drafts'])
    await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/'+name+'.sql',import.meta.url),'utf8'));
  await fixture.pool.query(`INSERT INTO learning.class_journey_plan(erp_course_class_id,total_sessions,revision,confirmed_by_email) VALUES(2139,3,1,'teacher@example.test');
    INSERT INTO mapping.reviewer_account VALUES('second@example.test','active');
    INSERT INTO mapping.reviewer_class_access VALUES('second@example.test',2139);`);
  const service=createLearningService({pool:fixture.clockPool,journeyCommentsEnabled:true});
  const refs=(await fixture.pool.query('SELECT public_id::text AS ref FROM mapping.student_mapping_review ORDER BY erp_student_contact_id')).rows.map(r=>r.ref);
  const target={classId:'2139',studentRef:refs[0],sessionNumber:2,reviewer:{email:'teacher@example.test',displayName:'Giảng viên thử',canAccessAllClasses:false}};
  await t.test('20 lần ghi cạnh tranh chỉ một bản nháp; 20 retry cùng operation chỉ tăng một revision',async()=>{
    const results=await Promise.allSettled(Array.from({length:20},(_,i)=>service.saveSessionCommentDraft({...target,noteText:'Nháp '+i,expectedRevision:0,expectedDraftRevision:0,operationId:id()})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='COMMENT_DRAFT_STALE'));
    const input={...target,noteText:'Lưu đúng một lần',expectedRevision:0,expectedDraftRevision:1,operationId:id()};
    const replay=await Promise.all(Array.from({length:20},()=>service.saveSessionCommentDraft(input)));assert.ok(replay.every(d=>d.revision===2));
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM learning.teacher_session_comment_draft_operation')).rows[0].n,2);
  });
  await t.test('20 gửi lại cùng operation chỉ một bản công khai, dọn đúng nháp người gửi',async()=>{
    const other={...target,reviewer:{...target.reviewer,email:'second@example.test'}};
    await service.saveSessionCommentDraft({...other,noteText:'Giữ riêng tài khoản khác',expectedRevision:0,expectedDraftRevision:0,operationId:id()});
    const input={...target,noteText:'Nhận xét đã gửi',expectedRevision:0,expectedDraftRevision:2,operationId:id()};
    const notes=await Promise.all(Array.from({length:20},()=>service.sendSessionComment(input)));assert.ok(notes.every(n=>n.revision===1&&n.draftRevision===3));
    assert.equal((await service.getSessionCommentEditor(target)).draft.noteText,null);
    assert.equal((await service.getSessionCommentEditor(other)).draft.noteText,'Giữ riêng tài khoản khác');
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM learning.student_session_comment_revision')).rows[0].n,1);
  });
  await t.test('lưu nháp và gửi từ hai thiết bị cùng revision không mất chữ hoặc ghi đè',async()=>{
    const outcomes=await Promise.allSettled([
      service.saveSessionCommentDraft({...target,noteText:'Sửa riêng',expectedRevision:1,expectedDraftRevision:3,operationId:id()}),
      service.sendSessionComment({...target,noteText:'Gửi bản mới',expectedRevision:1,expectedDraftRevision:3,operationId:id()})]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.ok(['COMMENT_STALE','COMMENT_DRAFT_STALE'].includes(outcomes.find(r=>r.status==='rejected').reason.code));
    const current=await service.getSessionCommentEditor(target);assert.equal(current.draft.revision,4);
    if(current.comment.revision===1)assert.equal(current.draft.noteText,'Sửa riêng');else{assert.equal(current.comment.noteText,'Gửi bản mới');assert.equal(current.draft.noteText,null);}
  });
  await t.test('quyền tối thiểu cho ghi mới, không sửa định danh hoặc xóa lịch sử',async()=>{
    await assert.rejects(()=>fixture.clockPool.query("UPDATE learning.teacher_session_comment_draft SET teacher_email='wrong@example.test'"),e=>e.code==='42501');
    await assert.rejects(()=>fixture.clockPool.query('DELETE FROM learning.teacher_session_comment_draft_operation'),e=>e.code==='42501');
    await assert.rejects(()=>fixture.clockPool.query("UPDATE learning.student_session_comment_revision SET note_text='Sai'"),e=>e.code==='42501');
    await Promise.all(refs.slice(1).map((studentRef,i)=>service.saveSessionCommentDraft({...target,studentRef,noteText:'Nháp đúng người '+i,expectedRevision:0,expectedDraftRevision:0,operationId:id()})));
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM learning.teacher_session_comment_draft')).rows[0].n,21);
    const counts=(await fixture.pool.query(`SELECT (SELECT count(*) FROM learning.attempt)::int AS attempts,(SELECT count(*) FROM learning.submission)::int AS submissions,(SELECT count(*) FROM learning.attendance_event)::int AS events,(SELECT count(*) FROM learning.outbox_job)::int AS jobs`)).rows[0];
    assert.deepEqual(counts,{attempts:0,submissions:0,events:0,jobs:0});
  });
});
