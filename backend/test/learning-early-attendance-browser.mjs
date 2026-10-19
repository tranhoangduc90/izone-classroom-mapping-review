// Chrome → route thật → service thật → PostgreSQL role ứng dụng, toàn bộ dùng học viên giả.
// Chặn mạng ngoài loopback; kiểm bài nộp trống và điểm danh trước/sau final bằng readback DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { postgresFixture } from './learning-postgres-fixture.js';
import { createLearningRouter } from '../src/learning-routes.js';
const { chromium } = createRequire('C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');
const pagesRoot = fileURLToPath(new URL('../../../pages/', import.meta.url));
const evidence = 'E:/Codex-Data/progress-early-attendance-20261019/screenshots';

test('E05: Chrome nộp hai phần trống qua API thật, reload giữ tham gia và final không nhân điểm danh', { timeout: 90000 }, async () => {
  const fixture = await postgresFixture({ asApplication: true });
  let server, browser;
  try {
    const published = await fixture.service.publishReflectionForm({
      reviewer: { email: 'teacher@example.test', canAccessAllClasses: false }, title: 'Phiếu kiểm hai phần trống',
      courseCode: 'course-67', classId: '2139', sessionNumber: 3, opensAt: null, closesAt: null,
      items: [{ libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true },
        { libraryItemId: '10000000-0000-4000-8000-000000000002', checkpoint: 2, required: true }]
    });
    const assignment = await fixture.service.getPublicAssignment(published.publicToken);
    const app = express(); app.use(express.json());
    let origin;
    app.get('/progress-log/config.js', (_req, res) => res.type('js').send(`window.PROGRESS_LOG_CONFIG={API_BASE_URL:'${origin}'};`));
    app.post('/api/learning/student/session-comments', (_req,res) => res.json({ok:true,comments:[]}));
    app.use('/api/learning', createLearningRouter({ pool: fixture.clockPool, authenticate: (_req,res) => res.sendStatus(403) }));
    app.use(express.static(pagesRoot));
    server = await new Promise(done => { const instance = app.listen(0,'127.0.0.1',() => done(instance)); });
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel:'chrome', headless:true });
    await mkdir(evidence,{recursive:true});
    for (const [index,width] of [390,1440].entries()) {
      await fixture.pool.query(`UPDATE learning.assignment_block_release
        SET status=CASE WHEN block_id=$2::uuid THEN 'open' ELSE 'locked' END WHERE assignment_id=$1::uuid`,
      [assignment.assignmentId,assignment.definition.blocks[0].blockId]);
      const context = await browser.newContext({viewport:{width,height:900}});
      const page = await context.newPage(); page.setDefaultTimeout(7000);
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await context.route('**/*',route => new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
      const student=assignment.roster[index];
      await page.goto(`${origin}/progress-log/#assignment=${published.publicToken}`);
      await page.locator('#studentSelect').selectOption(student.studentRef);
      await page.locator('#chooseStudentButton').click();await page.locator('#confirmButton').click();
      await page.locator('#formView').waitFor({state:'visible'});
      await page.locator('#nextButton').click();
      await page.waitForFunction(()=>/điền đủ|ghi nhận tham gia/i.test(document.querySelector('#notice').textContent));
      const first=(await fixture.pool.query(`SELECT
        (SELECT count(*)::int FROM learning.checkpoint_submission WHERE student_ref=$1::uuid) AS checkpoints,
        (SELECT count(*)::int FROM learning.submission WHERE student_ref=$1::uuid) AS finals,
        (SELECT count(*)::int FROM learning.attendance_record WHERE student_ref=$1::uuid AND status='self_confirmed') AS attendance`,[student.studentRef])).rows[0];
      assert.deepEqual(first,{checkpoints:1,finals:0,attendance:1},'Phải nhận phần trống và điểm danh trước final');
      assert.match(await page.locator('#notice').textContent(),/ghi nhận tham gia/i);
      assert.equal(await page.locator('#checkpointTitle').textContent(),assignment.definition.blocks[0].title);
      await page.screenshot({path:`${evidence}/early-attendance-${width}.png`,fullPage:true});
      await page.reload();await page.locator('#formView').waitFor({state:'visible'});
      await fixture.pool.query("UPDATE learning.assignment_block_release SET status='open' WHERE assignment_id=$1::uuid",[assignment.assignmentId]);
      await page.locator('#nextButton').click();
      await page.waitForFunction(title=>document.querySelector('#checkpointTitle').textContent===title,assignment.definition.blocks[1].title);
      await page.locator('#submitButton').click();
      await page.locator('#resultView').waitFor({state:'visible'});
      assert.match(await page.locator('#completenessResult').textContent(),/câu trống|chưa trả lời/i);
      const after=(await fixture.pool.query(`SELECT
        (SELECT count(*)::int FROM learning.attendance_event WHERE student_ref=$1::uuid) AS events,
        (SELECT count(*)::int FROM learning.outbox_job WHERE entity_key='student:'||$1::text AND job_type='sync_portal_attendance') AS jobs,
        (SELECT count(*)::int FROM learning.submission WHERE student_ref=$1::uuid) AS finals`,[student.studentRef])).rows[0];
      assert.deepEqual(after,{events:1,jobs:1,finals:1});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      await page.screenshot({path:`${evidence}/final-blank-${width}.png`,fullPage:true});
      // Bài nộp còn trống vẫn mở xem lại được qua Journey, đúng học viên và đúng buổi.
      await page.locator('#journeyResultButton').click();
      await page.locator('#journeyView').waitFor({state:'visible'});
      await page.locator('[data-session-number="3"]').click();
      await page.locator('#journeyDetailStatus').filter({hasText:'Bài đã nộp'}).waitFor();
      assert.match(await page.locator('#journeyDetailContent').textContent(),/Sau phần vừa học/);
      const detail=await fixture.service.getStudentCourseSessionDetail({publicToken:published.publicToken,
        studentRef:student.studentRef,identityConfirmed:true,sessionNumber:3});
      assert.equal(detail.student.studentRef,student.studentRef);assert.deepEqual(detail.responses,{});
      await context.close();
    }
  } finally {
    await browser?.close();
    if(server)await new Promise(done=>server.close(done));
    await fixture.close();
  }
});
