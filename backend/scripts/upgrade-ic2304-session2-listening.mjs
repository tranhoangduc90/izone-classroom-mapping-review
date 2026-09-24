/*
 * Dữ liệu nhận vào: mã người tạo, người duyệt thứ hai và kết nối database từ môi trường.
 * Xử lý: chỉ chuyển phiếu IC2304 Buổi 2 sang version chấm Listening khi chưa có lượt làm.
 * Kết quả: giữ nguyên link, roster và trạng thái mở/khóa; in số liệu kiểm chứng không định danh.
 * Khi lỗi: rollback transaction và báo mã pha; dữ liệu lớp không bị đổi dở.
 */
import pg from 'pg';
import { sha256, stableStringify } from '../src/learning-domain.js';
import {
  buildIc2304Session2ScoredDefinition,
  buildIc2304Session2ScoredGradingKey,
  IC2304_SESSION2_SCORED
} from '../src/learning-templates/ic2304-session2-scored.js';
import { IC2304_SESSION2_TEMPLATE } from '../src/learning-templates/ic2304-session2-listening-writing.js';

const definition = buildIc2304Session2ScoredDefinition();
const definitionHash = sha256(stableStringify(definition));
const apply = process.argv.includes('--apply');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3).trim().toLowerCase() || '';
const creator = argument('creator');
const approver = argument('approver');

const plan = {
  mode: apply ? 'apply' : 'plan',
  classCode: 'IC2304',
  sessionNumber: 2,
  courseCode: '67',
  oldFormVersionId: IC2304_SESSION2_TEMPLATE.formVersionId,
  newFormVersionId: IC2304_SESSION2_SCORED.formVersionId,
  scoredItems: 5,
  answerReleasePolicy: 'immediate',
  keepsExistingLink: true,
  requiresNoAttempts: true,
  requiresDistinctApprover: true
};
if (!apply) {
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}
if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');
if (!creator || !approver || creator === approver) throw new Error('DISTINCT_CREATOR_AND_APPROVER_REQUIRED');
const answerIds = (process.env.IC2304_LISTENING_ANSWER_IDS || '').split(',').map(value => value.trim());
const key = buildIc2304Session2ScoredGradingKey(answerIds);
const keyHash = sha256(stableStringify(key));

const pool = new pg.Pool({ connectionString: process.env.LEARNING_DATABASE_URL,
  max: 1, application_name: 'izone_upgrade_ic2304_session2_listening' });
let client;
let phase = 'connect';
try {
  client = await pool.connect();
  phase = 'begin';
  await client.query('BEGIN');
  phase = 'assignment';
  const assignmentResult = await client.query(`SELECT assignment.id,
      assignment.form_version_id, assignment.erp_course_class_id,
      assignment.course_code, assignment.status,
      version.template_id, version.definition_hash
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE upper(trim(assignment.class_name_snapshot)) = 'IC2304'
      AND assignment.session_number = 2
      AND assignment.status = 'published'
    FOR UPDATE OF assignment;`);
  if (assignmentResult.rowCount !== 1) throw new Error('ASSIGNMENT_NOT_UNIQUE_OR_UNAVAILABLE');
  const assignment = assignmentResult.rows[0];
  if (assignment.course_code !== '67'
    || assignment.template_id !== IC2304_SESSION2_SCORED.templateId) {
    throw new Error('ASSIGNMENT_IDENTITY_MISMATCH');
  }
  phase = 'reviewers';
  const reviewers = await client.query(`SELECT reviewer.email,
      EXISTS (SELECT 1 FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = reviewer.email
          AND access.erp_course_class_id = $3::bigint) AS has_class_access
    FROM mapping.reviewer_account AS reviewer
    WHERE reviewer.email IN ($1, $2) AND reviewer.status = 'active';`, [
      creator, approver, assignment.erp_course_class_id
    ]);
  if (reviewers.rowCount !== 2 || reviewers.rows.some(row => !row.has_class_access)) {
    throw new Error('REVIEWER_ACCESS_MISSING');
  }
  phase = 'attempt_guard';
  const attempts = await client.query(`SELECT count(*)::int AS total
    FROM learning.attempt WHERE assignment_id = $1::uuid;`, [assignment.id]);
  if (Number(attempts.rows[0].total) !== 0
    && assignment.form_version_id !== definition.formVersionId) {
    throw new Error('ASSIGNMENT_HAS_ATTEMPTS');
  }

  phase = 'version';
  const existingVersion = await client.query(`SELECT definition_hash FROM learning.form_version
    WHERE id = $1::uuid;`, [definition.formVersionId]);
  if (existingVersion.rowCount && existingVersion.rows[0].definition_hash !== definitionHash) {
    throw new Error('FORM_VERSION_HASH_CONFLICT');
  }
  if (!existingVersion.rowCount) {
    await client.query(`INSERT INTO learning.form_version (
        id, template_id, version, schema_version, public_definition, definition_hash,
        status, created_by_email, approved_by_email, published_at
      ) VALUES ($1::uuid, $2::uuid, 2, 'FormDefinitionV1', $3::jsonb, $4,
        'published', $5, $6, now());`, [definition.formVersionId,
      IC2304_SESSION2_SCORED.templateId, JSON.stringify(definition), definitionHash,
      creator, approver]);
    await client.query(`INSERT INTO learning.form_grading_key (
        form_version_id, schema_version, grader_version, private_definition, content_hash
      ) VALUES ($1::uuid, 'FormGradingKeyV1', 1, $2::jsonb, $3);`, [
      definition.formVersionId, JSON.stringify(key), keyHash
    ]);
  }
  const existingKey = await client.query(`SELECT content_hash FROM learning.form_grading_key
    WHERE form_version_id = $1::uuid;`, [definition.formVersionId]);
  if (existingKey.rowCount !== 1 || existingKey.rows[0].content_hash !== keyHash) {
    throw new Error('GRADING_KEY_HASH_CONFLICT');
  }
  if (assignment.form_version_id === IC2304_SESSION2_TEMPLATE.formVersionId) {
    phase = 'switch_assignment';
    await client.query(`UPDATE learning.form_assignment
      SET form_version_id = $2::uuid, updated_at = now()
      WHERE id = $1::uuid AND form_version_id = $3::uuid;`, [assignment.id,
      definition.formVersionId, IC2304_SESSION2_TEMPLATE.formVersionId]);
  } else if (assignment.form_version_id !== definition.formVersionId) {
    throw new Error('OTHER_FORM_VERSION_ASSIGNED');
  }
  phase = 'readback';
  const readback = await client.query(`SELECT assignment.form_version_id,
      version.definition_hash,
      (SELECT count(*)::int FROM learning.form_assignment_roster
        WHERE assignment_id = assignment.id) AS roster_count,
      (SELECT count(*)::int FROM learning.assignment_block_release
        WHERE assignment_id = assignment.id) AS block_count
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE assignment.id = $1::uuid;`, [assignment.id]);
  const verified = readback.rows[0];
  if (!verified || verified.form_version_id !== definition.formVersionId
    || verified.definition_hash !== definitionHash
    || Number(verified.roster_count) < 1 || Number(verified.block_count) !== 2) {
    throw new Error('UPGRADE_READBACK_MISMATCH');
  }
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({ ...plan, rosterCount: Number(verified.roster_count),
    blockCount: Number(verified.block_count), replayed: existingVersion.rowCount > 0 }) + '\n');
} catch (error) {
  if (client) await client.query('ROLLBACK');
  process.stderr.write(`UPGRADE_FAILED_${phase}:${error.code || error.message || 'UNKNOWN'}\n`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
