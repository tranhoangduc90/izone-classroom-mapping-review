import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createAssessmentSchemaPool } from '../src/assessment-schema-pool.js';
import { resolveDeploymentProfile } from '../src/deployment-profile.js';
import { createErpGradeSync } from '../src/erp-sync.js';
import { createTermTestWritingGradingService } from '../src/term-test-writing-grading.js';

const ORIGIN = 'https://tranhoangduc90.github.io';
const WORKER_SECRET = 'fixture-only-writing-sync-secret';
const PORTAL_SECRET = 'fixture-only-portal-sync-secret';
const cases = [
  {
    slug: 'term-test-1-k56',
    token: '00000000-0000-4000-8000-000000009001',
    classId: 990001,
    studentId: 991001,
    className: 'IC990001',
    taskNumber: 2,
    essay: 'Bài giả Task 2 của Term 1: “đúng bài” — e\u0301 và 🧪.',
    listeningCorrect: 20,
    readingCorrect: 13,
    readingTotal: 26
  },
  {
    slug: 'term-test-2-k56',
    token: '00000000-0000-4000-8000-000000009002',
    classId: 990002,
    studentId: 991002,
    className: 'IC990002',
    taskNumber: 1,
    essay: 'Bài giả Task 1 của Term 2: “đúng bài” — e\u0301 và 🧪.',
    listeningCorrect: 21,
    readingCorrect: 22,
    readingTotal: 40
  },
  {
    slug: 'term-test-1-k56',
    token: '00000000-0000-4000-8000-000000009003',
    classId: 990003,
    studentId: 991003,
    className: 'CODEX-CANARY-TIMEOUT',
    taskNumber: 2,
    essay: 'Bài giả Task 2 của lượt mất phản hồi Portal.',
    listeningCorrect: 19,
    readingCorrect: 12,
    readingTotal: 26,
    simulatePortalTimeout: true
  },
  {
    slug: 'term-test-2-k56',
    token: '00000000-0000-4000-8000-000000009004',
    classId: 990004,
    studentId: 991004,
    className: 'CODEX-CANARY-DEADLINE',
    taskNumber: 1,
    essay: 'Bản nháp đúng hạn của bài giả Term 2.',
    lateEssay: 'Phần sửa muộn tuyệt đối không được chấm.',
    listeningCorrect: 22,
    readingCorrect: 23,
    readingTotal: 40
  }
];

function criteria(taskNumber) {
  const codes = taskNumber === 1 ? ['TA', 'CC', 'LR', 'GRA'] : ['TR', 'CC', 'LR', 'GRA'];
  return codes.map(code => ({
    code,
    name: code,
    bandScore: 6.5,
    feedback: `Nhận xét giả ${code}: “độ chính xác” — e\u0301 và 🧪.`,
    components: []
  }));
}

async function verifyPagesAgainstBackend(app) {
  // Dữ liệu vào: source Pages được chỉ rõ bằng K56_PAGES_ROOT và hai lượt bài giả đã chấm trong API.
  // Việc chính: mở Chrome, cho trang gọi endpoint kết quả của API thử và chặn mọi request thật.
  // Kết quả: học viên giả thấy đúng lớp, Task, bài, điểm và bốn nhận xét sau khi tải lại.
  // Khi lỗi: test đỏ; browser và máy chủ file thử được đóng, production không có request.
  if (!process.env.K56_PAGES_ROOT) return;
  const pagesRoot = resolve(process.env.K56_PAGES_ROOT);
  const modules = process.env.CODEX_NODE_MODULES || resolve(
    process.env.USERPROFILE || '', '.cache', 'codex-runtimes',
    'codex-primary-runtime', 'dependencies', 'node', 'node_modules'
  );
  const { chromium } = createRequire(pathToFileURL(resolve(modules, 'playwright', 'package.json')).href)('playwright');
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const target = resolve(pagesRoot, `.${relative}`);
    if (!target.startsWith(`${pagesRoot}${sep}`)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
      res.end(await readFile(target));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const siteBase = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    for (const item of cases.slice(0, 2)) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const calls = [];
        const blocked = [];
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ slug, className, token }) => {
          localStorage.setItem(`izone-test:${slug}:${className}`, JSON.stringify({
            studentRef: '11111111-1111-4111-8111-111111111111',
            studentName: 'Học viên giả', attemptToken: token,
            completed: true, writingStarted: true, writingSubmitted: true
          }));
        }, { slug: item.slug, className: item.className, token: item.token });
        await context.route('**/*', async route => {
          const req = route.request();
          const url = new URL(req.url());
          if (/\/k56(?:-test2)?-shared\/config\.js$/u.test(url.pathname)) {
            return route.fulfill({ contentType: 'text/javascript',
              body: "window.TERM_TEST_APP_CONFIG={API_BASE_URL:'https://ducizone.ddns.net/mapping-api'};" });
          }
          if (url.pathname === '/mapping-api/api/term-tests/roster') {
            return route.fulfill({ json: { class: { name: item.className },
              students: [{ ref: '11111111-1111-4111-8111-111111111111', name: 'Học viên giả' }] } });
          }
          if (url.pathname === '/mapping-api/api/term-tests/result' && req.method() === 'POST') {
            const payload = req.postDataJSON();
            calls.push(payload);
            const result = await request(app).post('/api/term-tests/result')
              .set('Origin', ORIGIN).send(payload);
            return route.fulfill({ status: result.status, json: result.body });
          }
          if (url.pathname === `/mapping-api/api/term-tests/${item.slug}/session/resume-attempt`) {
            const content = await page.evaluate(() => window.K56_TERM_TEST_CONTENT);
            return route.fulfill({ json: { content, serverNow: new Date().toISOString(),
              attemptToken: item.token, listeningSubmitted: true } });
          }
          if (url.pathname === '/mapping-api/api/term-tests/result/stream') {
            return route.fulfill({ status: 404, json: { message: 'Fixture: kiểm tra kết quả.' } });
          }
          if (req.method() === 'GET' && req.url().startsWith(siteBase)) return route.continue();
          blocked.push(`${req.method()} ${url.origin}${url.pathname}`);
          return route.abort();
        });
        await page.goto(`${siteBase}term-tests/${item.slug}-computer-based/?class=${item.className}`);
        const score = page.locator('#writingSubmissionResult .writing-score-card.is-action');
        try {
          await score.waitFor({ state: 'visible', timeout: 10_000 });
        } catch (error) {
          throw new Error(`Trang chưa hiện điểm từ API thử: ${JSON.stringify({
            slug: item.slug, body: (await page.locator('body').innerText()).slice(0, 700),
            calls: calls.length, blocked, errors
          })}`, { cause: error });
        }
        assert.match(await score.innerText(), new RegExp(`Writing Task ${item.taskNumber}[\\s\\S]*Band 6.5`));
        assert.match(await page.locator('#resultMeta').innerText(), new RegExp(item.className));
        assert.equal(await page.locator('#resultStudentName').innerText(), 'Học viên giả');
        await score.click();
        const dialog = page.locator('.writing-feedback-dialog');
        await dialog.waitFor({ state: 'visible' });
        assert.equal(await dialog.locator('.writing-feedback-essay').innerText(), item.essay);
        assert.equal(await dialog.locator('.writing-band-summary-item').count(), 4);
        assert.match(await dialog.innerText(), new RegExp(`Báo cáo giả ${item.slug}`));
        for (const row of criteria(item.taskNumber)) {
          assert.match(await dialog.innerText(), new RegExp(row.feedback));
        }
        await dialog.getByRole('button', { name: 'Đóng bài chấm Writing' }).click();
        await page.reload();
        await score.waitFor({ state: 'visible' });
        await score.click();
        await dialog.waitFor({ state: 'visible' });
        assert.equal(await dialog.locator('.writing-feedback-essay').innerText(), item.essay);
        assert.ok(calls.length >= 2 && calls.every(call => call.attemptToken === item.token),
          'Trang không đọc lại đúng lượt từ API thử');
        assert.deepEqual(blocked, [], 'Trang gọi ra ngoài fixture');
        assert.deepEqual(errors, [], 'Trang có lỗi JavaScript');
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
  }
}

async function createIsolatedDatabase() {
  // Dữ liệu vào: migration K56 đã ghim và bốn lớp/học viên hoàn toàn giả.
  // Việc chính: dựng đúng schema K56 trong PostgreSQL nhúng, không kết nối production.
  // Kết quả: bốn lượt đã xong Reading nhưng chưa nộp Writing; schema K67 làm mốc không đổi.
  // Khi lỗi: test thất bại và kho nhúng bị đóng, không có dữ liệu bên ngoài để hoàn tác.
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      erp_student_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE mapping.student_mapping_review (
      public_id UUID,
      erp_course_class_id BIGINT,
      erp_student_contact_id BIGINT,
      status TEXT
    );
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.test_definition (slug TEXT PRIMARY KEY);
    INSERT INTO assessment.test_definition VALUES ('k67-unchanged');
  `);
  for (const migrationName of [
    '202609240003_k56_assessment_schema.sql',
    '202609240005_k56_class_access.sql'
  ]) {
    const migration = await readFile(
      new URL(`../ops/migrations/${migrationName}`, import.meta.url), 'utf8');
    await database.exec(migration);
  }
  for (const item of cases) {
    await database.query(`INSERT INTO mapping.classroom_course_mapping
      (erp_course_class_id, erp_class_name_snapshot) VALUES ($1, $2)`,
    [item.classId, item.className]);
    await database.query(`INSERT INTO assessment_k56.test_definition
      (slug, title, version, listening_definition, reading_definition, is_active)
      VALUES ($1, $2, 1, '{}'::jsonb, '{}'::jsonb, true)
      ON CONFLICT (slug) DO NOTHING`,
    [item.slug, item.slug]);
    await database.query(`INSERT INTO assessment_k56.term_test_class_access
      (test_slug, erp_course_class_id, enabled, source)
      VALUES ($1, $2, true, 'release_test_fixture')`,
    [item.slug, item.classId]);
    const combined = {
      listening: { correct: item.listeningCorrect, total: 40, band: 5.5 },
      reading: { correct: item.readingCorrect, total: item.readingTotal, band: 5.5 }
    };
    await database.query(`INSERT INTO assessment_k56.term_test_attempt (
      id, client_submission_id, test_slug, definition_version,
      erp_course_class_id, class_name_snapshot, erp_student_contact_id,
      student_name_snapshot, listening_answers, listening_result,
      listening_submitted_at, reading_answers, reading_result,
      reading_submitted_at, completed_at, combined_result
    ) VALUES ($1::uuid, gen_random_uuid(), $2, 1, $3, $4, $5,
      'Học viên giả', '{}'::jsonb, $6::jsonb, now(),
      '{}'::jsonb, $7::jsonb, now(), now(), $8::jsonb)`,
    [
      item.token, item.slug, item.classId, item.className, item.studentId,
      JSON.stringify(combined.listening),
      JSON.stringify(combined.reading),
      JSON.stringify(combined)
    ]);
    if (item.lateEssay) {
      // Dữ liệu vào: một bản nháp giả đã lưu và hạn Writing đã qua.
      // Việc chính: dựng trạng thái trước cú bấm nộp muộn để khóa phần sửa muộn.
      // Kết quả: API phải dùng bản nháp này để chấm; sai khác sẽ làm test đỏ.
      // Khi lỗi: chỉ kho PostgreSQL nhúng bị ảnh hưởng và được đóng sau test.
      await database.query(`UPDATE assessment_k56.term_test_attempt
        SET writing_task_1 = $2, writing_draft_revision = 1,
            listening_submitted_at = now() - interval '63 minutes',
            reading_submitted_at = now() - interval '62 minutes',
            completed_at = now() - interval '62 minutes',
            writing_started_at = now() - interval '61 minutes',
            writing_deadline_at = now() - interval '1 minute',
            writing_updated_at = now() - interval '2 minutes'
        WHERE id = $1::uuid`, [item.token, item.essay]);
    }
  }
  return database;
}

test('Term 1/2 K56: HTTP nộp → chấm → Portal thành công/mất phản hồi → mở lại và khóa sửa muộn', async () => {
  const database = await createIsolatedDatabase();
  try {
    // PGlite không có rowCount như driver PostgreSQL production; chỉ chuẩn hóa ở biên test.
    const pgCompatiblePool = {
      async query(...args) {
        const result = await database.query(...args);
        return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
      }
    };
    const pool = createAssessmentSchemaPool(
      pgCompatiblePool, resolveDeploymentProfile('k56-ic2264'));
    const portalWrites = [];
    const portalRows = new Map([['unrelated-k67', { writing: 8 }]]);
    const config = {
      nodeEnv: 'test',
      port: 8788,
      databaseUrl: 'postgresql://unused-in-test',
      dbPoolMax: 2,
      authMode: 'legacy',
      googleClientId: '',
      legacyReviewToken: '',
      allowedOrigins: new Set([ORIGIN]),
      trustProxyHops: 0,
      deploymentProfileName: 'k56-ic2264',
      writingTestSyncSecret: WORKER_SECRET,
      k56PortalPilotEnabled: true,
      demoIsolatedMode: false,
      erpSyncUrl: 'https://portal.invalid/fixture',
      erpSyncSecret: PORTAL_SECRET,
      erpSyncTimeoutMs: 2_000
    };
    const syncErpGrades = createErpGradeSync({
      config,
      pool,
      logger: { info() {}, error() {} },
      fetchImpl: async (url, options) => {
        // Dữ liệu vào: gói điểm mà backend định gửi writer thật.
        // Việc chính: xác nhận URL/khóa thử, định danh và ba điểm, rồi lưu vào Portal giả.
        // Kết quả: response đúng hợp đồng; các lượt ghi được đếm và đọc lại.
        // Khi lỗi: assert làm test đỏ, không có HTTP hoặc điểm production.
        assert.equal(url, config.erpSyncUrl);
        assert.equal(options.headers['x-term-test-sync'], PORTAL_SECRET);
        const payload = JSON.parse(options.body);
        portalWrites.push(payload);
        portalRows.set(`${payload.classId}:${payload.studentId}:${payload.testSlug}`, payload.grades);
        if (payload.attemptToken === cases[2].token) {
          // Portal giả đã ghi điểm nhưng phản hồi bị mất: backend phải giữ trạng thái chưa rõ.
          const error = new Error('fixture timeout after write');
          error.name = 'TimeoutError';
          throw error;
        }
        return Response.json({
          ok: true,
          status: 'synced',
          attemptToken: payload.attemptToken
        });
      }
    });
    const gradingService = createTermTestWritingGradingService({ pool, syncErpGrades });
    const termTestAssetService = {
      getTiming: () => ({ writingDurationMinutes: 60 }),
      getContent: async slug => ({
        writing: {
          tasks: [{
            id: slug === 'term-test-1-k56' ? 'task2' : 'task1',
            prompt: `Đề giả cho ${slug}`
          }]
        }
      })
    };
    const app = createApp({
      config,
      pool,
      syncErpGrades,
      termTestWritingGradingService: gradingService,
      termTestAssetService,
      logger: { info() {}, error() {} }
    });

    for (const item of cases) {
      const seeded = await pool.query(`SELECT id::text AS token, completed_at IS NOT NULL AS completed
        FROM assessment.term_test_attempt WHERE id = $1::uuid`, [item.token]);
      assert.deepEqual(seeded.rows.map(row => ({ token: row.token, completed: row.completed })),
        [{ token: item.token, completed: true }]);
      const submitted = await request(app)
        .post('/api/term-tests/writing')
        .set('Origin', ORIGIN)
        .send({
          attemptToken: item.token,
          revision: item.lateEssay ? 2 : 1,
          action: 'submit',
          task1: item.taskNumber === 1 ? (item.lateEssay || item.essay) : '',
          task2: item.taskNumber === 2 ? item.essay : ''
        });
      assert.equal(submitted.status, 200, submitted.body.error);
      assert.equal(submitted.body.writing.submitted, true);
      assert.equal(submitted.body.writing.grading.ready, false);
      if (item.lateEssay) {
        assert.equal(submitted.body.writing.task1, item.essay);
        assert.equal(submitted.body.writing.timedOut, true);
      }

      const claim = await request(app)
        .post('/api/term-tests/writing-grading/jobs/claim')
        .set('x-writing-test-sync', WORKER_SECRET)
        .send({ workerId: 'release-fixture-dispatch', limit: 4, testSlug: item.slug });
      assert.equal(claim.status, 200, claim.body.error);
      assert.equal(claim.body.jobs.length, 1);
      const dispatch = claim.body.jobs[0];
      assert.equal(dispatch.source, 'k56_web');
      assert.equal(dispatch.testSlug, item.slug);
      assert.equal(dispatch.classId, String(item.classId));
      assert.equal(dispatch.attemptId, item.token);
      assert.equal(dispatch.taskNumber, item.taskNumber);
      assert.equal(dispatch.essay, item.essay);

      const dispatched = await request(app)
        .post('/api/term-tests/writing-grading/jobs/dispatch-complete')
        .set('x-writing-test-sync', WORKER_SECRET)
        .send({
          jobId: dispatch.jobId,
          workerId: 'release-fixture-dispatch',
          sourceRecordId: `fixture-${item.taskNumber}`
        });
      assert.equal(dispatched.status, 200, dispatched.body.error);
      await pool.query(`UPDATE assessment.term_test_writing_grading_job
        SET next_attempt_at = now() WHERE job_type = 'collect'`);

      const collectResponse = await request(app)
        .post('/api/term-tests/writing-grading/jobs/claim')
        .set('x-writing-test-sync', WORKER_SECRET)
        .send({ workerId: 'release-fixture-collect', limit: 4, testSlug: item.slug });
      assert.equal(collectResponse.status, 200, collectResponse.body.error);
      assert.equal(collectResponse.body.jobs.length, 1);
      const collect = collectResponse.body.jobs[0];
      assert.equal(collect.runKey, dispatch.runKey);
      assert.equal(collect.attemptId, item.token);

      const report = `Báo cáo giả ${item.slug}: “đúng lớp” — e\u0301 và 🧪.`;
      const callback = {
        jobId: collect.jobId,
        workerId: 'release-fixture-collect',
        runKey: collect.runKey,
        sourceRecordId: `fixture-${item.taskNumber}`,
        result: {
          taskScore: 6.5,
          criteria: criteria(item.taskNumber),
          report
        }
      };
      const completed = await request(app)
        .post('/api/term-tests/writing-grading/jobs/result')
        .set('x-writing-test-sync', WORKER_SECRET)
        .send(callback);
      assert.equal(completed.status, 200, completed.body.error);
      const expectedPortalStatus = item.simulatePortalTimeout ? 'unknown' : 'synced';
      assert.equal(completed.body.portalSyncStatus, expectedPortalStatus);
      assert.equal(completed.body.grading.ready, true);
      assert.equal(completed.body.grading.writingScore, 6.5);
      assert.equal(completed.body.grading.tasks[0].report, report);
      assert.deepEqual(completed.body.grading.tasks[0].criteria.map(row => row.feedback),
        criteria(item.taskNumber).map(row => row.feedback));
      const repeatedCallback = await request(app)
        .post('/api/term-tests/writing-grading/jobs/result')
        .set('x-writing-test-sync', WORKER_SECRET)
        .send(callback);
      assert.equal(repeatedCallback.status, 200, repeatedCallback.body.error);
      assert.equal(repeatedCallback.body.status, 'duplicate');
      assert.equal(portalWrites.length, cases.indexOf(item) + 1);

      const expectedGrades = {
        listening: item.listeningCorrect,
        reading: item.readingCorrect,
        writing: 6.5
      };
      const key = `${item.classId}:${item.studentId}:${item.slug}`;
      assert.deepEqual(portalRows.get(key), expectedGrades);
      assert.equal(portalWrites.length, cases.indexOf(item) + 1);
      assert.deepEqual(portalWrites.at(-1).grades, expectedGrades);
      assert.equal(portalWrites.at(-1).attemptToken, item.token);

      for (let index = 0; index < 2; index += 1) {
        const reopened = await request(app)
          .post('/api/term-tests/result')
          .set('Origin', ORIGIN)
          .send({ attemptToken: item.token });
        assert.equal(reopened.status, 200, reopened.body.error);
        assert.equal(reopened.body.testSlug, item.slug);
        assert.equal(reopened.body.className, item.className);
        assert.equal(reopened.body.writing.submitted, true);
        assert.equal(reopened.body.writing.grading.ready, true);
        assert.equal(reopened.body.writing.grading.writingScore, 6.5);
        assert.equal(reopened.body.writing.grading.tasks[0].report, report);
        assert.deepEqual(reopened.body.writing.grading.tasks[0].criteria.map(row => row.feedback),
          criteria(item.taskNumber).map(row => row.feedback));
        assert.equal(
          item.taskNumber === 1 ? reopened.body.writing.task1 : reopened.body.writing.task2,
          item.essay
        );
        assert.equal(reopened.body.portalSyncStatus, expectedPortalStatus);
      }
      assert.equal(portalWrites.length, cases.indexOf(item) + 1);
      if (item.simulatePortalTimeout) {
        const syncState = await database.query(`SELECT status, error_code
          FROM assessment_k56.term_test_portal_sync_state
          WHERE attempt_id = $1::uuid`, [item.token]);
        assert.deepEqual(syncState.rows, [{
          status: 'unknown',
          error_code: 'ERP_SYNC_TIMEOUT'
        }]);
      }
    }
    assert.deepEqual(portalRows.get('unrelated-k67'), { writing: 8 });
    assert.deepEqual(
      (await database.query('SELECT slug FROM assessment.test_definition')).rows,
      [{ slug: 'k67-unchanged' }]
    );
    const states = await database.query(`SELECT attempt.test_slug, count(*)::int AS total
      FROM assessment_k56.term_test_writing_grading_job AS job
      JOIN assessment_k56.term_test_writing_grading_run AS run ON run.id = job.run_id
      JOIN assessment_k56.term_test_attempt AS attempt ON attempt.id = run.attempt_id
      WHERE job.status = 'complete'
      GROUP BY attempt.test_slug ORDER BY attempt.test_slug`);
    assert.deepEqual(states.rows.map(row => row.total), [4, 4]);
    await verifyPagesAgainstBackend(app);
    assert.equal(portalWrites.length, cases.length, 'Mở trang kết quả không được gửi điểm Portal thêm');
  } finally {
    await database.close();
  }
});
