import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createLearningTestResultReader } from '../src/learning-test-results.js';

test('đọc điểm Test đúng học viên/lớp và bổ sung Writing khi bản chấm cuối sẵn sàng', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA assessment; CREATE SCHEMA mapping;
      CREATE TABLE assessment.term_test_roster (
        test_slug text, erp_course_class_id bigint, student_ref uuid,
        erp_student_contact_id bigint
      );
      CREATE TABLE mapping.student_mapping_review (
        erp_course_class_id bigint, public_id uuid, erp_student_contact_id bigint, status text
      );
      CREATE TABLE assessment.term_test_temporary_student (
        test_slug text, erp_course_class_id bigint, student_ref uuid,
        temporary_student_id bigint, active boolean
      );
      CREATE TABLE assessment.term_test_attempt (
        id uuid, test_slug text, erp_course_class_id bigint,
        erp_student_contact_id bigint, combined_result jsonb,
        completed_at timestamptz, writing_submitted_at timestamptz
      );
      CREATE TABLE assessment.test_definition (slug text, title text);
      CREATE TABLE assessment.term_test_writing_grading_final (
        attempt_id uuid, status text, writing_score numeric
      );
      CREATE TABLE assessment.mini_test_result (
        test_slug text, erp_course_class_id bigint,
        erp_student_contact_id bigint, result jsonb, updated_at timestamptz
      );
      INSERT INTO mapping.student_mapping_review VALUES
        (1294, '10000000-0000-4000-8000-000000000001', 101, 'active'),
        (1294, '10000000-0000-4000-8000-000000000002', 102, 'active'),
        (9999, '10000000-0000-4000-8000-000000000001', 101, 'active');
      INSERT INTO assessment.test_definition VALUES
        ('term-test-2', 'Term Test 2'), ('mini-test-lesson-5', 'Mini Test');
      INSERT INTO assessment.term_test_attempt VALUES
        ('20000000-0000-4000-8000-000000000001', 'term-test-2', 1294, 101,
          '{"listening":{"correct":30,"total":40,"band":7},"reading":{"correct":28,"total":40,"band":6.5}}',
          '2026-09-20T12:00:00Z', '2026-09-21T12:00:00Z'),
        ('20000000-0000-4000-8000-000000000002', 'term-test-2', 1294, 102,
          '{"listening":{"correct":40,"total":40,"band":9}}',
          '2026-09-22T12:00:00Z', NULL),
        ('20000000-0000-4000-8000-000000000003', 'term-test-2', 9999, 101,
          '{"listening":{"correct":1,"total":40,"band":2}}',
          '2026-09-23T12:00:00Z', NULL);
      INSERT INTO assessment.term_test_writing_grading_final VALUES
        ('20000000-0000-4000-8000-000000000001', 'pending', 6.5);
      INSERT INTO assessment.mini_test_result VALUES
        ('mini-test-lesson-5', 1294, 101,
          '{"listening":{"correct":15,"total":20,"band":7}}',
          '2026-09-19T12:00:00Z');
    `);
    const reader = createLearningTestResultReader({ pool: db });
    const input = { classId: '1294', studentRef: '10000000-0000-4000-8000-000000000001',
      testSlugs: ['term-test-2', 'mini-test-lesson-5'] };
    const first = await reader(input);
    assert.equal(first.find(item => item.testSlug === 'term-test-2').listening.correct, 30);
    assert.deepEqual(first.find(item => item.testSlug === 'term-test-2').writing,
      { status: 'pending', score: null });
    assert.equal(first.find(item => item.testSlug === 'mini-test-lesson-5').writing, null);
    await db.exec(`UPDATE assessment.term_test_writing_grading_final
      SET status = 'ready' WHERE attempt_id = '20000000-0000-4000-8000-000000000001';`);
    const ready = await reader(input);
    assert.deepEqual(ready.find(item => item.testSlug === 'term-test-2').writing,
      { status: 'ready', score: 6.5 });
    const other = await reader({ ...input,
      studentRef: '10000000-0000-4000-8000-000000000002', testSlugs: ['term-test-2'] });
    assert.equal(other[0].listening.correct, 40);
    await db.exec(`INSERT INTO mapping.student_mapping_review VALUES
      (1294, '10000000-0000-4000-8000-000000000001', 103, 'active');`);
    assert.deepEqual(await reader(input), []);
  } finally {
    await db.close();
  }
});
