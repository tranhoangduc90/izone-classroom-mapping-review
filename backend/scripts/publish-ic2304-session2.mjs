/*
 * Dữ liệu nhận vào: tài khoản giảng viên có quyền lớp và kết nối PostgreSQL từ secret store.
 * Xử lý: kiểm lớp, roster, mẫu bất biến và phiếu trùng; chỉ ghi khi có --apply.
 * Kết quả: một assignment IC2304 Buổi 2, Listening mở và Writing khóa chờ giảng viên.
 * Khi lỗi: rollback toàn bộ và in mã lỗi; không in mật khẩu hay danh tính học viên.
 */

import pg from 'pg';
import {
  buildIc2304Session2Definition,
  buildIc2304Session2GradingKey,
  IC2304_SESSION2_TEMPLATE
} from '../src/learning-templates/ic2304-session2-listening-writing.js';
import { sha256, stableStringify } from '../src/learning-domain.js';
import { fetchLearningRosterForClassSql } from '../src/learning-sql.js';

const { Pool } = pg;
const classCode = 'IC2304';
const sessionNumber = 2;
const apply = process.argv.includes('--apply');

function argument(name) {
  const prefix = '--' + name + '=';
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || '';
}

let creatorEmail = argument('creator').trim().toLowerCase();
const requestedCourseCode = argument('course-code').trim();
const courseCode = IC2304_SESSION2_TEMPLATE.courseCode;
const definition = buildIc2304Session2Definition();
const gradingKey = buildIc2304Session2GradingKey();
const definitionHash = sha256(stableStringify(definition));
const gradingHash = sha256(stableStringify(gradingKey));

if (requestedCourseCode && requestedCourseCode !== courseCode) {
  throw new Error('INVALID_COURSE_CODE');
}

const plan = {
  mode: apply ? 'apply' : 'plan',
  templateCode: IC2304_SESSION2_TEMPLATE.code,
  classCode,
  sessionNumber,
  courseCode,
  formVersionId: definition.formVersionId,
  definitionHash,
  blocks: definition.blocks.map((block, index) => ({
    checkpoint: block.checkpoint,
    title: block.title,
    items: block.items.length,
    initialStatus: index === 0 ? 'open' : 'locked'
  })),
  scoredItems: 0,
  answerReleasePolicy: definition.answerReleasePolicy
};

if (!apply) {
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}
if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');

const pool = new Pool({
  connectionString: process.env.LEARNING_DATABASE_URL,
  max: 1,
  application_name: 'izone_publish_ic2304_session2'
});
let client;
let phase = 'begin';

try {
  phase = 'connect';
  client = await pool.connect();
  phase = 'begin';
  await client.query('BEGIN');

  phase = 'class_access';
  const targetResult = await client.query(`SELECT course.erp_course_class_id::text AS class_id,
      course.erp_class_name_snapshot AS class_name, reviewer.email AS creator_email
    FROM mapping.classroom_course_mapping AS course
    JOIN mapping.reviewer_account AS reviewer
      ON reviewer.status = 'active'
    WHERE upper(trim(course.erp_class_name_snapshot)) = $1
      AND ($2 = '' OR reviewer.email = $2)
      AND EXISTS (
        SELECT 1 FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = reviewer.email
          AND access.erp_course_class_id = course.erp_course_class_id
      );`, [classCode, creatorEmail]);
  if (targetResult.rowCount !== 1) throw new Error('CLASS_NOT_FOUND_OR_CREATOR_NOT_ASSIGNED');
  const targetClass = targetResult.rows[0];
  creatorEmail = targetClass.creator_email;

  phase = 'advisory_lock';
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0));', [
    'learning:publish:' + targetClass.class_id + ':' + sessionNumber
  ]);

  phase = 'roster';
  const roster = await client.query(fetchLearningRosterForClassSql, [targetClass.class_id]);
  if (!roster.rowCount) throw new Error('CLASS_ROSTER_EMPTY');
  if (new Set(roster.rows.map(student => student.student_ref)).size !== roster.rowCount) {
    throw new Error('ROSTER_IDENTITY_DUPLICATE');
  }
  const membership = await client.query(`SELECT count(*)::int AS matched_count,
      count(*) FILTER (WHERE source_state IS DISTINCT FROM 'active'
        OR lower(trim(coalesce(registration_status, ''))) <> 'on_going')::int AS inactive_count
    FROM mapping.erp_class_membership_snapshot
    WHERE erp_course_class_id = $1::bigint
      AND erp_student_contact_id = ANY($2::bigint[]);`, [
    targetClass.class_id,
    roster.rows.map(student => student.student_id)
  ]);
  if (Number(membership.rows[0]?.matched_count) !== roster.rowCount) {
    throw new Error('ROSTER_STATUS_COVERAGE_INCOMPLETE');
  }
  if (Number(membership.rows[0]?.inactive_count) !== 0) {
    throw new Error('ROSTER_INCLUDES_INACTIVE_STUDENTS');
  }

  phase = 'existing_assignment';
  const previous = await client.query(`SELECT id::text AS assignment_id,
      public_token::text AS public_token,
      form_version_id::text AS form_version_id,
      course_code,
      status
    FROM learning.form_assignment
    WHERE erp_course_class_id = $1::bigint
      AND session_number = $2
      AND status IN ('draft', 'published', 'closed')
    ORDER BY created_at DESC
    LIMIT 2;`, [targetClass.class_id, sessionNumber]);
  if (previous.rowCount > 1) throw new Error('MULTIPLE_ASSIGNMENTS_FOR_SESSION');
  if (previous.rowCount === 1
    && previous.rows[0].form_version_id !== definition.formVersionId) {
    throw new Error('OTHER_ASSIGNMENT_FOR_SESSION_EXISTS');
  }
  if (previous.rowCount === 1 && previous.rows[0].status !== 'published') {
    throw new Error('EXISTING_ASSIGNMENT_NOT_PUBLISHED');
  }
  if (previous.rowCount === 1 && previous.rows[0].course_code !== courseCode) {
    if (previous.rows[0].course_code !== null) throw new Error('OTHER_COURSE_CODE_EXISTS');
    const attempts = await client.query(
      'SELECT count(*)::int AS total FROM learning.attempt WHERE assignment_id = $1::uuid;',
      [previous.rows[0].assignment_id]
    );
    if (Number(attempts.rows[0]?.total) !== 0) throw new Error('COURSE_CODE_CHANGE_AFTER_ATTEMPT');
    await client.query(`UPDATE learning.form_assignment
      SET course_code = $2, updated_at = now()
      WHERE id = $1::uuid AND course_code IS NULL;`, [
      previous.rows[0].assignment_id, courseCode
    ]);
  }

  phase = 'template';
  await client.query(`INSERT INTO learning.form_template (
      id, organization_key, title, kind, created_by_email, status
    ) VALUES ($1::uuid, 'izone', $2, 'mixed', $3, 'active')
    ON CONFLICT (id) DO NOTHING;`, [
    IC2304_SESSION2_TEMPLATE.templateId,
    IC2304_SESSION2_TEMPLATE.title,
    creatorEmail
  ]);

  phase = 'version';
  const version = await client.query(
    'SELECT definition_hash FROM learning.form_version WHERE id = $1::uuid;',
    [definition.formVersionId]
  );
  if (version.rowCount && version.rows[0].definition_hash !== definitionHash) {
    throw new Error('FORM_VERSION_HASH_CONFLICT');
  }
  if (!version.rowCount) {
    await client.query(`INSERT INTO learning.form_version (
        id, template_id, version, schema_version, public_definition, definition_hash,
        status, created_by_email, approved_by_email, published_at
      ) VALUES ($1::uuid, $2::uuid, 1, 'FormDefinitionV1', $3::jsonb, $4,
        'published', $5, $5, now());`, [
      definition.formVersionId,
      IC2304_SESSION2_TEMPLATE.templateId,
      JSON.stringify(definition),
      definitionHash,
      creatorEmail
    ]);
    await client.query(`INSERT INTO learning.form_grading_key (
        form_version_id, schema_version, grader_version, private_definition, content_hash
      ) VALUES ($1::uuid, 'FormGradingKeyV1', 1, $2::jsonb, $3);`, [
      definition.formVersionId,
      JSON.stringify(gradingKey),
      gradingHash
    ]);
  } else {
    const existingKey = await client.query(
      'SELECT content_hash FROM learning.form_grading_key WHERE form_version_id = $1::uuid;',
      [definition.formVersionId]
    );
    if (existingKey.rowCount !== 1 || existingKey.rows[0].content_hash !== gradingHash) {
      throw new Error('GRADING_KEY_HASH_CONFLICT');
    }
  }

  phase = 'assignment';
  let assignment = previous.rows[0];
  if (!assignment) {
    const created = await client.query(`INSERT INTO learning.form_assignment (
        form_version_id, course_code, erp_course_class_id, class_name_snapshot,
        session_number, title, status, created_by_email
      ) VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, 'published', $7)
      RETURNING id::text AS assignment_id, public_token::text AS public_token;`, [
      definition.formVersionId,
      courseCode,
      targetClass.class_id,
      targetClass.class_name,
      sessionNumber,
      definition.title,
      creatorEmail
    ]);
    assignment = created.rows[0];

    for (const student of roster.rows) {
      await client.query(`INSERT INTO learning.form_assignment_roster (
          assignment_id, student_ref, erp_student_contact_id, student_name_snapshot,
          display_discriminator
        ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5);`, [
        assignment.assignment_id,
        student.student_ref,
        student.student_id,
        student.student_name,
        student.display_discriminator
      ]);
    }
    for (const [index, block] of definition.blocks.entries()) {
      const status = index === 0 ? 'open' : 'locked';
      await client.query(`INSERT INTO learning.assignment_block_release (
          assignment_id, block_id, checkpoint, status, release_version,
          updated_by_email, released_at
        ) VALUES ($1::uuid, $2::uuid, $3, $4, 1, $5,
          CASE WHEN $4 = 'open' THEN now() ELSE NULL END);`, [
        assignment.assignment_id,
        block.blockId,
        block.checkpoint,
        status,
        creatorEmail
      ]);
    }
  }

  phase = 'readback';
  const result = await client.query(`SELECT assignment.id::text AS assignment_id,
      assignment.public_token::text AS public_token,
      assignment.class_name_snapshot AS class_name,
      assignment.course_code,
      assignment.session_number,
      version.definition_hash,
      (SELECT count(*)::int FROM learning.form_assignment_roster AS roster
        WHERE roster.assignment_id = assignment.id) AS roster_count,
      (SELECT count(*)::int FROM learning.assignment_block_release AS release
        WHERE release.assignment_id = assignment.id) AS block_count
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE assignment.id = $1::uuid;`, [assignment.assignment_id]);
  const verified = result.rows[0];
  const replayed = Boolean(previous.rowCount);
  if (!verified || verified.definition_hash !== definitionHash
    || verified.class_name.toUpperCase() !== classCode
    || verified.course_code !== courseCode
    || Number(verified.session_number) !== sessionNumber
    || Number(verified.block_count) !== definition.blocks.length
    || (!replayed && Number(verified.roster_count) !== roster.rowCount)) {
    throw new Error('PUBLISH_READBACK_MISMATCH');
  }

  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({
    ...plan,
    assignmentId: verified.assignment_id,
    publicToken: verified.public_token,
    rosterCount: Number(verified.roster_count),
    replayed
  }, null, 2) + '\n');
} catch (error) {
  if (client) await client.query('ROLLBACK');
  process.stderr.write('PUBLISH_FAILED_' + phase + ':' + (error.code || error.message || 'UNKNOWN') + '\n');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
