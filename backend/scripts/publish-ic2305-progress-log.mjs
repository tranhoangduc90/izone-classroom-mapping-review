/*
 * Dữ liệu nhận vào: mã lớp, số buổi, email người soạn/người duyệt và LEARNING_DATABASE_URL.
 * Xử lý: kiểm quyền và roster, ghi mẫu/đáp án riêng tư bất biến, tạo assignment idempotent trong một transaction.
 * Kết quả: public token để dashboard tạo link học viên; không in tên hay câu trả lời học viên.
 * Khi lỗi: rollback toàn bộ và chỉ báo mã lỗi an toàn, không in connection string.
 */

import pg from 'pg';
import {
  buildIc2305EntranceDefinition,
  buildIc2305EntranceGradingKey,
  IC2305_ENTRANCE_TEMPLATE
} from '../src/learning-templates/ic2305-entrance-reading1-listening1.js';
import {
  buildIc2305Writing1Definition,
  buildIc2305Writing1GradingKey,
  IC2305_WRITING1_TEMPLATE
} from '../src/learning-templates/ic2305-entrance-writing1.js';
import {
  buildIc2305Session3Definition,
  buildIc2305Session3GradingKey,
  IC2305_SESSION3_TEMPLATE
} from '../src/learning-templates/ic2305-entrance-listening1-speaking2.js';
import {
  buildIc2305Session4Definition,
  buildIc2305Session4GradingKey,
  IC2305_SESSION4_TEMPLATE
} from '../src/learning-templates/ic2305-session4-listening1-speaking2.js';
import { sha256, stableStringify } from '../src/learning-domain.js';
import { fetchLearningRosterForClassSql } from '../src/learning-sql.js';
import { retireReplacedIc2305Session4 } from '../src/learning-replacement.js';

const { Pool } = pg;

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const apply = process.argv.includes('--apply');
const classCode = option('class', 'IC2305').trim().toUpperCase();
const formCode = option('form', 'writing1').trim().toLowerCase();
const replacementAssignmentId = option('replace-assignment').trim().toLowerCase();
const selected = {
  writing1: {
    template: IC2305_WRITING1_TEMPLATE,
    buildDefinition: buildIc2305Writing1Definition,
    buildGradingKey: buildIc2305Writing1GradingKey,
    defaultSession: 2
  },
  'listening1-speaking2': {
    template: IC2305_SESSION3_TEMPLATE,
    buildDefinition: buildIc2305Session3Definition,
    buildGradingKey: buildIc2305Session3GradingKey,
    defaultSession: 3
  },
  'session4-listening1-speaking2': {
    template: IC2305_SESSION4_TEMPLATE,
    buildDefinition: buildIc2305Session4Definition,
    buildGradingKey: buildIc2305Session4GradingKey,
    defaultSession: 4
  },
  'reading1-listening1': {
    template: IC2305_ENTRANCE_TEMPLATE,
    buildDefinition: buildIc2305EntranceDefinition,
    buildGradingKey: buildIc2305EntranceGradingKey,
    defaultSession: 4
  }
}[formCode];
if (!selected) throw new Error('FORM_CODE_NOT_SUPPORTED');
const sessionNumber = Number(option('session', String(selected.defaultSession)));
const creatorEmail = option('creator').trim().toLowerCase();
const approverEmail = option('approver').trim().toLowerCase();
const template = selected.template;
const definition = selected.buildDefinition();
const gradingKey = selected.buildGradingKey();
const definitionHash = sha256(stableStringify(definition));
const gradingHash = sha256(stableStringify(gradingKey));

if (!Number.isInteger(sessionNumber) || sessionNumber < 1 || sessionNumber > 100) {
  throw new Error('INVALID_SESSION_NUMBER');
}
if (replacementAssignmentId && (formCode !== 'session4-listening1-speaking2'
  || classCode !== 'IC2305' || sessionNumber !== 4
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(replacementAssignmentId))) {
  throw new Error('INVALID_REPLACEMENT_REQUEST');
}

const plan = {
  mode: apply ? 'apply' : 'plan',
  templateCode: template.code,
  classCode,
  sessionNumber,
  formVersionId: definition.formVersionId,
  definitionHash,
  blocks: definition.blocks.length,
  items: definition.blocks.flatMap(block => block.items).length,
  scoredItems: definition.blocks.flatMap(block => block.items).filter(item => item.maxScore > 0).length,
  answerReleasePolicy: definition.answerReleasePolicy,
  replacementAssignmentId: replacementAssignmentId || null
};

if (!apply) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');
if (!creatorEmail || !approverEmail) throw new Error('CREATOR_AND_APPROVER_REQUIRED');

const pool = new Pool({
  connectionString: process.env.LEARNING_DATABASE_URL,
  max: 1,
  application_name: 'izone_publish_ic2305_progress_log'
});
const client = await pool.connect();
let phase = 'begin';

try {
  await client.query('BEGIN');
  phase = 'accounts';
  const reviewerEmails = [...new Set([creatorEmail, approverEmail])];
  const accounts = await client.query(`SELECT email
    FROM mapping.reviewer_account
    WHERE status = 'active' AND email = ANY($1::text[]);`, [reviewerEmails]);
  if (accounts.rowCount !== reviewerEmails.length) throw new Error('CREATOR_OR_APPROVER_NOT_ACTIVE');

  if (creatorEmail === approverEmail) {
    const authority = await client.query(`SELECT 1
      FROM learning.course_content_authority
      WHERE reviewer_email = $1
        AND course_code = $2
        AND can_self_approve_scored_forms = true
        AND status = 'active';`, [creatorEmail, template.courseCode]);
    if (authority.rowCount !== 1) throw new Error('COURSE_LEAD_SELF_APPROVAL_NOT_GRANTED');
  }

  const classResult = await client.query(`SELECT course.erp_course_class_id::text AS class_id,
      course.erp_class_name_snapshot AS class_name
    FROM mapping.classroom_course_mapping AS course
    WHERE upper(trim(course.erp_class_name_snapshot)) = $1
      AND EXISTS (
        SELECT 1 FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = $2
          AND access.erp_course_class_id = course.erp_course_class_id
      );`, [classCode, creatorEmail]);
  if (classResult.rowCount !== 1) throw new Error('CLASS_NOT_FOUND_OR_CREATOR_NOT_ASSIGNED');
  const targetClass = classResult.rows[0];
  phase = 'advisory_lock';
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0));`, [
    `learning:publish:${definition.formVersionId}:${targetClass.class_id}:${sessionNumber}`
  ]);
  phase = 'roster';
  const roster = await client.query(fetchLearningRosterForClassSql, [targetClass.class_id]);
  if (!roster.rowCount) throw new Error('CLASS_ROSTER_EMPTY');

  phase = 'template';
  await client.query(`INSERT INTO learning.form_template (
      id, organization_key, title, kind, created_by_email, status
    ) VALUES ($1::uuid, 'izone', $2, 'mixed', $3, 'active')
    ON CONFLICT (id) DO NOTHING;`, [
    template.templateId,
    template.title,
    creatorEmail
  ]);

  phase = 'version';
  const existingVersion = await client.query(`SELECT definition_hash
    FROM learning.form_version WHERE id = $1::uuid;`, [definition.formVersionId]);
  if (existingVersion.rowCount && existingVersion.rows[0].definition_hash !== definitionHash) {
    throw new Error('FORM_VERSION_HASH_CONFLICT');
  }
  if (!existingVersion.rowCount) {
    await client.query(`INSERT INTO learning.form_version (
        id, template_id, version, schema_version, public_definition, definition_hash,
        status, created_by_email, approved_by_email, published_at
      ) VALUES ($1::uuid, $2::uuid, 1, 'FormDefinitionV1', $3::jsonb, $4,
        'published', $5, $6, now());`, [
      definition.formVersionId,
    template.templateId,
      JSON.stringify(definition),
      definitionHash,
      creatorEmail,
      approverEmail
    ]);
    await client.query(`INSERT INTO learning.form_grading_key (
        form_version_id, schema_version, grader_version, private_definition, content_hash
      ) VALUES ($1::uuid, 'FormGradingKeyV1', 1, $2::jsonb, $3);`, [
      definition.formVersionId,
      JSON.stringify(gradingKey),
      gradingHash
    ]);
  } else {
    const existingKey = await client.query(`SELECT content_hash
      FROM learning.form_grading_key WHERE form_version_id = $1::uuid;`, [definition.formVersionId]);
    if (existingKey.rowCount !== 1 || existingKey.rows[0].content_hash !== gradingHash) {
      throw new Error('GRADING_KEY_HASH_CONFLICT');
    }
  }

  phase = 'assignment';
  const existingAssignment = await client.query(`SELECT id::text AS assignment_id, public_token::text
    FROM learning.form_assignment
    WHERE form_version_id = $1::uuid
      AND erp_course_class_id = $2::bigint
      AND session_number = $3
      AND status IN ('draft', 'published', 'closed')
    ORDER BY created_at DESC LIMIT 1;`, [definition.formVersionId, targetClass.class_id, sessionNumber]);

  let assignment = existingAssignment.rows[0];
  if (!assignment) {
    const created = await client.query(`INSERT INTO learning.form_assignment (
        form_version_id, course_code, erp_course_class_id, class_name_snapshot,
        session_number, title, status, created_by_email
      ) VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, 'published', $7)
      RETURNING id::text AS assignment_id, public_token::text;`, [
      definition.formVersionId,
      template.courseCode,
      targetClass.class_id,
      targetClass.class_name,
      sessionNumber,
      template.title,
      creatorEmail
    ]);
    assignment = created.rows[0];
    for (const student of roster.rows) {
      await client.query(`INSERT INTO learning.form_assignment_roster (
          assignment_id, student_ref, erp_student_contact_id, student_name_snapshot, display_discriminator
        ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5);`, [
        assignment.assignment_id,
        student.student_ref,
        student.student_id,
        student.student_name,
        student.display_discriminator
      ]);
    }
    for (const block of definition.blocks) {
      await client.query(`INSERT INTO learning.assignment_block_release (
          assignment_id, block_id, checkpoint, status, release_version, updated_by_email, released_at
        ) VALUES ($1::uuid, $2::uuid, $3, 'open', 1, $4, now());`, [
        assignment.assignment_id,
        block.blockId,
        block.checkpoint,
        creatorEmail
      ]);
    }
  }

  phase = 'readback';
  const readback = await client.query(`SELECT assignment.id::text AS assignment_id,
      assignment.public_token::text AS public_token,
      assignment.class_name_snapshot AS class_name,
      assignment.session_number,
      version.definition_hash,
      (SELECT count(*)::int FROM learning.form_assignment_roster AS roster
        WHERE roster.assignment_id = assignment.id) AS roster_count,
      (SELECT count(*)::int FROM learning.assignment_block_release AS release
        WHERE release.assignment_id = assignment.id AND release.status = 'open') AS open_blocks
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE assignment.id = $1::uuid;`, [assignment.assignment_id]);
  const verified = readback.rows[0];
  const replayed = Boolean(existingAssignment.rowCount);
  if (!verified || verified.definition_hash !== definitionHash
    || Number(verified.roster_count) < 1
    || (!replayed && Number(verified.roster_count) !== roster.rowCount)
    || (!replayed && Number(verified.open_blocks) !== definition.blocks.length)) {
    throw new Error('PUBLISH_READBACK_MISMATCH');
  }
  let replacement = null;
  if (replacementAssignmentId) {
    phase = 'replacement_check';
    replacement = await retireReplacedIc2305Session4({ client, replacementAssignmentId,
      newAssignmentId: assignment.assignment_id, classId: targetClass.class_id });
  }
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({
    ...plan,
    assignmentId: verified.assignment_id,
    publicToken: verified.public_token,
    className: verified.class_name,
    rosterCount: Number(verified.roster_count),
    openBlocks: Number(verified.open_blocks),
    replacement,
    replayed
  }, null, 2)}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  process.stderr.write(`PUBLISH_FAILED_${phase}:${error.code || 'UNKNOWN'}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
