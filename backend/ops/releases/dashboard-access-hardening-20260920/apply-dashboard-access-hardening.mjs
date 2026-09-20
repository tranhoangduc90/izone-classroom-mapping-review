import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [rootDirectory = '/app', manifestPath = '/tmp/dashboard-access-manifest.json'] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function replaceExact(source, before, after, expectedCount, label) {
  const actualCount = source.split(before).length - 1;
  if (actualCount !== expectedCount) throw new Error(`replacement_count_mismatch:${label}:${actualCount}`);
  return source.split(before).join(after);
}

const helperImport = "import { buildTeacherClassAccessPredicate } from './teacher-class-access-sql.js';\n\n";
const coreAccess = `      OR EXISTS (
        SELECT 1
        FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = input.reviewer_email
          AND access.erp_course_class_id = r.erp_course_class_id
      )`;
const coreEffective = `      OR \${buildTeacherClassAccessPredicate({
        reviewerEmailSql: 'input.reviewer_email',
        classIdSql: 'r.erp_course_class_id'
      })}`;
const termTargetAccess = `    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $3
        AND access.erp_course_class_id = target.erp_course_class_id
    )`;
const termTargetEffective = `    OR \${buildTeacherClassAccessPredicate({
      reviewerEmailSql: '$3',
      classIdSql: 'target.erp_course_class_id'
    })}`;
const courseAccess1 = `    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $1
        AND access.erp_course_class_id = course.erp_course_class_id
    )`;
const courseEffective1 = `    OR \${buildTeacherClassAccessPredicate({
      reviewerEmailSql: '$1',
      classIdSql: 'course.erp_course_class_id'
    })}`;
const portalJoin = `  JOIN mapping.reviewer_class_access AS access
    ON access.reviewer_email = $1
   AND access.erp_course_class_id = course.erp_course_class_id
   AND access.portal_teacher_contact_id IS NOT NULL
  LEFT JOIN portal_class_metadata AS metadata
    ON metadata.erp_course_class_id = course.erp_course_class_id`;
const effectivePortalJoin = `  LEFT JOIN mapping.reviewer_class_access AS access
    ON access.reviewer_email = $1
   AND access.erp_course_class_id = course.erp_course_class_id
   AND access.portal_teacher_contact_id IS NOT NULL
  LEFT JOIN portal_class_metadata AS metadata
    ON metadata.erp_course_class_id = course.erp_course_class_id
  WHERE access.portal_teacher_contact_id IS NOT NULL
    OR \${buildTeacherClassAccessPredicate({
      reviewerEmailSql: '$1',
      classIdSql: 'course.erp_course_class_id'
    })}`;

const assignmentAccessCompact = (emailPlaceholder) => `      OR EXISTS (
        SELECT 1 FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = ${emailPlaceholder}
          AND access.erp_course_class_id = assignment.erp_course_class_id
      )`;
const assignmentAccess = (emailPlaceholder, indent = '    ') => `${indent}OR EXISTS (
${indent}  SELECT 1
${indent}  FROM mapping.reviewer_class_access AS access
${indent}  WHERE access.reviewer_email = ${emailPlaceholder}
${indent}    AND access.erp_course_class_id = assignment.erp_course_class_id
${indent})`;
const assignmentEffective = (emailPlaceholder, indent = '    ') => `${indent}OR \${buildTeacherClassAccessPredicate({
${indent}  reviewerEmailSql: '${emailPlaceholder}',
${indent}  classIdSql: 'assignment.erp_course_class_id'
${indent}})}`;

async function transformSql() {
  const relativePath = 'src/sql.js';
  const absolutePath = path.join(rootDirectory, relativePath);
  const expected = manifest[relativePath];
  let source = (await readFile(absolutePath, 'utf8')).replace(/\r\n/g, '\n');
  if (sha256(source) !== expected.before) throw new Error(`baseline_hash_mismatch:${relativePath}`);
  source = helperImport + source;
  source = replaceExact(source, coreAccess, coreEffective, 2, 'mapping-core');
  source = replaceExact(source, portalJoin, effectivePortalJoin, 1, 'k67-options');
  source = replaceExact(source, courseAccess1, courseEffective1, 1, 'legacy-options');
  source = replaceExact(source, termTargetAccess, termTargetEffective, 3, 'term-detail-gates');
  if (sha256(source) !== expected.after) throw new Error(`target_hash_mismatch:${relativePath}:${sha256(source)}`);
  await writeFile(absolutePath, source, 'utf8');
}

async function transformLearningSql() {
  const relativePath = 'src/learning-sql.js';
  const absolutePath = path.join(rootDirectory, relativePath);
  const expected = manifest[relativePath];
  let source = (await readFile(absolutePath, 'utf8')).replace(/\r\n/g, '\n');
  if (sha256(source) !== expected.before) throw new Error(`baseline_hash_mismatch:${relativePath}`);
  source = helperImport + source;
  source = replaceExact(source, courseAccess1, courseEffective1, 2, 'learning-course-gates');
  source = replaceExact(
    source,
    assignmentAccessCompact('$5'),
    assignmentEffective('$5', '      '),
    2,
    'learning-assignment-compact-email5'
  );
  source = replaceExact(
    source,
    assignmentAccessCompact('$6'),
    assignmentEffective('$6', '      '),
    1,
    'learning-assignment-compact-email6'
  );
  source = replaceExact(source, assignmentAccess('$3'), assignmentEffective('$3'), 1, 'learning-assignment-email3');
  source = replaceExact(source, assignmentAccess('$2'), assignmentEffective('$2'), 1, 'learning-dashboard-email2');
  source = replaceExact(
    source,
    assignmentAccess('$2', '      '),
    assignmentEffective('$2', '      '),
    1,
    'learning-live-email2'
  );
  source = replaceExact(
    source,
    assignmentAccess('$5', '      '),
    assignmentEffective('$5', '      '),
    1,
    'learning-attendance-email5'
  );
  if (sha256(source) !== expected.after) throw new Error(`target_hash_mismatch:${relativePath}:${sha256(source)}`);
  await writeFile(absolutePath, source, 'utf8');
}

await transformSql();
await transformLearningSql();
console.log('Dashboard access hardening applied with verified source hashes.');
