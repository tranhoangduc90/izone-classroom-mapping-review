import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const runtime = process.env.TERM2_RUNTIME_ROOT;
assert.ok(runtime && process.env.TERM2_DEPS_PACKAGE);
const require = createRequire(process.env.TERM2_DEPS_PACKAGE);
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const { registerK56ExamOrder } = await import(pathToFileURL(runtime + '/src/k56-exam-order.js'));
const { findStudentForTermTestSql } = await import(pathToFileURL(runtime + '/src/sql.js'));
const { mountSubmissionStatus } = await import(pathToFileURL(runtime + '/src/submission-status.mjs'));
const migration = await readFile(new URL('./term-online-submission-hold.sql', import.meta.url), 'utf8');

export async function fixture(t, term, mode, { mountJournal, enabled = true, writing = false } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE SCHEMA assessment;
    CREATE ROLE k56_shared_api NOLOGIN;
    CREATE TABLE assessment.term_test_attempt (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), exam_session_id uuid NOT NULL, test_slug text NOT NULL,
      client_submission_id uuid DEFAULT gen_random_uuid(), definition_version int NOT NULL, generation bigint NOT NULL DEFAULT 0,
      attempt_mode text NOT NULL DEFAULT 'cbt', exam_mode text NOT NULL, erp_course_class_id bigint NOT NULL,
      erp_student_contact_id bigint NOT NULL, class_name_snapshot text NOT NULL, student_name_snapshot text NOT NULL,
      mini_definition_snapshot jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      superseded_at timestamptz, listening_submitted_at timestamptz, reading_submitted_at timestamptz,
      listening_interrupted_at timestamptz, reading_started_at timestamptz, reading_deadline_at timestamptz,
      reading_draft jsonb DEFAULT '{}', reading_draft_revision bigint NOT NULL DEFAULT 0, reading_draft_updated_at timestamptz,
      listening_answers jsonb, listening_result jsonb, reading_answers jsonb, reading_result jsonb,
      combined_result jsonb, completed_at timestamptz, writing_started_at timestamptz, writing_deadline_at timestamptz,
      writing_submitted_at timestamptz
    );
    CREATE TABLE assessment.term_test_exam_session (
      id uuid PRIMARY KEY, attempt_id uuid, test_slug text NOT NULL, attempt_mode text NOT NULL DEFAULT 'cbt',
      generation bigint NOT NULL DEFAULT 0, prepared_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      superseded_at timestamptz, listening_started_at timestamptz, listening_deadline_at timestamptz,
      listening_draft jsonb DEFAULT '{}', listening_draft_revision bigint NOT NULL DEFAULT 0,
      listening_audio_checkpoint_seconds int, listening_submitted_at timestamptz
    );
    CREATE TABLE assessment.test_definition (
      slug text, version int, title text, listening_definition jsonb, reading_definition jsonb, listening_band_adjustment numeric
    );
    CREATE TABLE assessment.term_test_roster (
      test_slug text, erp_course_class_id bigint, erp_student_contact_id bigint, student_ref uuid, class_code text
    );
    CREATE TABLE assessment.term_test_temporary_student (
      test_slug text, erp_course_class_id bigint, temporary_student_id bigint, student_ref uuid
    );
    CREATE TABLE assessment.term1_offline_run (attempt_id uuid, generation bigint, state jsonb);
    CREATE TABLE assessment.term2_offline_run (attempt_id uuid, generation bigint, state jsonb);
    CREATE TABLE assessment.term1_skill_grant (
      id uuid DEFAULT gen_random_uuid(), attempt_id uuid, session_id uuid, generation bigint, class_id bigint,
      section text, owner_id uuid, revoked_at timestamptz
    );
    CREATE TABLE assessment.k56_portal_field_dispatch (
      attempt_id uuid, field text, grade numeric, status text, PRIMARY KEY(attempt_id,field)
    );`);
  await db.exec(migration);
  if (writing) {
    await db.exec(`ALTER TABLE assessment.term_test_attempt
      ADD COLUMN writing_outline text NOT NULL DEFAULT '',
      ADD COLUMN writing_task_1 text NOT NULL DEFAULT '',
      ADD COLUMN writing_task_2 text NOT NULL DEFAULT '',
      ADD COLUMN writing_draft_revision bigint NOT NULL DEFAULT 0,
      ADD COLUMN writing_updated_at timestamptz;
    ALTER TABLE assessment.term1_offline_run ADD COLUMN policy text, ADD COLUMN session_id uuid;
    ALTER TABLE assessment.term2_offline_run ADD COLUMN policy text, ADD COLUMN session_id uuid;
    CREATE TABLE assessment.term1_offline_operation (
      attempt_id uuid, operation_id uuid, section text, kind text, receipt jsonb
    );
    CREATE TABLE assessment.term2_offline_operation (LIKE assessment.term1_offline_operation);
    CREATE TABLE assessment.term_test_writing_grading_run (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid, task_number int, grading_version int, run_key text,
      prompt_text text, prompt_image_url text, essay_text text, word_count int, status text, task_score numeric,
      result_json jsonb, completed_at timestamptz, UNIQUE (attempt_id, task_number, grading_version)
    );
    CREATE TABLE assessment.term_test_writing_grading_final (
      attempt_id uuid PRIMARY KEY, grading_version int, task_1_run_id uuid, task_2_run_id uuid,
      task_1_score numeric, task_2_score numeric, writing_score numeric, status text, ready_at timestamptz
    );
    CREATE TABLE assessment.term_test_writing_grading_job (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, job_type text, idempotency_key text UNIQUE,
      status text, max_attempts int, next_attempt_at timestamptz
    );`);
    await db.exec(await readFile(new URL('./term-online-writing.sql', import.meta.url), 'utf8'));
  }
  const slug = 'term-test-' + term + '-k56';
  const scope = { attemptToken: randomUUID(), examSessionToken: randomUUID(), studentRef: randomUUID(),
    classCode: 'FIXTURE56', generation: 0 };
  const questions = total => ({ questions: Array.from({ length: total }, (_, i) => ({ number: i + 1,
    type: 'completion', accepted: ['A'] })) });
  const snapshot = { version: 1, title: 'Synthetic Term', listening: questions(40), reading: questions(term === 1 ? 26 : 40),
    listeningBandAdjustment: 0, ...(writing ? { timing: { writingDurationMinutes: 45 } } : {}) };
  if (term === 1) snapshot.listening.questions[31] = {
    number: 32, type: 'completion', compound: { keys: ['32a', '32b'], accepted: { '32a': ['A'], '32b': ['B'] } }
  };
  await db.query(`INSERT INTO assessment.term_test_attempt
    (id,exam_session_id,test_slug,definition_version,exam_mode,erp_course_class_id,erp_student_contact_id,
     class_name_snapshot,student_name_snapshot,mini_definition_snapshot,reading_started_at,reading_deadline_at)
    VALUES($1,$2,$3,1,$4,5601,5602,$5,'Fixture learner',$6::jsonb,now(),now()+interval '1 hour')`,
  [scope.attemptToken, scope.examSessionToken, slug, mode, scope.classCode, JSON.stringify(snapshot)]);
  await db.query(`INSERT INTO assessment.term_test_exam_session
    (id,attempt_id,test_slug,listening_started_at,listening_deadline_at)
    VALUES($1,$2,$3,now(),now()+interval '1 hour')`, [scope.examSessionToken, scope.attemptToken, slug]);
  await db.query('INSERT INTO assessment.term_test_roster VALUES($1,5601,5602,$2,$3)', [slug, scope.studentRef, scope.classCode]);

  const fault = { receipt: false, drop: null, logger: false, grade: false };
  const portal = [];
  const observations = [];
  const query = async (sql, params) => {
    if (sql === findStudentForTermTestSql) {
      return query(`SELECT erp_course_class_id::text AS class_id, erp_student_contact_id::text AS student_id,
        1 AS definition_version FROM assessment.term_test_roster
        WHERE class_code=$1 AND test_slug=$2 AND student_ref=$3`, params);
    }
    if (fault.receipt && sql.startsWith('UPDATE assessment.term_online_submission_hold SET receipt='))
      throw Error('Synthetic failure before receipt commit');
    if (fault.grade && sql.includes('INSERT INTO assessment.term_test_writing_grading_job'))
      throw Error('Synthetic failure before job commit');
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  let writingOptions = {};
  const content = {};
  if (writing) {
    const { createTermTestWritingGradingService } = await import(pathToFileURL(runtime + '/src/term-test-writing-grading.js'));
    const service = createTermTestWritingGradingService({ pool });
    const serialize = (row, grading) => ({ task1: row.writing_task_1, task2: row.writing_task_2, outline: row.writing_outline,
      revision: Number(row.writing_draft_revision), submitted: Boolean(row.writing_submitted_at), grading });
    writingOptions = {
      assets: { getContent: async () => content, getTiming: () => snapshot.timing },
      serializeOnlineWriting: serialize,
      readOnlineWriting: async (client, row) => ({ ok: true, writing: serialize(row, await service.getStatus(row.attempt_token, client)) }),
      onWriting: (row, executor, options) => service.ensureSubmission({ attemptToken: row.attempt_token,
        testSlug: row.test_slug, task1: row.writing_task_1, task2: row.writing_task_2,
        taskDefinitions: [{ id: term === 1 ? 'task2' : 'task1', prompt: 'Synthetic prompt' }] }, executor, options)
    };
  }
  const app = express();
  app.use(express.json());
  const adapter = mountJournal?.(app, { pool, config: { allowedOrigins: [] } });
  app.use((req, res, next) => {
    const send = res.json;
    res.json = function (data) {
      if (fault.drop && data?.receipt?.operationId === fault.drop) {
        fault.drop = null;
        this.destroy();
        return this;
      }
      return send.call(this, data);
    };
    next();
  });
  const limiter = (_req, _res, next) => next();
  const opts = Object.fromEntries(['CLASSES', 'HOURS', 'LIMIT'].map(key => ['K56_TERM_ONLINE_HOLD_' + key, process.env['K56_TERM_ONLINE_HOLD_' + key]]));
  Object.assign(process.env, { K56_TERM_ONLINE_HOLD_CLASSES: enabled ? scope.classCode : '',
    K56_TERM_ONLINE_HOLD_HOURS: '2', K56_TERM_ONLINE_HOLD_LIMIT: '8' });
  try {
    registerK56ExamOrder(app, { pool, profile: { family: 'k56' }, limiter, ...writingOptions,
      requestPortalSync: async (_attempt, result) => { portal.push(result); return 'pending'; },
      onJournalEvent: (...event) => {
        if (fault.logger) throw Error('Synthetic logger outage');
        observations.push(event);
        adapter?.business(...event);
      }
    });
  } finally {
    for (const [key, value] of Object.entries(opts)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  mountSubmissionStatus(app, { pool, limiter });
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.code || error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/term-tests/' + slug;
  async function request(path, body) {
    const response = await fetch(base + '/' + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-exam-journal-request-id': randomUUID()
    }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  }
  const prepare = (options = {}) => request('attempt/prepare', { ...scope, mode, submissionRecovery: 1, ...options });
  const op = (section, answers, changes = {}) => ({
    ...scope, answers, mode, draftRevision: 1, ...(section === 'listening' ? { clientSubmissionId: randomUUID() } : {}),
    recovery: { ...scope, operationId: randomUUID(), capturedAt: new Date().toISOString(), automatic: false, ...changes }
  });
  const status = (section, body, options = {}) => request('submission-recovery/status', {
    ...scope, section, operationId: body.recovery.operationId, ...options
  });
  return { db, pool, base, scope, slug, fault, observations, portal, request, prepare, op, status, content,
    rerunGrading: row => writingOptions.onWriting?.(row),
    a: scope.attemptToken, s: scope.examSessionToken, student: scope.studentRef };
}

if (!process.env.K56_ONLINE_FIXTURE_IMPORT_ONLY) {
  for (const term of [1, 2]) for (const mode of ['lis_first', 'read_first']) {
    test(`Term ${term} online K56: keeps later answers until native order permits a single commit · ${mode}`, async t => {
      const f = await fixture(t, term, mode);
      assert.equal((await f.prepare()).submissionRecoveryVersion, 1);
      const [first, later] = mode === 'lis_first' ? ['listening', 'reading'] : ['reading', 'listening'];
      const pending = f.op(later, { 1: 'A', 2: 'Synthetic private answer — held' });
      const denied = await f.request(later, pending);
      assert.equal(denied.error, 'K56_SECTION_ORDER');
      assert.ok(denied.held?.payloadHash);
      const read = await f.status(later, pending);
      assert.deepEqual(read.held, denied.held);
      assert.equal(read.persisted, false);
      assert.equal((await f.status(later, pending, { studentRef: randomUUID() })).status, 403);
      assert.equal((await f.status(later, pending, { generation: 1 })).status, 403);
      assert.equal((await f.request(later, { ...pending, answers: { 1: 'different' } })).error, 'OPERATION_CONFLICT');
      const { rows: [before] } = await f.db.query(`SELECT
        (SELECT payload->'answers' FROM assessment.term_online_submission_hold WHERE operation_id=$1) AS answers,
        (SELECT count(*)::int FROM assessment.k56_portal_field_dispatch) AS scores`, [pending.recovery.operationId]);
      assert.deepEqual(before, { answers: pending.answers, scores: 0 });

      const opening = f.op(first, { 1: 'A' });
      assert.ok((await f.request(first, opening)).receipt?.receiptId);
      f.fault.drop = pending.recovery.operationId;
      f.fault.logger = true;
      await assert.rejects(() => f.request(later, pending));
      const official = await f.status(later, pending);
      assert.equal(official.persisted, true);
      assert.equal(official.held, undefined);
      assert.deepEqual((await f.request(later, pending)).receipt, official.receipt);
      assert.equal(f.portal.length, 2);
      const { rows: after } = await f.db.query(`SELECT
        (SELECT count(*)::int FROM assessment.term_online_submission_hold WHERE receipt IS NOT NULL) AS receipts,
        (SELECT count(*)::int FROM assessment.term_online_submission_hold WHERE payload IS NOT NULL) AS holds,
        (SELECT count(*)::int FROM assessment.k56_portal_field_dispatch) AS scores`);
      assert.deepEqual(after, [{ receipts: 2, holds: 0, scores: 2 }]);
      assert.ok(!JSON.stringify(f.observations).includes(pending.answers[2]));
    });
  }
  test('A failed receipt transaction leaves the Term K56 held answers and rolls back the native grade', async t => {
    const f = await fixture(t, 2, 'read_first');
    assert.equal((await f.prepare()).submissionRecoveryVersion, 1);
    const reading = f.op('reading', { 1: 'A' });
    f.fault.receipt = true;
    const failure = await f.request('reading', reading);
    assert.equal(failure.status, 503);
    assert.ok(failure.held);
    assert.equal((await f.status('reading', reading)).receipt, null);
    assert.equal((await f.db.query('SELECT reading_submitted_at FROM assessment.term_test_attempt')).rows[0].reading_submitted_at, null);
    assert.equal(f.portal.length, 0);
    f.fault.receipt = false;
    assert.ok((await f.request('reading', reading)).receipt?.receiptId);
  });
  test('A late Term K56 request keeps the original answer when native scoring uses a different draft', async t => {
    const f = await fixture(t, 2, 'read_first');
    assert.equal((await f.prepare()).submissionRecoveryVersion, 1);
    await f.db.exec(`UPDATE assessment.term_test_attempt SET reading_deadline_at=now()-interval '10 minutes',
      reading_draft='{"1":"A"}',reading_draft_revision=3`);
    const reading = f.op('reading', { 1: 'B' });
    const result = await f.request('reading', reading);
    assert.equal(result.readingSubmitted, true);
    assert.equal(result.recoveryReview, 'SUBMISSION_DIFFERENT_CANONICAL');
    assert.equal(result.receipt, undefined);
    const status = await f.status('reading', reading);
    assert.deepEqual(status.held, result.held);
    assert.equal(status.recoveryReview, result.recoveryReview);
    assert.deepEqual((await f.db.query('SELECT reading_answers FROM assessment.term_test_attempt')).rows[0].reading_answers, { 1: 'A' });
    assert.deepEqual((await f.db.query(`SELECT payload->'answers' AS answers FROM assessment.term_online_submission_hold`)).rows[0].answers, { 1: 'B' });
  });
  test('Term K56 keeps the legacy status response for attempts without new enrollment', async t => {
    const f = await fixture(t, 1, 'read_first', { enabled: false });
    assert.equal((await f.prepare()).submissionRecoveryVersion, undefined);
    const { recovery, ...legacy } = f.op('reading', { 1: 'A' });
    assert.equal((await f.request('reading', { ...legacy, recovery })).status, 403);
    assert.equal((await f.request('reading', legacy)).readingSubmitted, true);
    const old = await f.request('submission-status', { section: 'reading', attemptToken: f.scope.attemptToken });
    assert.deepEqual(old.receipt?.answers, { 1: 'A' });
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_online_submission_hold')).rows[0].n, 0);
  });
}
