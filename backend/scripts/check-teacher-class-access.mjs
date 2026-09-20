import pg from 'pg';
import { inspectTeacherClassAccess } from '../src/teacher-class-access-health.js';

const { Pool } = pg;
const args = new Set(process.argv.slice(2));
const applyMissing = args.has('--apply-missing');
const strictWarnings = args.has('--strict-warnings');
const freshnessArgument = process.argv.find(value => value.startsWith('--freshness-hours='));
const freshnessHours = freshnessArgument ? Number(freshnessArgument.split('=', 2)[1]) : 36;

if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({ outcome: 'failure', error: 'DATABASE_URL_REQUIRED' }));
  process.exitCode = 2;
} else {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'teacher_class_access_health'
  });
  try {
    const result = await inspectTeacherClassAccess({
      query: pool.query.bind(pool),
      freshnessHours,
      applyMissing
    });
    console.log(JSON.stringify(result));
    if (result.outcome === 'critical' || (strictWarnings && result.outcome === 'attention')) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ outcome: 'failure', error: 'TEACHER_CLASS_ACCESS_CHECK_FAILED' }));
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
