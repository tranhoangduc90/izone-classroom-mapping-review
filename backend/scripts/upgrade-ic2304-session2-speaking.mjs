/*
 * Dữ liệu nhận vào: mã người tạo, người duyệt có quyền và kết nối database từ môi trường.
 * Xử lý: chuyển phiếu IC2304 Buổi 2 từ v1/v2 sang v3 có Speaking khi chưa có lượt làm.
 * Kết quả: giữ nguyên link, roster và hai trạng thái mở/khóa; thêm Speaking ở trạng thái khóa.
 * Khi lỗi: rollback transaction và báo mã pha; dữ liệu lớp không bị đổi dở.
 */
import pg from 'pg';
import { sha256, stableStringify } from '../src/learning-domain.js';
import {
  buildIc2304Session2SpeakingDefinition,
  buildIc2304Session2SpeakingGradingKey,
  IC2304_SESSION2_SPEAKING
} from '../src/learning-templates/ic2304-session2-speaking.js';
import { IC2304_SESSION2_SCORED } from '../src/learning-templates/ic2304-session2-scored.js';
import { IC2304_SESSION2_TEMPLATE } from '../src/learning-templates/ic2304-session2-listening-writing.js';

const definition = buildIc2304Session2SpeakingDefinition();
const definitionHash = sha256(stableStringify(definition));
const apply = process.argv.includes('--apply');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3).trim().toLowerCase() || '';
const requestedCreator = argument('creator');
const approver = argument('approver');
const removeSingleTestAttempt = process.argv.includes('--remove-single-test-attempt');
const backupHash = argument('backup-hash');

const plan = {
  mode: apply ? 'apply' : 'plan',
  classCode: 'IC2304',
  sessionNumber: 2,
  courseCode: '67',
  oldFormVersionIds: [IC2304_SESSION2_TEMPLATE.formVersionId, IC2304_SESSION2_SCORED.formVersionId],
  newFormVersionId: IC2304_SESSION2_SPEAKING.formVersionId,
  scoredItems: 5,
  answerReleasePolicy: 'immediate',
  keepsExistingLink: true,
  requiresNoAttempts: true,
  requiresDistinctApproverOrCourseLead: true,
  removesBackedUpTestAttempt: removeSingleTestAttempt
};
if (!apply) {
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}
if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');
if (!approver) throw new Error('APPROVER_REQUIRED');
if (removeSingleTestAttempt && !/^[0-9a-f]{64}$/.test(backupHash)) {
  throw new Error('TEST_ATTEMPT_BACKUP_HASH_REQUIRED');
}
const answerIds = (process.env.IC2304_LISTENING_ANSWER_IDS || '').split(',').map(value => value.trim());
const key = buildIc2304Session2SpeakingGradingKey(answerIds);
const keyHash = sha256(stableStringify(key));

const pool = new pg.Pool({ connectionString: process.env.LEARNING_DATABASE_URL,
  max: 1, application_name: 'izone_upgrade_ic2304_session2_speaking' });
let client;
let phase = 'connect';
try {
  client = await pool.connect();
  phase = 'begin';
  await client.query('BEGIN');
  phase = 'assignment';
  const assignmentResult = await client.query(`SELECT assignment.id,
      assignment.form_version_id, assignment.erp_course_class_id,
      assignment.course_code, assignment.status, assignment.created_by_email,
      version.template_id, version.definition_hash
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE upper(trim(assignment.class_name_snapshot)) = 'IC2304'
      AND assignment.session_number = 2
      AND assignment.status = 'published'
    FOR UPDATE OF assignment;`);
  if (assignmentResult.rowCount !== 1) throw new Error('ASSIGNMENT_NOT_UNIQUE_OR_UNAVAILABLE');
  const assignment = assignmentResult.rows[0];
  const creator = requestedCreator || assignment.created_by_email.trim().toLowerCase();
  if (!creator) throw new Error('CREATOR_REQUIRED');
  const selfApproving = creator === approver;
  if (assignment.course_code !== '67'
    || assignment.template_id !== IC2304_SESSION2_SPEAKING.templateId) {
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
  if (reviewers.rowCount !== (selfApproving ? 1 : 2)
    || reviewers.rows.some(row => !row.has_class_access)) {
    throw new Error('REVIEWER_ACCESS_MISSING');
  }
  if (selfApproving) {
    const authority = await client.query(`SELECT 1
      FROM learning.course_content_authority
      WHERE lower(trim(reviewer_email)) = $1 AND course_code = $2
        AND authority_role = 'course_lead' AND can_self_approve_scored_forms = true
        AND status = 'active';`, [creator, assignment.course_code]);
    if (authority.rowCount !== 1) throw new Error('COURSE_LEAD_AUTHORITY_REQUIRED');
  }
  phase = 'attempt_guard';
  const attempts = await client.query(`SELECT to_jsonb(attempt) AS attempt,
      COALESCE((SELECT jsonb_agg(to_jsonb(checkpoint) ORDER BY checkpoint.id)
        FROM learning.checkpoint_submission checkpoint
        WHERE checkpoint.attempt_id = attempt.id), '[]'::jsonb) AS checkpoints
    FROM learning.attempt attempt WHERE attempt.assignment_id = $1::uuid
    FOR UPDATE;`, [assignment.id]);
  if (removeSingleTestAttempt) {
    if (assignment.form_version_id === definition.formVersionId
      || attempts.rowCount !== 1 || attempts.rows[0].attempt.status !== 'active') {
      throw new Error('TEST_ATTEMPT_NOT_UNIQUE_OR_NOT_ACTIVE');
    }
    const snapshot = { attempt: attempts.rows[0].attempt,
      checkpoints: attempts.rows[0].checkpoints };
    if (sha256(stableStringify(snapshot)) !== backupHash) {
      throw new Error('TEST_ATTEMPT_CHANGED_AFTER_BACKUP');
    }
    const related = await client.query(`SELECT
        (SELECT count(*)::int FROM learning.submission
          WHERE attempt_id = $1::uuid) AS submissions,
        (SELECT count(*)::int FROM learning.attempt_audio_checkpoint
          WHERE attempt_id = $1::uuid) AS audio_checkpoints,
        (SELECT count(*)::int FROM learning.attendance_record
          WHERE assignment_id = $2::uuid AND student_ref = $3::uuid) AS attendance,
        (SELECT count(*)::int FROM learning.evidence_event
          WHERE assignment_id = $2::uuid AND student_ref = $3::uuid) AS evidence;`, [
      snapshot.attempt.id, assignment.id, snapshot.attempt.student_ref
    ]);
    if (Object.values(related.rows[0]).some(value => Number(value) !== 0)) {
      throw new Error('TEST_ATTEMPT_HAS_FINAL_RECORDS');
    }
    phase = 'remove_test_attempt';
    const removedCheckpoints = await client.query(`DELETE FROM learning.checkpoint_submission
      WHERE attempt_id = $1::uuid;`, [snapshot.attempt.id]);
    if (removedCheckpoints.rowCount !== snapshot.checkpoints.length) {
      throw new Error('TEST_CHECKPOINT_DELETE_MISMATCH');
    }
    const removedAttempt = await client.query(`DELETE FROM learning.attempt
      WHERE id = $1::uuid AND assignment_id = $2::uuid AND status = 'active';`, [
      snapshot.attempt.id, assignment.id
    ]);
    if (removedAttempt.rowCount !== 1) throw new Error('TEST_ATTEMPT_DELETE_MISMATCH');
  } else if (attempts.rowCount !== 0 && assignment.form_version_id !== definition.formVersionId) {
    throw new Error('ASSIGNMENT_HAS_ATTEMPTS');
  }
  phase = 'release_guard';
  const releases = await client.query(`SELECT block_id::text AS block_id, checkpoint, status
    FROM learning.assignment_block_release
    WHERE assignment_id = $1::uuid
    ORDER BY checkpoint FOR UPDATE;`, [assignment.id]);
  const expectedBlocks = assignment.form_version_id === definition.formVersionId
    ? definition.blocks : definition.blocks.slice(0, 2);
  if (releases.rowCount !== expectedBlocks.length
    || releases.rows.some((row, index) => row.block_id !== expectedBlocks[index].blockId
      || Number(row.checkpoint) !== expectedBlocks[index].checkpoint
      || row.status !== (index === 0 ? 'open' : 'locked'))) {
    throw new Error('BLOCK_RELEASES_MISMATCH');
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
      ) VALUES ($1::uuid, $2::uuid, 3, 'FormDefinitionV1', $3::jsonb, $4,
        'published', $5, $6, now());`, [definition.formVersionId,
      IC2304_SESSION2_SPEAKING.templateId, JSON.stringify(definition), definitionHash,
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
  if (plan.oldFormVersionIds.includes(assignment.form_version_id)) {
    phase = 'switch_assignment';
    const switched = await client.query(`UPDATE learning.form_assignment
      SET form_version_id = $2::uuid, updated_at = now()
      WHERE id = $1::uuid AND form_version_id = $3::uuid;`, [assignment.id,
      definition.formVersionId, assignment.form_version_id]);
    if (switched.rowCount !== 1) throw new Error('ASSIGNMENT_SWITCH_MISMATCH');
  } else if (assignment.form_version_id !== definition.formVersionId) {
    throw new Error('OTHER_FORM_VERSION_ASSIGNED');
  }
  phase = 'speaking_release';
  const speakingBlock = definition.blocks[2];
  if (releases.rowCount === 2) {
    await client.query(`INSERT INTO learning.assignment_block_release (
        assignment_id, block_id, checkpoint, status, release_version, updated_by_email, released_at
      ) VALUES ($1::uuid, $2::uuid, 3, 'locked', 1, $3, NULL);`, [
      assignment.id, speakingBlock.blockId, creator
    ]);
  }
  phase = 'readback';
  const readback = await client.query(`SELECT assignment.form_version_id,
      version.definition_hash,
      (SELECT count(*)::int FROM learning.form_assignment_roster
        WHERE assignment_id = assignment.id) AS roster_count,
      (SELECT count(*)::int FROM learning.assignment_block_release
        WHERE assignment_id = assignment.id) AS block_count,
      (SELECT count(*)::int FROM learning.attempt
        WHERE assignment_id = assignment.id) AS attempt_count
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE assignment.id = $1::uuid;`, [assignment.id]);
  const verified = readback.rows[0];
  if (!verified || verified.form_version_id !== definition.formVersionId
    || verified.definition_hash !== definitionHash
    || Number(verified.roster_count) < 1 || Number(verified.block_count) !== 3
    || (removeSingleTestAttempt && Number(verified.attempt_count) !== 0)) {
    throw new Error('UPGRADE_READBACK_MISMATCH');
  }
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({ ...plan, rosterCount: Number(verified.roster_count),
    blockCount: Number(verified.block_count), attemptCount: Number(verified.attempt_count),
    replayed: existingVersion.rowCount > 0 }) + '\n');
} catch (error) {
  if (client) await client.query('ROLLBACK');
  process.stderr.write(`UPGRADE_FAILED_${phase}:${error.code || error.message || 'UNKNOWN'}\n`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
