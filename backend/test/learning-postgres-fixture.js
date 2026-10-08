import pg from 'pg';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createLearningService } from '../src/learning-service.js';

// Chỉ tạo database ngắn hạn trên loopback dành riêng cho ca kiểm, không nhận URL production.
export async function postgresFixture({ clock = null } = {}) {
  const url = new URL(process.env.PROGRESS_LOG_FIXTURE_URL || 'postgresql://missing');
  if (url.hostname !== '127.0.0.1' || url.port !== '16547' || url.pathname !== '/progress_log_fixture') {
    throw new Error('Cần PostgreSQL fixture riêng trên 127.0.0.1:16547.');
  }
  const admin = new pg.Pool({ connectionString: url.toString() });
  const name = `pl_fixture_${crypto.randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 24 });
  try {
  await pool.query(await readFile(new URL('../ops/learning-demo/mapping-fixture.sql', import.meta.url), 'utf8'));
  await pool.query(`INSERT INTO mapping.classroom_course_mapping VALUES (2139, 'Lớp kiểm PostgreSQL');
    INSERT INTO mapping.reviewer_account VALUES ('teacher@example.test', 'active');
    INSERT INTO mapping.reviewer_class_access VALUES ('teacher@example.test', 2139);`);
  for (let index = 1; index <= 18; index++) {
    await pool.query(`INSERT INTO mapping.student_mapping_review
      (public_id, erp_course_class_id, erp_student_contact_id, erp_student_name_snapshot)
      VALUES ($1::uuid, 2139, $2, $3)`, [crypto.randomUUID(), 9000 + index, `Học viên mẫu ${index}`]);
  }
  for (const filename of ['202608290001_learning_platform_v1.sql', '202609150001_learning_platform_v2.sql',
    '202609150003_student_course_journey.sql', '202609160001_course_content_authority.sql',
    '202609160003_portal_attendance_outbox.sql', '202609160006_portal_attendance_dashboard_index.sql',
    '202609240001_teacher_session_speaking_feedback.sql', '202609280001_assignment_answer_release.sql',
    '202609280001_progress_log_admin_scope.sql', '202609290001_teacher_confirmed_journey_plan.sql',
    '202610060001_attendance_binding_and_submission_deadline.sql']) {
    await pool.query(await readFile(new URL(`../ops/learning-migrations/${filename}`, import.meta.url), 'utf8'));
  }
  } catch (error) {
    // Khởi tạo lỗi vẫn thu hồi database riêng, tránh để runner chờ connection còn mở.
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  // Đồng hồ cố định chỉ ở adapter thử, không đọc thời gian do trình duyệt gửi.
  const sqlFor = sql => clock ? sql.replaceAll('clock_timestamp()', `'${new Date(clock.value).toISOString()}'::timestamptz`) : sql;
  const clockPool = { query: (sql, params) => pool.query(sqlFor(sql), params), async connect() {
    const client = await pool.connect();
    return { query: (sql, params) => client.query(sqlFor(sql), params), release: () => client.release() };
  } };
  return { pool, clockPool, service: createLearningService({ pool: clockPool }), async close() {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  } };
}

export async function publishedFixture(fixture, sessionNumber = 3) {
  const published = await fixture.service.publishReflectionForm({
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    title: 'Phiếu thử PostgreSQL', courseCode: 'course-67', classId: '2139', sessionNumber,
    opensAt: null, closesAt: null,
    items: [{ libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true }]
  });
  const assignment = await fixture.service.getPublicAssignment(published.publicToken);
  const itemId = assignment.definition.blocks[0].items[0].itemVersionId;
  const inputs = [];
  for (const student of assignment.roster) {
    const attempt = await fixture.service.startAttempt({ publicToken: published.publicToken,
      studentRef: student.studentRef, identityConfirmed: true, clientIdempotencyKey: crypto.randomUUID() });
    inputs.push({ attemptToken: attempt.attemptToken, submissionId: crypto.randomUUID(),
      definitionHash: published.definitionHash, draftRevision: 0, responses: { [itemId]: 'Bài thử đầy đủ.' } });
  }
  return { published, assignment, itemId, inputs };
}
