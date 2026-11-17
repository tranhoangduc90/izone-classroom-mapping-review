const slug = 'term-test-2-k56';
const skills = ['listening', 'reading', 'writing'];
const validMode = new Set(['off', 'on', 'drain']);

export function term2ParallelMode(value = process.env.K56_TERM2_PARALLEL_ENTRY_MODE || 'off') {
  if (!validMode.has(value)) throw new Error('Invalid K56_TERM2_PARALLEL_ENTRY_MODE');
  return value;
}

export function finishedSkill(attempt, skill) {
  return Boolean(attempt?.[`${skill}_submitted_at`] || (skill === 'listening' && attempt?.listening_interrupted_at));
}

export function officialProgress(attempt) {
  if (!attempt) return null;
  return {
    listening: attempt.listening_submitted_at ? 'sealed' : attempt.listening_interrupted_at ? 'interrupted' : 'open',
    reading: finishedSkill(attempt, 'reading') ? 'sealed' : 'open',
    writing: finishedSkill(attempt, 'writing') ? 'sealed' : 'open',
  };
}

export async function lockTerm2Candidate(client, attemptToken) {
  const match = await client.query(`SELECT erp_course_class_id::text AS class_id,
    erp_student_contact_id::text AS student_id
    FROM assessment.term_test_attempt
    WHERE id=$1 AND test_slug=$2 AND attempt_mode='cbt' AND superseded_at IS NULL`, [attemptToken, slug]);
  const candidate = match.rows[0];
  if (candidate) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`k56:${slug}:${candidate.class_id}:${candidate.student_id}`]);
}

export async function findTerm2Official(client, attempt) {
  if (!attempt || attempt.test_slug !== slug || attempt.attempt_mode !== 'cbt') return null;
  const result = await client.query(`SELECT id::text AS attempt_token, listening_submitted_at,
    listening_interrupted_at, reading_submitted_at, writing_submitted_at
    FROM assessment.term_test_attempt
    WHERE test_slug=$1 AND attempt_mode='cbt' AND definition_version=$2
      AND erp_course_class_id=$3 AND erp_student_contact_id=$4 AND generation=$5
      AND superseded_at IS NULL AND (listening_submitted_at IS NOT NULL OR listening_interrupted_at IS NOT NULL
        OR reading_submitted_at IS NOT NULL OR writing_submitted_at IS NOT NULL)
    ORDER BY term2_official_submission DESC,
      least(listening_submitted_at,listening_interrupted_at,reading_submitted_at,writing_submitted_at), id
    LIMIT 1`, [slug, attempt.definition_version, attempt.class_id, attempt.student_id, attempt.generation]);
  return result.rows[0] || null;
}

export async function writeTerm2OfficialDraft(client, source, target, section, payload, revision) {
  if (!skills.includes(section)) throw new Error('Invalid Term 2 official skill');
  if (source.attempt_token === target.attempt_token) return;
  const { startedAt, deadlineAt } = payload;
  if (section === 'listening') {
    await client.query(`UPDATE assessment.term_test_exam_session
      SET listening_started_at=$2, listening_deadline_at=$3, listening_draft=$4::jsonb,
        listening_draft_revision=$5, listening_draft_updated_at=now(), updated_at=now() WHERE id=$1`,
    [target.exam_session_token, startedAt, deadlineAt, JSON.stringify(payload.answers ?? {}), revision]);
  } else if (section === 'reading') {
    await client.query(`UPDATE assessment.term_test_attempt
      SET reading_started_at=$2, reading_deadline_at=$3, reading_draft=$4::jsonb,
        reading_draft_revision=$5, reading_draft_updated_at=now(), updated_at=now() WHERE id=$1`,
    [target.attempt_token, startedAt, deadlineAt, JSON.stringify(payload.answers), revision]);
  } else {
    await client.query(`UPDATE assessment.term_test_attempt
      SET writing_started_at=$2, writing_deadline_at=$3, writing_task_1=$4,
        writing_draft_revision=$5, writing_draft_updated_at=now(), writing_updated_at=now(), updated_at=now() WHERE id=$1`,
    [target.attempt_token, startedAt, deadlineAt, payload.task1, revision]);
  }
}
