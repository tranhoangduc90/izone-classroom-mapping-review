import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createAssessmentSchemaPool } from '../../../src/assessment-schema-pool.js';
import { createErpGradeSync } from '../../../src/erp-sync.js';

const ATTEMPT_TOKEN = '00000000-0000-4000-8000-000000000322';
const TEST_SLUG = 'term-test-2-k56';
const CLASS_ID = '99000002';
const STUDENT_ID = '9002';
const EXPECTED_GRADES = Object.freeze({ listening: 31, reading: 28, writing: 6.5 });

// Dữ liệu vào: URL webhook thử lấy từ đúng workflow canary trên n8n-ai.
// Việc chính: chặn URL thật, URL khác máy chủ hoặc query lạ trước khi tạo kho/thử HTTP.
// Kết quả: chỉ một webhook bridge có UUID của workflow thử được phép nhận điểm giả.
// Khi lỗi: dừng tại máy local, không gửi bất kỳ request ghi điểm nào.
export function validateCanaryWriterUrl(rawUrl) {
  const value = String(rawUrl ?? '');
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', 'CANARY_WRITER_HTTPS_REQUIRED');
  assert.equal(url.hostname, 'n8n-ai.izone.edu.vn', 'CANARY_WRITER_HOST_INVALID');
  assert.equal(url.port, '', 'CANARY_WRITER_PORT_INVALID');
  assert.match(url.pathname,
    /^\/webhook\/term-k56-writer-bridge-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    'CANARY_WRITER_ROUTE_INVALID');
  assert.equal(url.search, '', 'CANARY_WRITER_QUERY_FORBIDDEN');
  assert.equal(url.hash, '', 'CANARY_WRITER_FRAGMENT_FORBIDDEN');
  assert.equal(url.username, '', 'CANARY_WRITER_USERINFO_FORBIDDEN');
  assert.equal(url.password, '', 'CANARY_WRITER_USERINFO_FORBIDDEN');
  return url.href;
}

// Dữ liệu vào: migration K56 và ID lớp/học viên giả cố định.
// Việc chính: dựng mapping, quyền đề, lượt thi và trạng thái đồng bộ trong PGlite riêng.
// Kết quả: adapter backend thật có thể kiểm quyền và lưu biên nhận mà không chạm database live.
// Khi lỗi: đóng kho nhúng; không có lớp, học viên hoặc điểm thật cần hoàn tác.
async function createCanaryDatabase() {
  const database = new PGlite();
  try {
    await database.exec(`CREATE SCHEMA mapping;
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
      );`);
    for (const migrationName of [
      '202609240003_k56_assessment_schema.sql',
      '202609240005_k56_class_access.sql',
    ]) {
      const migration = await readFile(new URL(`../../migrations/${migrationName}`, import.meta.url), 'utf8');
      await database.exec(migration);
    }
    await database.query(`INSERT INTO mapping.classroom_course_mapping
      (erp_course_class_id, erp_class_name_snapshot) VALUES ($1, 'CODEX-CANARY')`, [CLASS_ID]);
    await database.query(`INSERT INTO assessment_k56.test_definition
      (slug, title, version, listening_definition, reading_definition, is_active)
      VALUES ($1, 'Term Test 2 giả', 1, '{}'::jsonb, '{}'::jsonb, true)`, [TEST_SLUG]);
    await database.query(`INSERT INTO assessment_k56.term_test_class_access
      (test_slug, erp_course_class_id, enabled, source)
      VALUES ($1, $2, true, 'http_writer_canary')`, [TEST_SLUG, CLASS_ID]);
    await database.query(`INSERT INTO assessment_k56.term_test_attempt (
      id, client_submission_id, test_slug, definition_version,
      erp_course_class_id, class_name_snapshot, erp_student_contact_id,
      student_name_snapshot, listening_answers, listening_result,
      listening_submitted_at, reading_answers, reading_result,
      reading_submitted_at, completed_at, combined_result
    ) VALUES ($1::uuid, gen_random_uuid(), $2, 1, $3, 'CODEX-CANARY', $4,
      'Học viên giả', '{}'::jsonb, '{}'::jsonb, now(),
      '{}'::jsonb, '{}'::jsonb, now(), now(), '{}'::jsonb)`,
    [ATTEMPT_TOKEN, TEST_SLUG, CLASS_ID, STUDENT_ID]);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

// Dữ liệu vào: một URL bridge thử đã kiểm, bài/điểm hoàn toàn giả.
// Việc chính: gọi đúng adapter backend, đọc trạng thái DB, gọi lặp để thử chống gửi trùng.
// Kết quả: chỉ báo số lượt HTTP và trạng thái; không in URL, payload hoặc khóa thử.
// Khi lỗi: báo lỗi, đóng PGlite; Portal giả được dọn qua workflow riêng sau readback.
export async function runCanary(rawUrl, { fetchImpl = globalThis.fetch } = {}) {
  const erpSyncUrl = validateCanaryWriterUrl(rawUrl);
  const database = await createCanaryDatabase();
  let httpCalls = 0;
  try {
    const pgCompatiblePool = {
      async query(...args) {
        const result = await database.query(...args);
        return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
      },
    };
    const pool = createAssessmentSchemaPool(pgCompatiblePool, { family: 'k56' });
    const sync = createErpGradeSync({
      config: {
        demoIsolatedMode: false,
        k56PortalPilotEnabled: true,
        erpSyncUrl,
        erpSyncSecret: 'canary-term-k56',
        erpSyncTimeoutMs: 20_000,
      },
      pool,
      logger: { info() {}, error() {} },
      fetchImpl: (...args) => {
        httpCalls += 1;
        return fetchImpl(...args);
      },
    });
    const payload = { version: 1, attemptToken: ATTEMPT_TOKEN,
      testSlug: TEST_SLUG, classId: CLASS_ID, studentId: STUDENT_ID,
      grades: EXPECTED_GRADES };
    const first = await sync(payload);
    assert.equal(first.status, 'synced', 'CANARY_FIRST_SYNC_FAILED');
    assert.equal(first.ok, true, 'CANARY_WRITER_RESPONSE_CONTRACT_FAILED');
    assert.equal(first.attemptToken, ATTEMPT_TOKEN, 'CANARY_ATTEMPT_MISMATCH');
    const second = await sync(payload);
    assert.equal(second.status, 'synced', 'CANARY_REPEAT_NOT_SYNCED');
    assert.equal(second.skipped, true, 'CANARY_REPEAT_NOT_SKIPPED');
    assert.equal(httpCalls, 1, 'CANARY_REPEAT_SENT_HTTP');
    const stored = await pool.query(`SELECT status, grade_fields
      FROM assessment.term_test_portal_sync_state WHERE attempt_id = $1::uuid`,
    [ATTEMPT_TOKEN]);
    assert.equal(stored.rows.length, 1, 'CANARY_SYNC_STATE_COUNT');
    assert.equal(stored.rows[0].status, 'synced', 'CANARY_SYNC_STATE_NOT_SYNCED');
    assert.deepEqual([...stored.rows[0].grade_fields].sort(),
      ['listening', 'reading', 'writing']);
    return { businessOutcome: 'success', profile: TEST_SLUG,
      firstStatus: first.status, repeatStatus: second.status,
      repeatSkipped: second.skipped, httpCalls, syncRows: stored.rows.length };
  } finally {
    await database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runCanary(process.env.TERM_CANARY_WRITER_URL);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
