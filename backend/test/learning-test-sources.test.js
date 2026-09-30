import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createLearningTestSourceReader } from '../src/learning-test-sources.js';

test('nguồn Test có thể ghép trước khi có điểm và không trả điểm', async () => {
  const calls = [];
  const reader = createLearningTestSourceReader({ pool: {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [
        { test_slug: 'mini-test-lesson-5', title: 'Mini Test', version: 2,
          students_with_result: 12, latest_result_at: new Date('2026-09-29T10:00:00Z'), class_evidence: 'result' },
        { test_slug: 'term-test-2', title: 'Term Test 2', version: 1,
          students_with_result: 0, latest_result_at: null, class_evidence: 'roster' },
        { test_slug: 'term-test-3', title: 'Term Test 3', version: 1,
          students_with_result: 0, latest_result_at: null, class_evidence: 'definition_only' }
      ] };
    }
  } });
  const tests = await reader('1294');
  assert.deepEqual(tests, [{ testSlug: 'mini-test-lesson-5', title: 'Mini Test',
    definitionVersion: 2, studentsWithResult: 12,
    latestResultAt: '2026-09-29T10:00:00.000Z', classEvidence: 'result' },
  { testSlug: 'term-test-2', title: 'Term Test 2', definitionVersion: 1,
    studentsWithResult: 0, latestResultAt: null, classEvidence: 'roster' },
  { testSlug: 'term-test-3', title: 'Term Test 3', definitionVersion: 1,
    studentsWithResult: 0, latestResultAt: null, classEvidence: 'definition_only' }]);
  assert.deepEqual(calls[0].params, ['1294']);
  assert.match(calls[0].sql, /completed_at IS NOT NULL/);
  assert.match(calls[0].sql, /count\(DISTINCT erp_student_contact_id\)/);
  assert.match(calls[0].sql, /definition\.is_active = true/u);
  assert.match(calls[0].sql, /assessment\.term_test_roster/u);
  assert.doesNotMatch(JSON.stringify(tests), /student_ref|student_name|score|answer/u);
  await assert.rejects(() => reader('1294 OR 1=1'), /TEST_SOURCE_CLASS_INVALID/u);
});

test('nguồn Test từ chối dòng không hợp lệ trước khi trả cho giảng viên', async () => {
  const reader = createLearningTestSourceReader({ pool: { async query() {
    return { rows: [{ test_slug: 'other-test', title: 'Sai', version: 1,
      students_with_result: 1, latest_result_at: new Date(), class_evidence: 'result' }] };
  } } });
  await assert.rejects(() => reader('1294'), /TEST_SOURCE_ROW_INVALID/u);
});

test('giảng viên ghép được buổi Test trước khi có điểm; nguồn cập nhật khi bài hoàn tất', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA assessment;
      CREATE TABLE assessment.test_definition (
        slug text PRIMARY KEY, title text, version integer, is_active boolean
      );
      CREATE TABLE assessment.term_test_roster (
        test_slug text, erp_course_class_id bigint
      );
      CREATE TABLE assessment.term_test_attempt (
        test_slug text, erp_course_class_id bigint,
        erp_student_contact_id bigint, completed_at timestamptz, combined_result jsonb
      );
      CREATE TABLE assessment.mini_test_result (
        test_slug text, erp_course_class_id bigint,
        erp_student_contact_id bigint, updated_at timestamptz, result jsonb
      );
      INSERT INTO assessment.test_definition VALUES
        ('term-test-2', 'Term Test 2', 1, true),
        ('mini-test-lesson-5', 'Mini Test', 2, true),
        ('term-test-9', 'Bài đã đóng', 1, false);
      INSERT INTO assessment.term_test_roster VALUES ('term-test-2', 1294);
    `);
    const reader = createLearningTestSourceReader({ pool: db });
    const before = await reader('1294');
    assert.deepEqual(before.map(item => [item.testSlug, item.classEvidence]), [
      ['term-test-2', 'roster'], ['mini-test-lesson-5', 'definition_only']
    ]);
    await db.exec(`INSERT INTO assessment.term_test_attempt VALUES
      ('term-test-2', 1294, 101, '2026-09-30T10:00:00Z', '{}'),
      ('term-test-2', 9999, 102, '2026-09-30T10:00:00Z', '{}');`);
    const after = await reader('1294');
    assert.equal(after.find(item => item.testSlug === 'term-test-2').studentsWithResult, 1);
    assert.equal(after.find(item => item.testSlug === 'term-test-2').classEvidence, 'result');
  } finally {
    await db.close();
  }
});
