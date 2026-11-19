const slug = 'mini-test-k56';
const modes = new Set(['off', 'on', 'drain']);

export function miniPaperParallelMode(value=process.env.K56_MINI_PAPER_PARALLEL_ENTRY_MODE || 'off') {
  if (!modes.has(value)) throw new Error('Invalid K56_MINI_PAPER_PARALLEL_ENTRY_MODE');
  return value;
}

export function isMiniPaper(row) {
  return row?.test_slug === slug && row.attempt_mode === 'answer_sheet';
}

export async function lockMiniPaperCandidate(client, token) {
  const {rows:[scope]} = await client.query(
    "SELECT erp_course_class_id::text AS class_id,erp_student_contact_id::text AS student_id FROM assessment.term_test_attempt"
      + " WHERE id=$1 AND test_slug=$2 AND attempt_mode='answer_sheet' AND superseded_at IS NULL", [token,slug]);
  if (scope) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    ['k56:'+slug+':'+scope.class_id+':'+scope.student_id]);
}

export async function findMiniPaperOfficial(client, scope) {
  if (!isMiniPaper(scope)) return null;
  const {rows:[row]} = await client.query(
    "SELECT id::text AS attempt_token, definition_version,generation,listening_submitted_at,reading_submitted_at"
    + " FROM assessment.term_test_attempt WHERE test_slug=$1 AND attempt_mode='answer_sheet' AND superseded_at IS NULL"
    + " AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND ($4::bigint IS NULL OR generation=$4)"
    + " AND (listening_submitted_at IS NOT NULL OR reading_submitted_at IS NOT NULL)"
    + " ORDER BY mini_paper_official_submission DESC,least(listening_submitted_at,reading_submitted_at),id LIMIT 1",
    [slug,scope.class_id,scope.student_id,scope.generation ?? null]);
  return row ?? null;
}
