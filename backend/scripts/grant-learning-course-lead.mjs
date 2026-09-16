/*
 * Dữ liệu nhận vào: email lead, mã khóa, căn cứ cấp quyền và LEARNING_DATABASE_URL.
 * Xử lý: kiểm tài khoản đang hoạt động rồi ghi quyền tự duyệt có phạm vi trong một transaction.
 * Kết quả: chỉ lead của đúng khóa mới có thể tự duyệt form có điểm; output không in email thật.
 * Khi lỗi: rollback toàn bộ và báo mã lỗi an toàn, không in connection string.
 */

import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const apply = process.argv.includes('--apply');
const reviewerEmail = option('email').trim().toLowerCase();
const courseCode = option('course', '56').trim().toLowerCase();
const grantReference = option('grant-reference').trim();
const reviewerKey = reviewerEmail
  ? crypto.createHash('sha256').update(reviewerEmail).digest('hex').slice(0, 12)
  : null;

const plan = {
  mode: apply ? 'apply' : 'plan',
  reviewerKey,
  courseCode,
  authorityRole: 'course_lead',
  canSelfApproveScoredForms: true
};

if (!apply) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');
if (!reviewerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reviewerEmail)) {
  throw new Error('VALID_REVIEWER_EMAIL_REQUIRED');
}
if (!/^[a-z0-9][a-z0-9_.-]{1,79}$/.test(courseCode)) throw new Error('VALID_COURSE_CODE_REQUIRED');
if (grantReference.length < 8 || grantReference.length > 500) throw new Error('GRANT_REFERENCE_REQUIRED');

const pool = new Pool({
  connectionString: process.env.LEARNING_DATABASE_URL,
  max: 1,
  application_name: 'izone_grant_learning_course_lead'
});
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const account = await client.query(`SELECT 1
    FROM mapping.reviewer_account
    WHERE email = $1 AND status = 'active';`, [reviewerEmail]);
  if (account.rowCount !== 1) throw new Error('REVIEWER_NOT_ACTIVE');

  await client.query(`INSERT INTO learning.course_content_authority (
      reviewer_email, course_code, authority_role, can_self_approve_scored_forms,
      status, grant_reference, revoked_at, updated_at
    ) VALUES ($1, $2, 'course_lead', true, 'active', $3, NULL, now())
    ON CONFLICT (reviewer_email, course_code) DO UPDATE SET
      authority_role = EXCLUDED.authority_role,
      can_self_approve_scored_forms = true,
      status = 'active',
      grant_reference = EXCLUDED.grant_reference,
      revoked_at = NULL,
      updated_at = now();`, [reviewerEmail, courseCode, grantReference]);

  const readback = await client.query(`SELECT course_code, authority_role,
      can_self_approve_scored_forms, status
    FROM learning.course_content_authority
    WHERE reviewer_email = $1 AND course_code = $2;`, [reviewerEmail, courseCode]);
  const verified = readback.rows[0];
  if (!verified || verified.status !== 'active'
    || verified.authority_role !== 'course_lead'
    || verified.can_self_approve_scored_forms !== true) {
    throw new Error('COURSE_LEAD_GRANT_READBACK_MISMATCH');
  }

  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ ...plan, verified: true }, null, 2)}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  process.stderr.write(`${error.code || error.message || 'COURSE_LEAD_GRANT_FAILED'}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
