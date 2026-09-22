import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const backendRoot = resolve(process.env.BACKEND_UNDER_TEST || fileURLToPath(new URL('..', import.meta.url)));
const gradingModuleUrl = pathToFileURL(resolve(backendRoot, 'src/term-test-writing-grading.js')).href;
const { createTermTestWritingGradingService } = await import(gradingModuleUrl);

async function makeDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_attempt (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_slug TEXT NOT NULL,
      erp_course_class_id BIGINT,
      erp_student_contact_id BIGINT,
      class_name_snapshot TEXT,
      student_name_snapshot TEXT,
      listening_result JSONB,
      combined_result JSONB,
      completed_at TIMESTAMPTZ,
      writing_submitted_at TIMESTAMPTZ
    );
  `);
  const migration = await readFile(
    resolve(backendRoot, '..', 'docs', 'migrations', '2026-08-19-term-test-writing-grading.sql'),
    'utf8'
  );
  await database.exec(migration);
  return database;
}

test('nhiều execution đồng thời vẫn chỉ giữ tối đa bốn job trên toàn hệ thống', async () => {
  const database = await makeDatabase();
  try {
    const service = createTermTestWritingGradingService({ pool: database });
    for (let index = 0; index < 6; index += 1) {
      const attemptToken = `00000000-0000-4000-8000-00000000040${index}`;
      await database.query(`INSERT INTO assessment.term_test_attempt
        (id, test_slug, completed_at, writing_submitted_at)
        VALUES ($1::uuid, 'term-test-2', now(), now());`, [attemptToken]);
      await service.ensureSubmission({
        attemptToken,
        testSlug: 'term-test-2',
        task1: '',
        task2: 'Bài thử tổng hợp.',
        taskDefinitions: [{ id: 'task2', prompt: 'Đề thử tổng hợp.' }]
      });
    }

    const first = await service.claimJobs({ workerId: 'execution-1', limit: 10 });
    assert.equal(first.length, 4);
    assert.equal((await service.claimJobs({ workerId: 'execution-2', limit: 10 })).length, 0);

    await service.completeDispatch({ jobId: first[0].jobId, workerId: 'execution-1' });
    const next = await service.claimJobs({ workerId: 'execution-2', limit: 10 });
    assert.equal(next.length, 1);
    assert(!first.some(job => job.jobId === next[0].jobId));

    const state = await database.query(`SELECT count(*)::int AS count
      FROM assessment.term_test_writing_grading_job
      WHERE status='processing' AND lease_until>now();`);
    assert.equal(state.rows[0].count, 4);
  } finally {
    await database.close();
  }
});
