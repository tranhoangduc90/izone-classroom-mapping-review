import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const baseUrl = String(process.env.TEACHER_DASHBOARD_CANARY_BASE_URL || 'https://ducizone.ddns.net/mapping-api').replace(/\/+$/, '');
const reviewerEmail = String(process.env.TEACHER_DASHBOARD_CANARY_EMAIL || 'dashboard-canary@synthetic.invalid').trim().toLowerCase();
const cookieName = String(process.env.TEACHER_SESSION_COOKIE_NAME || 'izone_teacher_session');
const allowedOrigin = String(process.env.TEACHER_DASHBOARD_CANARY_ORIGIN || 'https://tranhoangduc90.github.io');

function requireDatabaseUrl(name) {
  if (!process.env[name]) throw new Error(`${name}_REQUIRED`);
  return process.env[name];
}

async function requestJson(path, cookie, expectedStatus = 200, options = {}) {
  const endpoint = String(path).split('?', 1)[0];
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      cookie,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    throw new Error(`CANARY_RESPONSE_NOT_JSON:${endpoint}`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`CANARY_HTTP_${response.status}:${endpoint}:${String(body?.error || 'UNKNOWN')}`);
  }
  return body;
}

function queryString(values) {
  return new URLSearchParams(values).toString();
}

// Dữ liệu nhận vào: account canary và hai lớp demo có sẵn trong database.
// Việc chính: tạo phiên tạm, gọi chuỗi API Term/Mini và Progress, thử lớp ngoài quyền, rồi đăng xuất.
// Kết quả: chỉ in số đếm và trạng thái; không in cookie, email, tên lớp hay dữ liệu học viên.
// Khi lỗi: phiên tạm vẫn bị xóa trong finally và tiến trình trả exit code khác 0.
async function run() {
  const pool = new Pool({
    connectionString: requireDatabaseUrl('DATABASE_URL'),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    application_name: 'teacher_dashboard_canary'
  });
  const learningPool = new Pool({
    connectionString: requireDatabaseUrl('LEARNING_DATABASE_URL'),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    application_name: 'teacher_dashboard_canary_learning'
  });
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest();
  const cookie = `${cookieName}=${encodeURIComponent(rawToken)}`;
  const startedAt = Date.now();

  try {
    const fixture = await pool.query(`WITH term_candidate AS (
      SELECT course.erp_course_class_id, course.erp_class_name_snapshot, roster.test_slug,
             roster.student_ref, 1::smallint AS task_number
      FROM mapping.classroom_course_mapping AS course
      JOIN assessment.term_test_roster AS roster
        ON roster.erp_course_class_id = course.erp_course_class_id
      JOIN assessment.test_definition AS definition
        ON definition.slug = roster.test_slug AND definition.is_active = true
      JOIN assessment.term_test_attempt AS attempt
        ON attempt.test_slug = roster.test_slug
       AND attempt.erp_course_class_id = roster.erp_course_class_id
       AND attempt.erp_student_contact_id = roster.erp_student_contact_id
       AND attempt.completed_at IS NOT NULL
       AND attempt.writing_submitted_at IS NOT NULL
      JOIN assessment.term_test_writing_grading_final AS final
        ON final.attempt_id = attempt.id AND final.status = 'ready'
      JOIN assessment.term_test_writing_grading_run AS grading
        ON grading.id = final.task_1_run_id AND grading.status = 'complete'
      WHERE course.erp_course_class_id = -8062028
      ORDER BY attempt.completed_at DESC
      LIMIT 1
    ), forbidden_term AS (
      SELECT course.erp_class_name_snapshot
      FROM mapping.classroom_course_mapping AS course
      JOIN assessment.term_test_roster AS roster USING (erp_course_class_id)
      WHERE course.erp_course_class_id <> -8062028
      ORDER BY course.erp_course_class_id
      LIMIT 1
    )
    SELECT reviewer.google_subject, term_candidate.*,
           forbidden_term.erp_class_name_snapshot AS forbidden_term_class
    FROM mapping.reviewer_account AS reviewer
    CROSS JOIN term_candidate
    CROSS JOIN forbidden_term
    WHERE reviewer.email = $1 AND reviewer.status = 'active' AND NOT reviewer.can_access_all_classes;`, [reviewerEmail]);
    if (fixture.rowCount !== 1) throw new Error('CANARY_FIXTURE_NOT_READY');
    const progressFixture = await learningPool.query(`WITH progress_candidate AS (
      SELECT assignment.id
      FROM learning.form_assignment AS assignment
      WHERE assignment.erp_course_class_id = 990000567
      ORDER BY assignment.created_at DESC
      LIMIT 1
    ), forbidden_progress AS (
      SELECT assignment.id
      FROM learning.form_assignment AS assignment
      WHERE assignment.erp_course_class_id <> 990000567
      ORDER BY assignment.created_at DESC
      LIMIT 1
    )
    SELECT progress_candidate.id::text AS progress_assignment_id,
           forbidden_progress.id::text AS forbidden_progress_assignment_id
    FROM progress_candidate CROSS JOIN forbidden_progress;`);
    if (progressFixture.rowCount !== 1) throw new Error('CANARY_PROGRESS_FIXTURE_NOT_READY');
    const target = { ...fixture.rows[0], ...progressFixture.rows[0] };

    await pool.query(`INSERT INTO mapping.reviewer_session (
      token_hash, reviewer_email, google_subject, idle_expires_at, absolute_expires_at
    ) VALUES ($1, $2, $3, now() + interval '15 minutes', now() + interval '15 minutes');`, [
      tokenHash, reviewerEmail, target.google_subject
    ]);

    const session = await requestJson('/api/auth/session', cookie);
    if (!session.ok || session.reviewer?.canAccessAllClasses) throw new Error('CANARY_SESSION_SCOPE_INVALID');

    const termOptions = await requestJson('/api/term-tests/teacher/options', cookie);
    if (!termOptions.classes?.some(item => String(item.id) === String(target.erp_course_class_id))) {
      throw new Error('CANARY_TERM_CLASS_MISSING');
    }
    const termQuery = queryString({ class: target.erp_class_name_snapshot, test: target.test_slug });
    const termResults = await requestJson(`/api/term-tests/teacher/results?${termQuery}`, cookie);
    if (!Array.isArray(termResults.students) || termResults.students.length === 0) throw new Error('CANARY_TERM_ROSTER_EMPTY');

    const detailQuery = queryString({
      class: target.erp_class_name_snapshot,
      test: target.test_slug,
      student: target.student_ref,
      task: String(target.task_number)
    });
    const writingDetail = await requestJson(`/api/term-tests/teacher/writing-detail?${detailQuery}`, cookie);
    if (!writingDetail.writing || !Array.isArray(writingDetail.writing.criteria)) throw new Error('CANARY_WRITING_DETAIL_EMPTY');
    const attemptReview = await requestJson(`/api/term-tests/teacher/attempt-review?${detailQuery}`, cookie);
    if (!attemptReview.review) throw new Error('CANARY_ATTEMPT_REVIEW_EMPTY');

    const deniedTerm = await requestJson(`/api/term-tests/teacher/results?${queryString({
      class: target.forbidden_term_class,
      test: target.test_slug
    })}`, cookie, 403);
    if (deniedTerm.error !== 'ACCESS_DENIED') throw new Error('CANARY_TERM_NEGATIVE_GATE_FAILED');

    const progressOptions = await requestJson('/api/learning/teacher/options', cookie);
    if (!progressOptions.assignments?.some(item => item.assignment_id === target.progress_assignment_id)) {
      throw new Error('CANARY_PROGRESS_ASSIGNMENT_MISSING');
    }
    const assignmentQuery = queryString({ assignment: target.progress_assignment_id });
    const dashboard = await requestJson(`/api/learning/teacher/dashboard?${assignmentQuery}`, cookie);
    if (!Array.isArray(dashboard.dashboard?.students) || dashboard.dashboard.students.length === 0) {
      throw new Error('CANARY_PROGRESS_DASHBOARD_EMPTY');
    }
    const live = await requestJson(`/api/learning/teacher/live-drafts?${assignmentQuery}`, cookie);
    if (!Array.isArray(live.live?.students) || live.live.students.length === 0) {
      throw new Error('CANARY_PROGRESS_LIVE_EMPTY');
    }
    const deniedProgress = await requestJson(`/api/learning/teacher/dashboard?${queryString({
      assignment: target.forbidden_progress_assignment_id
    })}`, cookie, 404);
    if (deniedProgress.error !== 'ASSIGNMENT_ACCESS_DENIED') throw new Error('CANARY_PROGRESS_NEGATIVE_GATE_FAILED');

    await requestJson('/api/auth/session', cookie, 200, {
      method: 'DELETE',
      headers: { origin: allowedOrigin, 'x-izone-csrf': '1' }
    });
    const revoked = await pool.query(`SELECT revoked_at IS NOT NULL AS revoked
      FROM mapping.reviewer_session WHERE token_hash = $1;`, [tokenHash]);
    if (revoked.rowCount !== 1 || !revoked.rows[0].revoked) throw new Error('CANARY_LOGOUT_NOT_REVOKED');

    return {
      schemaVersion: 1,
      outcome: 'healthy',
      durationMs: Date.now() - startedAt,
      checks: {
        sessionRestore: true,
        termClassCount: termOptions.classes.length,
        termStudentCount: termResults.students.length,
        writingDetail: true,
        attemptReview: true,
        termNegativeGate: true,
        progressAssignmentCount: progressOptions.assignments.length,
        progressStudentCount: dashboard.dashboard.students.length,
        progressLiveStudentCount: live.live.students.length,
        progressNegativeGate: true,
        logoutRevoked: true
      }
    };
  } finally {
    await pool.query('DELETE FROM mapping.reviewer_session WHERE token_hash = $1;', [tokenHash]).catch(() => {});
    await Promise.all([pool.end(), learningPool.end()]);
  }
}

try {
  console.log(JSON.stringify(await run()));
} catch (error) {
  console.error(JSON.stringify({
    schemaVersion: 1,
    outcome: 'failure',
    error: String(error?.message || 'CANARY_FAILED').split(':').slice(0, 3).join(':')
  }));
  process.exitCode = 2;
}
