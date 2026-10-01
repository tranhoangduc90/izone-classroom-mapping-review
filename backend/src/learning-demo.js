import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, parse as parsePath } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { withTransaction } from './db.js';
import { parseFormDefinition, parseFormGradingKey } from './learning-contracts.js';
import { sha256, stableStringify } from './learning-domain.js';
import { createLearningRouter } from './learning-routes.js';
import { verifyLearningDemoGrant } from './learning-demo-grant.js';
import {
  insertLearningAssignmentBlockReleaseSql,
  insertLearningAssignmentRosterSql,
  insertLearningAssignmentSql,
  insertLearningFormGradingKeySql,
} from './learning-sql.js';

const uuid = z.string().uuid();
const teacherTokenPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const demoMigrations = [
  '202608290001_learning_platform_v1.sql',
  '202609150001_learning_platform_v2.sql',
  '202609150003_student_course_journey.sql',
  '202609160001_course_content_authority.sql',
  '202609160003_portal_attendance_outbox.sql',
  '202609160006_portal_attendance_dashboard_index.sql',
  '202609240001_teacher_session_speaking_feedback.sql',
  '202609280001_assignment_answer_release.sql',
  '202609280001_progress_log_admin_scope.sql',
  '202609290001_teacher_confirmed_journey_plan.sql'
];

function sqlResult(result) {
  return { ...result, rowCount: result.rowCount ?? result.rows?.length ?? 0 };
}

// PGlite có một kết nối: giữ khóa suốt transaction để hai tab không trộn câu lệnh.
export function createPGlitePool(database) {
  let tail = Promise.resolve();
  async function lock() {
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; });
    const previous = tail;
    tail = tail.then(() => next);
    await previous;
    return unlock;
  }
  return {
    async query(sql, params) {
      const unlock = await lock();
      try { return sqlResult(await database.query(sql, params)); }
      finally { unlock(); }
    },
    async connect() {
      const unlock = await lock();
      return {
        query: async (sql, params) => sqlResult(await database.query(sql, params)),
        release: unlock
      };
    }
  };
}

export async function openLearningDemoDatabase(dataDir) {
  if (!dataDir || !isAbsolute(dataDir) || parsePath(dataDir).root === dataDir || dataDir.length < 12) {
    throw new Error('DEMO_DATA_DIR phải là thư mục tuyệt đối riêng cho kho demo.');
  }
  const database = new PGlite(dataDir);
  await initializeLearningDemoDatabase(database);
  return database;
}

export async function initializeLearningDemoDatabase(database) {
  const marker = await database.query(`SELECT to_regclass('learning_demo.environment_marker') AS marker,
    to_regclass('learning.form_template') AS learning_table`);
  if (marker.rows[0].marker) {
    const checked = await database.query(`SELECT kind FROM learning_demo.environment_marker WHERE id = true`);
    if (checked.rows[0]?.kind !== 'progress_log_demo_only' || !marker.rows[0].learning_table) {
      throw new Error('Kho dữ liệu thiếu marker demo hợp lệ.');
    }
    // Kho thử đã có từ trước cần nhận bảng Journey mới mà vẫn giữ nguyên các lượt thử.
    const plan = await database.query("SELECT to_regclass('learning.class_journey_plan') AS table_name");
    if (!plan.rows[0]?.table_name) {
      const migration = await readFile(new URL('../ops/learning-migrations/202609290001_teacher_confirmed_journey_plan.sql', import.meta.url), 'utf8');
      await database.exec(migration);
    }
    return;
  }
  if (marker.rows[0].learning_table) throw new Error('Từ chối biến kho dữ liệu khác thành kho demo.');
  const mappingSql = await readFile(new URL('../ops/learning-demo/mapping-fixture.sql', import.meta.url), 'utf8');
  await database.exec(mappingSql);
  for (const filename of demoMigrations) {
    const migration = await readFile(new URL(`../ops/learning-migrations/${filename}`, import.meta.url), 'utf8');
    await database.exec(migration);
  }
  const runSql = await readFile(new URL('../ops/learning-demo/demo-run.sql', import.meta.url), 'utf8');
  await database.exec(runSql);
}

export function createDemoSourceFetcher({ url, secret, fetchImpl = fetch }) {
  if (!/^https:\/\/[^/]+\/mapping-api\/api\/learning\/assignments\/demo-source$/.test(url)
    || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Thiếu cổng đọc phiếu thật hoặc khóa dịch vụ demo hợp lệ.');
  }
  return async sourceToken => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-learning-demo-source': secret },
      body: JSON.stringify(typeof sourceToken==='object'?sourceToken:{ publicToken: sourceToken }),
      signal: AbortSignal.timeout(7_000)
    });
    if (!response.ok) throw new Error('Không đọc được phiên bản phiếu đã phát hành.');
    const payload = await response.json();
    if (payload?.ok !== true || !payload.source) throw new Error('Nguồn phiếu trả về không hợp lệ.');
    return payload.source;
  };
}

function checkedSource(source) {
  const definition = parseFormDefinition(source.definition);
  const gradingKey = parseFormGradingKey(source.gradingKey);
  if (source.definitionHash !== sha256(stableStringify(definition))
    || gradingKey.formVersionId !== definition.formVersionId
    || source.title !== definition.title
    || !Number.isInteger(source.sessionNumber) || source.sessionNumber < 1 || source.sessionNumber > 100
    || typeof source.className !== 'string' || !source.className.trim()) {
    throw new Error('Phiên bản phiếu nguồn không khớp; đã dừng tạo bản thử.');
  }
  return { definition, gradingKey };
}

export function createLearningDemoApp({ pool, fetchSource, allowedOrigin, grantSecret }) {
  if (!pool || !fetchSource || !allowedOrigin || !grantSecret || grantSecret.length < 32) {
    throw new Error('Thiếu cấu hình dịch vụ demo.');
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin === allowedOrigin) {
      res.set('Access-Control-Allow-Origin', allowedOrigin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'content-type,x-progress-log-demo,x-demo-teacher-token,x-izone-csrf');
    }
    if (req.method === 'OPTIONS') return res.status(origin === allowedOrigin ? 204 : 403).end();
    if (req.method === 'GET' && req.path === '/health') return next();
    if (req.get('x-progress-log-demo') !== '1' || (origin && origin !== allowedOrigin)) {
      return res.status(403).json({ ok: false, error: 'DEMO_ONLY' });
    }
    return next();
  });
  const createLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false });

  async function createRun(sourceToken, sourceOverride = null, resetCurrent = null) {
    const rawSource = sourceOverride || await fetchSource(sourceToken);
    const { definition: sourceDefinition, gradingKey: sourceKey } = checkedSource(rawSource);
    const source = {
      sourceAssignmentId: rawSource.sourceAssignmentId,
      title: rawSource.title, className: rawSource.className,
      courseCode: rawSource.courseCode || null, sessionNumber: rawSource.sessionNumber,
      definitionHash: rawSource.definitionHash,
      answerReleaseOverride: rawSource.answerReleaseOverride || null,
      blockReleases: rawSource.blockReleases || [],
      definition: sourceDefinition, gradingKey: sourceKey
    };
    const runId = crypto.randomUUID();
    const teacherToken = crypto.randomUUID();
    const formVersionId = crypto.randomUUID();
    const teacherEmail = `demo-${runId}@example.invalid`;
    const definition = { ...sourceDefinition, formVersionId };
    const gradingKey = { ...sourceKey, formVersionId };
    const definitionHash = sha256(stableStringify(definition));
    const gradingHash = sha256(stableStringify(gradingKey));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return withTransaction(pool, async client => {
      const idRow = await client.query(`SELECT nextval('learning_demo.fake_class_id')::text AS class_id`);
      const classId = idRow.rows[0].class_id;
      await client.query(`INSERT INTO mapping.classroom_course_mapping
        (erp_course_class_id, erp_class_name_snapshot) VALUES ($1::bigint, $2)`,
      [classId, `${source.className.trim()} · bản thử`]);
      await client.query(`INSERT INTO mapping.reviewer_class_access
        (reviewer_email, erp_course_class_id) VALUES ($1, $2::bigint)`, [teacherEmail, classId]);
      const template = await client.query(`INSERT INTO learning.form_template
        (title, kind, created_by_email) VALUES ($1, $2, $3) RETURNING id::text`,
      [definition.title, definition.kind, teacherEmail]);
      // Bản nguồn đã phát hành; actor nhập demo khác với actor duyệt nguồn.
      await client.query(`INSERT INTO learning.form_version
        (id, template_id, version, schema_version, public_definition, definition_hash,
         status, created_by_email, approved_by_email, published_at)
        VALUES ($1::uuid, $2::uuid, 1, 'FormDefinitionV1', $3::jsonb, $4,
          'published', $5, 'source-approved@demo.invalid', now())`,
      [formVersionId, template.rows[0].id, JSON.stringify(definition), definitionHash, teacherEmail]);
      await client.query(insertLearningFormGradingKeySql, [formVersionId,
        JSON.stringify(gradingKey), gradingHash]);
      const assignment = await client.query(insertLearningAssignmentSql, [formVersionId,
        source.courseCode || null, classId, `${source.className.trim()} · bản thử`,
        source.sessionNumber, definition.title, null, expiresAt, teacherEmail]);
      const { assignment_id: assignmentId, public_token: publicToken } = assignment.rows[0];
      if (source.answerReleaseOverride) await client.query(`UPDATE learning.form_assignment
        SET answer_release_override = $2 WHERE id = $1::uuid`, [assignmentId, source.answerReleaseOverride]);
      for (let index = 1; index <= 3; index += 1) {
        await client.query(insertLearningAssignmentRosterSql, [assignmentId, crypto.randomUUID(),
          String(BigInt(classId) * 10n + BigInt(index)), `Học viên mẫu ${index}`, '']);
      }
      for (const block of definition.blocks) {
        const original = source.blockReleases.find(release => release.blockId === block.blockId);
        const status = ['locked', 'open', 'closed'].includes(original?.status) ? original.status : 'open';
        await client.query(insertLearningAssignmentBlockReleaseSql, [assignmentId,
          block.blockId, block.checkpoint, status, teacherEmail]);
      }
      await client.query(`INSERT INTO learning_demo.run
        (id, source_token, source_payload, assignment_id, teacher_token_hash, teacher_email, class_id, expires_at)
        VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::uuid, $5, $6, $7::bigint, $8::timestamptz)`,
      [runId, sourceToken, sourceOverride ? JSON.stringify(source) : null,
        assignmentId, sha256(teacherToken), teacherEmail, classId, expiresAt]);
      if (resetCurrent) {
        const closed = await client.query(`UPDATE learning_demo.run SET reset_at = now()
          WHERE id = $1::uuid AND reset_at IS NULL RETURNING id`, [resetCurrent.id]);
        if (closed.rows.length !== 1) throw new Error('Lượt thử đã được đặt lại từ một tab khác.');
        await client.query(`UPDATE learning.form_assignment SET status = 'closed', closes_at = now()
          WHERE id = $1::uuid`, [resetCurrent.assignment_id]);
      }
      return { runId, assignmentId, publicToken, teacherToken, expiresAt };
    });
  }

  async function authenticate(req, res, next) {
    const token = String(req.get('x-demo-teacher-token') || '');
    if (!teacherTokenPattern.test(token)) return res.status(401).json({ ok: false, error: 'DEMO_TEACHER_TOKEN_REQUIRED' });
    const run = await pool.query(`SELECT teacher_email, class_id FROM learning_demo.run
      WHERE teacher_token_hash = $1 AND reset_at IS NULL AND expires_at > now()`, [sha256(token)]);
    if (run.rowCount !== 1) return res.status(401).json({ ok: false, error: 'DEMO_RUN_EXPIRED' });
    req.reviewer = { email: run.rows[0].teacher_email, displayName: 'Giảng viên thử',
      role: 'teacher', canAccessAllClasses: false };
    return next();
  }

  app.get('/health', async (_req, res) => {
    const result = await pool.query(`SELECT kind FROM learning_demo.environment_marker WHERE id = true`);
    return res.json({ ok: result.rows[0]?.kind === 'progress_log_demo_only', mode: 'demo' });
  });
  app.post('/api/demo/runs', createLimiter, async (req, res, next) => {
    const runToken = uuid.safeParse(req.body?.runToken);
    const grant = verifyLearningDemoGrant(req.body?.grant, grantSecret);
    if (!runToken.success && !grant) return res.status(403).json({ ok: false, error: 'DEMO_GRANT_REQUIRED',
      message: 'Link xem thử đã hết hạn. Hãy mở lại từ dashboard giảng viên.' });
    try {
      if (runToken.success) {
        const existing = await pool.query(`SELECT assignment.public_token::text AS public_token,
          run.reset_at, run.expires_at
        FROM learning_demo.run AS run
        JOIN learning.form_assignment AS assignment ON assignment.id = run.assignment_id
        WHERE assignment.public_token = $1::uuid`,
        [runToken.data]);
        if (existing.rowCount !== 1) return res.status(404).json({ ok: false, error: 'DEMO_RUN_NOT_FOUND' });
        if (existing.rows[0].reset_at || new Date(existing.rows[0].expires_at) <= new Date()) {
          return res.status(410).json({ ok: false, error: 'DEMO_RUN_EXPIRED',
            message: 'Lượt thử đã được đặt lại hoặc hết hạn. Hãy mở lại dashboard giảng viên.' });
        }
        return res.json({ ok: true, existing: true,
          run: { publicToken: existing.rows[0].public_token } });
      }
      const source = await fetchSource(grant.kind==='draft'?{grant:req.body.grant}:grant.publicToken);
      const mismatch=grant.kind==='draft'
        ?source.sourceDraftId!==grant.draftId||source.sourceRevision!==grant.revision||source.contentHash!==grant.contentHash
        :source.sourceAssignmentId!==grant.assignmentId||source.definitionHash!==grant.definitionHash;
      if (mismatch) {
        return res.status(409).json({ ok: false, error: 'SOURCE_CHANGED',
          message: 'Phiếu nguồn đã thay đổi. Hãy mở lại dashboard giảng viên.' });
      }
      return res.status(201).json({ ok: true, existing: false,
        run: await createRun(grant.kind==='draft'?grant.draftId:grant.publicToken, source) });
    }
    catch (error) { return next(error); }
  });
  app.post('/api/demo/runs/reset', createLimiter, authenticate, async (req, res, next) => {
    try {
      const current = await pool.query(`SELECT id::text, source_token::text, source_payload, assignment_id::text
        FROM learning_demo.run WHERE teacher_email = $1 AND reset_at IS NULL`, [req.reviewer.email]);
      if (current.rowCount !== 1) return res.status(404).json({ ok: false, error: 'RUN_NOT_FOUND' });
      const run = await createRun(current.rows[0].source_token, current.rows[0].source_payload, current.rows[0]);
      return res.status(201).json({ ok: true, run });
    } catch (error) { return next(error); }
  });
  app.post('/api/demo/runs/open-blocks', createLimiter, authenticate, async (req, res, next) => {
    try {
      const result = await pool.query(`UPDATE learning.assignment_block_release AS release
        SET status = 'open', release_version = release.release_version + 1,
          released_at = now(), updated_by_email = $1
        FROM learning_demo.run AS run WHERE run.teacher_email = $1
          AND run.assignment_id = release.assignment_id AND run.reset_at IS NULL
          AND run.expires_at > now() RETURNING release.block_id`, [req.reviewer.email]);
      return res.json({ ok: true, opened: result.rowCount });
    } catch (error) { return next(error); }
  });
  app.post('/api/learning/student/course-journey', async (req, res, next) => {
    const accessToken = String(req.body?.accessToken || '');
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(accessToken)) return next();
    try {
      const active = await pool.query(`SELECT 1 FROM learning.student_progress_access AS access
        JOIN learning_demo.run AS run ON run.class_id = access.erp_course_class_id
        WHERE access.token_hash = $1 AND run.reset_at IS NULL AND run.expires_at > now()`,
      [sha256(accessToken)]);
      if (active.rowCount !== 1) return res.status(404).json({ ok: false, error: 'DEMO_RUN_EXPIRED',
        message: 'Lượt thử đã được đặt lại hoặc hết hạn.' });
      return next();
    } catch (error) { return next(error); }
  });
  app.post('/api/learning/teacher/student-progress-links', (req, _res, next) => {
    req.body.expiresInDays = 1;
    next();
  });
  app.use('/api/learning', createLearningRouter({ pool, authenticate }));
  app.use((error, _req, res, _next) => {
    console.error(`Demo API lỗi: ${String(error?.code || 'INTERNAL_ERROR')}`);
    return res.status(500).json({ ok: false, error: 'DEMO_ERROR', message: 'Bản thử chưa xử lý được yêu cầu.' });
  });
  return app;
}
