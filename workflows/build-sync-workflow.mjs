/*
 * Mục đích: tạo JSON workflow n8n đồng bộ học viên ERP và roster Google Classroom.
 * Dữ liệu nhận vào: ID credential qua biến môi trường; không nhận hoặc lưu mật khẩu/token.
 * Xử lý: đọc câu hỏi Metabase 236, gọi Apps Script Classroom, ghép tên/email cục bộ,
 * tự duyệt email trùng chính xác và ghi snapshot, mapping, phiếu duyệt trong một giao dịch.
 * Kết quả: in JSON workflow ra stdout để công cụ triển khai gửi lên n8n.
 * Lỗi: dừng với thông báo thiếu biến môi trường hoặc lỗi cấu trúc workflow.
 */

const credentialIds = {
  metabase: process.env.N8N_METABASE_CREDENTIAL_ID || '__METABASE_CREDENTIAL_ID__',
  classroom: process.env.N8N_CLASSROOM_CREDENTIAL_ID || '__CLASSROOM_CREDENTIAL_ID__',
  postgres: process.env.N8N_POSTGRES_CREDENTIAL_ID || '__POSTGRES_CREDENTIAL_ID__',
  redis: process.env.N8N_REDIS_CREDENTIAL_ID || '__REDIS_CREDENTIAL_ID__'
};

const prepareClassesCode = `// Nhận danh sách lớp đang hoạt động trực tiếp từ view Lark Base.
// Mỗi lần chạy đều dùng toàn bộ lớp hiện có trong view; không giữ danh sách hard-code.
// Nếu Lark trả dữ liệu rỗng hoặc sai cấu trúc, node dừng để tránh đánh dấu nhầm toàn bộ lớp.
const input = $input.first().json;
const larkItems = Array.isArray(input?.data?.items) ? input.data.items : null;
if (!larkItems) throw new Error('Lark không trả về danh sách lớp hợp lệ.');

const activeClassNames = [...new Set(larkItems
  .map(item => String(item?.fields?.['Lớp'] || '').trim())
  .filter(Boolean))];
if (activeClassNames.length === 0) {
  throw new Error('View Lark không có lớp; chưa chạy đồng bộ để tránh ghi trạng thái sai.');
}

return [{
  json: {
    monitoredClassNames: activeClassNames,
    larkViewChecked: true,
    activeClassNames,
    triggerSource: 'lark_active_view'
  }
}];`;

const collectErpCode = `// Nhận toàn bộ dòng từ Metabase, chuẩn hóa tên cột và gom thành một gói duy nhất.
// Nếu Metabase không trả dữ liệu, node dừng để không ghi đè hàng chờ bằng danh sách rỗng.
const rows = $input.all().map(item => item.json);

function readValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
}

const monitor = $('Chuẩn bị danh sách lớp theo dõi').first().json;
const activeClassKeys = new Set(monitor.activeClassNames.map(name => name.toLowerCase().replace(/\\s+/g, '')));
const erpStudents = rows.map(row => ({
  courseClassId: Number(readValue(row, ['course_class_id', 'COURSE_CLASS_ID'])),
  className: String(readValue(row, ['class_name', 'CLASS_NAME']) || '').trim(),
  studentId: Number(readValue(row, ['erp_student_id', 'ERP_STUDENT_ID'])),
  fullName: String(readValue(row, ['erp_student_name', 'ERP_STUDENT_NAME']) || '').trim(),
  email: String(readValue(row, ['erp_email', 'ERP_EMAIL']) || '').trim().toLowerCase(),
  registrationStatus: String(readValue(row, ['erp_registration_status', 'ERP_REGISTRATION_STATUS']) || '').trim(),
  registrationUpdatedAt: readValue(row, ['erp_registration_updated_at', 'ERP_REGISTRATION_UPDATED_AT'])
})).filter(row =>
  row.courseClassId
  && row.className
  && row.studentId
  && row.fullName
  && activeClassKeys.has(row.className.toLowerCase().replace(/\\s+/g, ''))
);

if (erpStudents.length === 0) {
  throw new Error('Metabase không trả về học viên hợp lệ; chưa ghi dữ liệu mapping.');
}

return [{ json: { erpStudents, monitor } }];`;

const matchCode = `// Nhận roster Classroom và gói ERP, sau đó tạo đề xuất ghép cục bộ.
// Email ERP trùng chính xác email Classroom được đánh dấu để hệ thống tự duyệt.
// Các trường hợp chỉ trùng/gần tên vẫn phải chờ giảng viên xác nhận.
const classroomPayload = $input.first().json;
const erpPackage = $('Gom dữ liệu ERP').first().json;
const erpStudents = erpPackage.erpStudents;
const monitor = erpPackage.monitor;

if (!classroomPayload.ok || !Array.isArray(classroomPayload.courses)) {
  throw new Error('Endpoint Classroom không trả về roster hợp lệ.');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function compactName(value) {
  return normalizeText(value).replace(/ /g, '');
}

function sortedTokens(value) {
  return normalizeText(value).split(' ').filter(Boolean).sort().join(' ');
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function nameSimilarity(a, b) {
  const left = compactName(a);
  const right = compactName(b);
  if (!left || !right) return 0;
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length);
}

function scoreCandidate(erp, classroom) {
  const erpEmail = String(erp.email || '').trim().toLowerCase();
  const googleEmail = String(classroom.email || '').trim().toLowerCase();
  if (erpEmail && googleEmail && erpEmail === googleEmail) {
    return { score: 1, method: 'email', reason: 'Email ERP trùng chính xác với email Google Classroom.' };
  }

  if (compactName(erp.fullName) && compactName(erp.fullName) === compactName(classroom.fullName)) {
    return { score: 0.98, method: 'ai_suggested', reason: 'Tên đầy đủ trùng sau khi bỏ dấu và ký tự thừa.' };
  }

  if (sortedTokens(erp.fullName) && sortedTokens(erp.fullName) === sortedTokens(classroom.fullName)) {
    return { score: 0.96, method: 'ai_suggested', reason: 'Các thành phần họ tên trùng, chỉ khác thứ tự hiển thị.' };
  }

  const similarity = nameSimilarity(erp.fullName, classroom.fullName);
  return {
    score: Number(similarity.toFixed(4)),
    method: 'ai_suggested',
    reason: 'Tên gần giống sau khi chuẩn hóa; cần giảng viên kiểm tra.'
  };
}

const courses = classroomPayload.courses;

// Nếu Google Classroom có nhiều lớp ACTIVE trùng tên, chọn lớp khớp dữ liệu ERP tốt nhất.
// Ưu tiên số email trùng chính xác, sau đó số học viên trong roster; cách này tránh ghi
// hai Classroom course vào cùng một lớp ERP và vẫn chọn được lớp đang được sử dụng thực tế.
const coursesByNormalizedName = new Map();
for (const course of courses) {
  const key = normalizeText(course.name);
  if (!key) continue;
  if (!coursesByNormalizedName.has(key)) coursesByNormalizedName.set(key, []);
  coursesByNormalizedName.get(key).push(course);
}

const selectedCourses = [];
for (const [classKey, sameNameCourses] of coursesByNormalizedName.entries()) {
  const erpEmails = new Set(erpStudents
    .filter(student => normalizeText(student.className) === classKey)
    .map(student => String(student.email || '').trim().toLowerCase())
    .filter(Boolean));

  sameNameCourses.sort((left, right) => {
    const leftExactEmails = (left.students || []).filter(student =>
      erpEmails.has(String(student.email || '').trim().toLowerCase())
    ).length;
    const rightExactEmails = (right.students || []).filter(student =>
      erpEmails.has(String(student.email || '').trim().toLowerCase())
    ).length;
    if (rightExactEmails !== leftExactEmails) return rightExactEmails - leftExactEmails;

    const rosterDifference = (right.students || []).length - (left.students || []).length;
    if (rosterDifference !== 0) return rosterDifference;
    return String(right.id).localeCompare(String(left.id));
  });
  selectedCourses.push(sameNameCourses[0]);
}

const courseByName = new Map(selectedCourses.map(course => [normalizeText(course.name), course]));
const courseMappings = [];
const rosters = [];

for (const course of selectedCourses) {
  const matchingErp = erpStudents.find(student => normalizeText(student.className) === normalizeText(course.name));
  if (!matchingErp) continue;
  courseMappings.push({
    erpCourseClassId: matchingErp.courseClassId,
    className: matchingErp.className,
    classroomCourseId: String(course.id),
    classroomCourseName: String(course.name || ''),
    classroomSection: String(course.section || '')
  });
  for (const student of course.students || []) {
    rosters.push({
      classroomCourseId: String(course.id),
      classroomUserId: String(student.userId),
      fullName: String(student.fullName || ''),
      email: String(student.email || '').trim().toLowerCase()
    });
  }
}

if (courseMappings.length === 0) {
  throw new Error('Không có lớp nào trong view Lark khớp được giữa ERP và Google Classroom.');
}

const proposals = erpStudents.map(erp => {
  const course = courseByName.get(normalizeText(erp.className));
  const candidates = (course?.students || []).map(student => ({
    student,
    ...scoreCandidate(erp, student)
  })).sort((a, b) => b.score - a.score);

  const best = candidates[0] || null;
  const secondScore = candidates[1]?.score || 0;
  const margin = best ? best.score - secondScore : 0;
  const obvious = Boolean(best) && (
    best.method === 'email' ||
    best.score >= 0.95 ||
    (best.score >= 0.88 && margin >= 0.08)
  );

  return { erp, course, best, obvious, margin };
});

// Ngăn một tài khoản Classroom bị đề xuất cho hai học viên ERP trong cùng lần chạy.
const usedGoogleIds = new Map();
proposals.sort((a, b) => (b.best?.score || 0) - (a.best?.score || 0));

const reviews = proposals.map(proposal => {
  const { erp, course, best } = proposal;
  let selected = proposal.obvious ? best : null;
  const selectedGoogleId = selected ? String(selected.student.userId) : null;
  const mappedErpStudentId = selectedGoogleId ? usedGoogleIds.get(selectedGoogleId) : null;
  if (selected && mappedErpStudentId && mappedErpStudentId !== erp.studentId) selected = null;
  if (selected) usedGoogleIds.set(String(selected.student.userId), erp.studentId);
  const autoApproved = Boolean(selected && selected.method === 'email');
  const inactiveRegistrationStatuses = new Set([
    'cancelled', 'on_hold', 'transferred', 'dropped', 'completed', 'not_completed'
  ]);
  const registrationInactive = inactiveRegistrationStatuses.has(erp.registrationStatus);

  return {
    erpCourseClassId: erp.courseClassId,
    erpStudentId: erp.studentId,
    erpStudentName: erp.fullName,
    erpStudentEmail: erp.email || null,
    erpRegistrationStatus: erp.registrationStatus || null,
    erpRegistrationUpdatedAt: erp.registrationUpdatedAt || null,
    classroomCourseId: course ? String(course.id) : null,
    classroomUserId: selected ? String(selected.student.userId) : null,
    classroomName: selected ? String(selected.student.fullName || '') : null,
    classroomEmail: selected ? String(selected.student.email || '').trim().toLowerCase() : null,
    aiScore: selected ? selected.score : null,
    aiReason: selected
      ? selected.reason
      : 'Chưa có ứng viên đủ rõ ràng; giảng viên cần chọn thủ công từ roster lớp.',
    matchMethod: selected ? selected.method : 'pending',
    status: autoApproved ? 'approved' : registrationInactive ? 'superseded' : 'pending_review'
  };
});

const payload = {
  classNames: monitor.monitoredClassNames,
  larkViewChecked: Boolean(monitor.larkViewChecked),
  classViewStates: monitor.monitoredClassNames.map(className => ({
    className,
    inActiveView: monitor.larkViewChecked
      ? monitor.activeClassNames.includes(className)
      : null,
    erpFound: erpStudents.some(student => normalizeText(student.className) === normalizeText(className)),
    classroomFound: courseByName.has(normalizeText(className))
  })),
  courseMappings,
  rosters,
  reviews,
  erpMemberships: erpStudents
};

return [{
  json: {
    payloadJson: JSON.stringify(payload),
    summary: {
      erpStudents: erpStudents.length,
      classroomStudents: rosters.length,
      suggested: reviews.filter(review => review.classroomUserId).length,
      autoApproved: reviews.filter(review => review.status === 'approved').length,
      pendingReview: reviews.filter(review => review.status === 'pending_review').length,
      inactiveRegistration: reviews.filter(review => review.status === 'superseded').length,
      needsManualChoice: reviews.filter(review => !review.classroomUserId).length
    }
  }
}];`;

const upsertSql = `WITH
payload AS (
  SELECT $1::jsonb AS body
),
new_run AS (
  INSERT INTO mapping.sync_run (source, class_names, status, row_count, finished_at)
  SELECT
    'n8n_metabase_classroom',
    ARRAY(SELECT jsonb_array_elements_text(body -> 'classNames')),
    'completed',
    jsonb_array_length(body -> 'reviews'),
    now()
  FROM payload
  RETURNING id
),
class_view_rows AS (
  SELECT DISTINCT ON (row ->> 'className') row
  FROM payload,
       LATERAL jsonb_array_elements(body -> 'classViewStates') AS row
  WHERE COALESCE((body ->> 'larkViewChecked')::boolean, false)
  ORDER BY row ->> 'className'
),
lark_class_change_events AS (
  INSERT INTO mapping.class_change_event (
    change_type,
    class_name_snapshot,
    previous_value,
    new_value,
    sync_run_id
  )
  SELECT
    CASE
      WHEN (row ->> 'inActiveView')::boolean THEN 'lark_class_added_to_view'
      ELSE 'lark_class_removed_from_view'
    END,
    row ->> 'className',
    state.in_lark_active_view::text,
    (row ->> 'inActiveView'),
    new_run.id
  FROM class_view_rows
  JOIN mapping.class_monitor_state AS state
    ON state.class_name = row ->> 'className'
  CROSS JOIN new_run
  WHERE state.in_lark_active_view IS DISTINCT FROM (row ->> 'inActiveView')::boolean
  RETURNING id
),
lark_removed_class_events AS (
  INSERT INTO mapping.class_change_event (
    change_type,
    class_name_snapshot,
    previous_value,
    new_value,
    sync_run_id
  )
  SELECT
    'lark_class_removed_from_view',
    state.class_name,
    'true',
    'false',
    new_run.id
  FROM mapping.class_monitor_state AS state
  CROSS JOIN new_run
  WHERE state.in_lark_active_view
    AND NOT EXISTS (
      SELECT 1
      FROM class_view_rows
      WHERE row ->> 'className' = state.class_name
    )
  RETURNING id
),
class_source_change_events AS (
  INSERT INTO mapping.class_change_event (
    change_type,
    class_name_snapshot,
    previous_value,
    new_value,
    sync_run_id
  )
  SELECT
    CASE
      WHEN source.source_name = 'erp' AND source.new_value THEN 'erp_class_source_restored'
      WHEN source.source_name = 'erp' THEN 'erp_class_source_missing'
      WHEN source.new_value THEN 'classroom_class_source_restored'
      ELSE 'classroom_class_source_missing'
    END,
    row ->> 'className',
    source.previous_value::text,
    source.new_value::text,
    new_run.id
  FROM class_view_rows
  LEFT JOIN mapping.class_monitor_state AS state
    ON state.class_name = row ->> 'className'
  CROSS JOIN LATERAL (
    VALUES
      ('erp', state.erp_source_found, (row ->> 'erpFound')::boolean),
      ('classroom', state.classroom_source_found, (row ->> 'classroomFound')::boolean)
  ) AS source(source_name, previous_value, new_value)
  CROSS JOIN new_run
  WHERE (
      state.class_name IS NOT NULL
      AND source.previous_value IS DISTINCT FROM source.new_value
    )
    OR (
      state.class_name IS NULL
      AND NOT source.new_value
    )
  RETURNING id
),
upsert_class_monitor AS (
  INSERT INTO mapping.class_monitor_state (
    class_name,
    in_lark_active_view,
    erp_source_found,
    classroom_source_found,
    first_seen_at,
    last_checked_at,
    absent_since
  )
  SELECT
    row ->> 'className',
    (row ->> 'inActiveView')::boolean,
    (row ->> 'erpFound')::boolean,
    (row ->> 'classroomFound')::boolean,
    now(),
    now(),
    CASE WHEN (row ->> 'inActiveView')::boolean THEN NULL ELSE now() END
  FROM class_view_rows
  ON CONFLICT (class_name) DO UPDATE SET
    in_lark_active_view = EXCLUDED.in_lark_active_view,
    erp_source_found = EXCLUDED.erp_source_found,
    classroom_source_found = EXCLUDED.classroom_source_found,
    last_checked_at = now(),
    absent_since = CASE
      WHEN EXCLUDED.in_lark_active_view THEN NULL
      WHEN mapping.class_monitor_state.in_lark_active_view THEN now()
      ELSE mapping.class_monitor_state.absent_since
    END
  RETURNING class_name
),
mark_removed_class_monitor AS (
  UPDATE mapping.class_monitor_state AS state
  SET
    in_lark_active_view = false,
    last_checked_at = now(),
    absent_since = COALESCE(state.absent_since, now())
  WHERE state.in_lark_active_view
    AND NOT EXISTS (
      SELECT 1
      FROM class_view_rows
      WHERE row ->> 'className' = state.class_name
    )
  RETURNING state.class_name
),
course_rows AS (
  SELECT DISTINCT ON ((row ->> 'erpCourseClassId')::bigint) row
  FROM payload, LATERAL jsonb_array_elements(body -> 'courseMappings') AS row
  ORDER BY (row ->> 'erpCourseClassId')::bigint, row ->> 'classroomCourseId' DESC
),
upsert_courses AS (
  INSERT INTO mapping.classroom_course_mapping (
    erp_course_class_id,
    erp_class_name_snapshot,
    classroom_course_id,
    classroom_course_name_snapshot,
    classroom_section_snapshot,
    status,
    approved_by,
    approved_at,
    updated_at
  )
  SELECT
    (row ->> 'erpCourseClassId')::bigint,
    row ->> 'className',
    row ->> 'classroomCourseId',
    row ->> 'classroomCourseName',
    NULLIF(row ->> 'classroomSection', ''),
    'approved',
    'system_exact_class_name',
    now(),
    now()
  FROM course_rows
  ON CONFLICT (erp_course_class_id) DO UPDATE SET
    erp_class_name_snapshot = EXCLUDED.erp_class_name_snapshot,
    classroom_course_id = EXCLUDED.classroom_course_id,
    classroom_course_name_snapshot = EXCLUDED.classroom_course_name_snapshot,
    classroom_section_snapshot = EXCLUDED.classroom_section_snapshot,
    status = 'approved',
    updated_at = now()
  RETURNING id
),
roster_rows AS (
  SELECT DISTINCT ON (row ->> 'classroomCourseId', row ->> 'classroomUserId') row
  FROM payload, LATERAL jsonb_array_elements(body -> 'rosters') AS row
  ORDER BY row ->> 'classroomCourseId', row ->> 'classroomUserId'
),
classroom_roster_change_events AS (
  INSERT INTO mapping.class_change_event (
    change_type,
    classroom_course_id,
    google_user_id,
    previous_value,
    new_value,
    sync_run_id
  )
  SELECT
    'classroom_student_removed',
    existing.classroom_course_id,
    existing.classroom_user_id,
    'active',
    'removed',
    new_run.id
  FROM mapping.classroom_roster_snapshot AS existing
  CROSS JOIN new_run
  WHERE existing.roster_state = 'active'
    AND existing.classroom_course_id IN (
      SELECT row ->> 'classroomCourseId' FROM course_rows
    )
    AND NOT EXISTS (
      SELECT 1
      FROM roster_rows
      WHERE row ->> 'classroomCourseId' = existing.classroom_course_id
        AND row ->> 'classroomUserId' = existing.classroom_user_id
    )
  UNION ALL
  SELECT
    'classroom_student_returned',
    existing.classroom_course_id,
    existing.classroom_user_id,
    'removed',
    'active',
    new_run.id
  FROM mapping.classroom_roster_snapshot AS existing
  JOIN roster_rows
    ON row ->> 'classroomCourseId' = existing.classroom_course_id
   AND row ->> 'classroomUserId' = existing.classroom_user_id
  CROSS JOIN new_run
  WHERE existing.roster_state = 'removed'
  RETURNING id
),
mark_old_roster AS (
  UPDATE mapping.classroom_roster_snapshot AS existing
  SET roster_state = 'removed', seen_at = now()
  WHERE existing.classroom_course_id IN (
    SELECT row ->> 'classroomCourseId' FROM course_rows
  )
  RETURNING existing.id
),
upsert_roster AS (
  INSERT INTO mapping.classroom_roster_snapshot (
    classroom_course_id,
    classroom_user_id,
    classroom_name_snapshot,
    classroom_email_snapshot,
    roster_state,
    seen_at,
    sync_run_id
  )
  SELECT
    row ->> 'classroomCourseId',
    row ->> 'classroomUserId',
    NULLIF(row ->> 'fullName', ''),
    NULLIF(row ->> 'email', ''),
    'active',
    now(),
    new_run.id
  FROM roster_rows CROSS JOIN new_run
  ON CONFLICT (classroom_course_id, classroom_user_id) DO UPDATE SET
    classroom_name_snapshot = EXCLUDED.classroom_name_snapshot,
    classroom_email_snapshot = EXCLUDED.classroom_email_snapshot,
    roster_state = 'active',
    seen_at = now(),
    sync_run_id = EXCLUDED.sync_run_id
  RETURNING id
),
membership_rows AS (
  SELECT DISTINCT ON (
    (row ->> 'courseClassId')::bigint,
    (row ->> 'studentId')::bigint
  ) row
  FROM payload, LATERAL jsonb_array_elements(body -> 'erpMemberships') AS row
  ORDER BY
    (row ->> 'courseClassId')::bigint,
    (row ->> 'studentId')::bigint,
    NULLIF(row ->> 'registrationUpdatedAt', '')::timestamptz DESC NULLS LAST
),
erp_membership_change_events AS (
  INSERT INTO mapping.class_change_event (
    change_type,
    erp_course_class_id,
    class_name_snapshot,
    erp_student_contact_id,
    previous_value,
    new_value,
    sync_run_id
  )
  SELECT
    CASE
      WHEN existing.erp_student_contact_id IS NULL THEN 'erp_registration_flagged'
      WHEN existing.source_state = 'missing' THEN 'erp_student_returned_to_source'
      ELSE 'erp_registration_status_changed'
    END,
    (row ->> 'courseClassId')::bigint,
    row ->> 'className',
    (row ->> 'studentId')::bigint,
    CASE
      WHEN existing.source_state = 'missing' THEN 'missing'
      ELSE existing.registration_status
    END,
    NULLIF(row ->> 'registrationStatus', ''),
    new_run.id
  FROM membership_rows
  LEFT JOIN mapping.erp_class_membership_snapshot AS existing
    ON existing.erp_course_class_id = (row ->> 'courseClassId')::bigint
   AND existing.erp_student_contact_id = (row ->> 'studentId')::bigint
  CROSS JOIN new_run
  WHERE (
      existing.erp_student_contact_id IS NOT NULL
      AND (
        existing.source_state = 'missing'
        OR existing.registration_status IS DISTINCT FROM NULLIF(row ->> 'registrationStatus', '')
      )
    )
    OR (
      existing.erp_student_contact_id IS NULL
      AND NULLIF(row ->> 'registrationStatus', '') IN (
        'cancelled', 'on_hold', 'transferred', 'dropped', 'not_completed'
      )
    )
  RETURNING id
),
erp_missing_change_events AS (
  INSERT INTO mapping.class_change_event (
    change_type,
    erp_course_class_id,
    class_name_snapshot,
    erp_student_contact_id,
    previous_value,
    new_value,
    sync_run_id
  )
  SELECT
    'erp_student_missing_from_source',
    existing.erp_course_class_id,
    existing.erp_class_name_snapshot,
    existing.erp_student_contact_id,
    existing.registration_status,
    'missing',
    new_run.id
  FROM mapping.erp_class_membership_snapshot AS existing
  CROSS JOIN new_run
  WHERE existing.source_state = 'active'
    AND existing.erp_course_class_id IN (
      SELECT (row ->> 'erpCourseClassId')::bigint FROM course_rows
    )
    AND NOT EXISTS (
      SELECT 1
      FROM membership_rows
      WHERE (row ->> 'courseClassId')::bigint = existing.erp_course_class_id
        AND (row ->> 'studentId')::bigint = existing.erp_student_contact_id
    )
  RETURNING id
),
mark_missing_memberships AS (
  UPDATE mapping.erp_class_membership_snapshot AS existing
  SET
    source_state = 'missing',
    missing_since = COALESCE(existing.missing_since, now()),
    last_seen_at = now(),
    sync_run_id = new_run.id
  FROM new_run
  WHERE existing.source_state = 'active'
    AND existing.erp_course_class_id IN (
      SELECT (row ->> 'erpCourseClassId')::bigint FROM course_rows
    )
    AND NOT EXISTS (
      SELECT 1
      FROM membership_rows
      WHERE (row ->> 'courseClassId')::bigint = existing.erp_course_class_id
        AND (row ->> 'studentId')::bigint = existing.erp_student_contact_id
    )
  RETURNING existing.erp_student_contact_id
),
upsert_memberships AS (
  INSERT INTO mapping.erp_class_membership_snapshot (
    erp_course_class_id,
    erp_student_contact_id,
    erp_class_name_snapshot,
    erp_student_name_snapshot,
    erp_student_email_snapshot,
    registration_status,
    registration_updated_at,
    source_state,
    first_seen_at,
    last_seen_at,
    missing_since,
    sync_run_id
  )
  SELECT
    (row ->> 'courseClassId')::bigint,
    (row ->> 'studentId')::bigint,
    row ->> 'className',
    row ->> 'fullName',
    NULLIF(row ->> 'email', ''),
    NULLIF(row ->> 'registrationStatus', ''),
    NULLIF(row ->> 'registrationUpdatedAt', '')::timestamptz,
    'active',
    now(),
    now(),
    NULL,
    new_run.id
  FROM membership_rows CROSS JOIN new_run
  ON CONFLICT (erp_course_class_id, erp_student_contact_id) DO UPDATE SET
    erp_class_name_snapshot = EXCLUDED.erp_class_name_snapshot,
    erp_student_name_snapshot = EXCLUDED.erp_student_name_snapshot,
    erp_student_email_snapshot = EXCLUDED.erp_student_email_snapshot,
    registration_status = EXCLUDED.registration_status,
    registration_updated_at = EXCLUDED.registration_updated_at,
    source_state = 'active',
    last_seen_at = now(),
    missing_since = NULL,
    sync_run_id = EXCLUDED.sync_run_id
  RETURNING erp_student_contact_id
),
review_rows AS (
  SELECT DISTINCT ON (
    (row ->> 'erpCourseClassId')::bigint,
    (row ->> 'erpStudentId')::bigint
  ) row
  FROM payload, LATERAL jsonb_array_elements(body -> 'reviews') AS row
  ORDER BY
    (row ->> 'erpCourseClassId')::bigint,
    (row ->> 'erpStudentId')::bigint,
    NULLIF(row ->> 'aiScore', '')::numeric DESC NULLS LAST
),
eligible_exact_email_rows AS (
  SELECT DISTINCT ON ((review_rows.row ->> 'erpStudentId')::bigint) review_rows.row
  FROM review_rows
  WHERE review_rows.row ->> 'status' = 'approved'
    AND review_rows.row ->> 'matchMethod' = 'email'
    AND NULLIF(review_rows.row ->> 'erpStudentEmail', '') IS NOT NULL
    AND lower(review_rows.row ->> 'erpStudentEmail') = lower(review_rows.row ->> 'classroomEmail')
    AND NULLIF(review_rows.row ->> 'classroomUserId', '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM mapping.student_identity_mapping AS existing
      WHERE existing.status = 'approved'
        AND (
          (
            existing.erp_student_contact_id = (review_rows.row ->> 'erpStudentId')::bigint
            AND existing.google_user_id <> review_rows.row ->> 'classroomUserId'
          )
          OR (
            existing.google_user_id = review_rows.row ->> 'classroomUserId'
            AND existing.erp_student_contact_id <> (review_rows.row ->> 'erpStudentId')::bigint
          )
        )
    )
  ORDER BY
    (review_rows.row ->> 'erpStudentId')::bigint,
    NULLIF(review_rows.row ->> 'aiScore', '')::numeric DESC NULLS LAST
),
supersede_stale AS (
  UPDATE mapping.student_mapping_review AS existing
  SET status = 'superseded', updated_at = now()
  WHERE existing.status = 'pending_review'
    AND existing.erp_course_class_id IN (
      SELECT (row ->> 'erpCourseClassId')::bigint FROM course_rows
    )
    AND NOT EXISTS (
      SELECT 1
      FROM review_rows
      WHERE (row ->> 'erpCourseClassId')::bigint = existing.erp_course_class_id
        AND (row ->> 'erpStudentId')::bigint = existing.erp_student_contact_id
    )
  RETURNING existing.id
),
upsert_reviews AS (
  INSERT INTO mapping.student_mapping_review (
    erp_course_class_id,
    erp_student_contact_id,
    erp_student_name_snapshot,
    erp_student_email_snapshot,
    classroom_course_id,
    classroom_user_id,
    classroom_name_snapshot,
    classroom_email_snapshot,
    ai_score,
    ai_reason,
    match_method,
    status,
    reviewer_email,
    reviewer_note,
    decided_at,
    source_run_id,
    updated_at
  )
  SELECT
    (row ->> 'erpCourseClassId')::bigint,
    (row ->> 'erpStudentId')::bigint,
    row ->> 'erpStudentName',
    NULLIF(row ->> 'erpStudentEmail', ''),
    NULLIF(row ->> 'classroomCourseId', ''),
    NULLIF(row ->> 'classroomUserId', ''),
    NULLIF(row ->> 'classroomName', ''),
    NULLIF(row ->> 'classroomEmail', ''),
    NULLIF(row ->> 'aiScore', '')::numeric,
    row ->> 'aiReason',
    row ->> 'matchMethod',
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM eligible_exact_email_rows AS exact_row
        WHERE (exact_row.row ->> 'erpCourseClassId')::bigint = (review_rows.row ->> 'erpCourseClassId')::bigint
          AND (exact_row.row ->> 'erpStudentId')::bigint = (review_rows.row ->> 'erpStudentId')::bigint
      ) THEN 'approved'
      WHEN row ->> 'status' = 'superseded' THEN 'superseded'
      ELSE 'pending_review'
    END,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM eligible_exact_email_rows AS exact_row
        WHERE (exact_row.row ->> 'erpCourseClassId')::bigint = (review_rows.row ->> 'erpCourseClassId')::bigint
          AND (exact_row.row ->> 'erpStudentId')::bigint = (review_rows.row ->> 'erpStudentId')::bigint
      ) THEN 'Hệ thống: email trùng chính xác'
      ELSE NULL
    END,
    CASE
      WHEN row ->> 'status' = 'approved'
        AND NOT EXISTS (
          SELECT 1
          FROM eligible_exact_email_rows AS exact_row
          WHERE (exact_row.row ->> 'erpCourseClassId')::bigint = (review_rows.row ->> 'erpCourseClassId')::bigint
            AND (exact_row.row ->> 'erpStudentId')::bigint = (review_rows.row ->> 'erpStudentId')::bigint
        ) THEN 'Email trùng nhưng xung đột với mapping đã duyệt trước đó; cần giảng viên kiểm tra.'
      ELSE NULL
    END,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM eligible_exact_email_rows AS exact_row
        WHERE (exact_row.row ->> 'erpCourseClassId')::bigint = (review_rows.row ->> 'erpCourseClassId')::bigint
          AND (exact_row.row ->> 'erpStudentId')::bigint = (review_rows.row ->> 'erpStudentId')::bigint
      ) THEN now()
      ELSE NULL
    END,
    new_run.id,
    now()
  FROM review_rows CROSS JOIN new_run
  ON CONFLICT (erp_course_class_id, erp_student_contact_id) DO UPDATE SET
    erp_student_name_snapshot = EXCLUDED.erp_student_name_snapshot,
    erp_student_email_snapshot = EXCLUDED.erp_student_email_snapshot,
    classroom_course_id = EXCLUDED.classroom_course_id,
    classroom_user_id = EXCLUDED.classroom_user_id,
    classroom_name_snapshot = EXCLUDED.classroom_name_snapshot,
    classroom_email_snapshot = EXCLUDED.classroom_email_snapshot,
    ai_score = EXCLUDED.ai_score,
    ai_reason = EXCLUDED.ai_reason,
    match_method = EXCLUDED.match_method,
    status = EXCLUDED.status,
    reviewer_email = EXCLUDED.reviewer_email,
    reviewer_note = EXCLUDED.reviewer_note,
    decided_at = EXCLUDED.decided_at,
    source_run_id = EXCLUDED.source_run_id,
    updated_at = now()
  WHERE mapping.student_mapping_review.status = 'pending_review'
     OR mapping.student_mapping_review.reviewer_email = 'Hệ thống: email trùng chính xác'
  RETURNING id
),
upsert_exact_email_mappings AS (
  INSERT INTO mapping.student_identity_mapping (
    erp_student_contact_id,
    google_user_id,
    google_email_snapshot,
    erp_name_snapshot,
    google_name_snapshot,
    status,
    match_method,
    approved_by,
    approved_at,
    last_seen_at,
    updated_at
  )
  SELECT
    (row ->> 'erpStudentId')::bigint,
    row ->> 'classroomUserId',
    row ->> 'classroomEmail',
    row ->> 'erpStudentName',
    row ->> 'classroomName',
    'approved',
    'email',
    'Hệ thống: email trùng chính xác',
    now(),
    now(),
    now()
  FROM eligible_exact_email_rows
  ON CONFLICT (erp_student_contact_id) DO UPDATE SET
    google_email_snapshot = EXCLUDED.google_email_snapshot,
    erp_name_snapshot = EXCLUDED.erp_name_snapshot,
    google_name_snapshot = EXCLUDED.google_name_snapshot,
    status = 'approved',
    match_method = 'email',
    last_seen_at = now(),
    updated_at = now()
  WHERE mapping.student_identity_mapping.google_user_id = EXCLUDED.google_user_id
  RETURNING id
)
SELECT
  new_run.id AS sync_run_id,
  (SELECT count(*) FROM upsert_courses) AS courses_written,
  (SELECT count(*) FROM upsert_roster) AS roster_rows_written,
  (SELECT count(*) FROM upsert_memberships) AS membership_rows_written,
  (SELECT count(*) FROM upsert_reviews) AS review_rows_written,
  (SELECT count(*) FROM upsert_exact_email_mappings) AS exact_email_mappings_written,
  (SELECT count(*) FROM supersede_stale) AS stale_reviews_superseded,
  (
    (SELECT count(*) FROM lark_class_change_events)
    + (SELECT count(*) FROM lark_removed_class_events)
    + (SELECT count(*) FROM class_source_change_events)
    + (SELECT count(*) FROM classroom_roster_change_events)
    + (SELECT count(*) FROM erp_membership_change_events)
    + (SELECT count(*) FROM erp_missing_change_events)
  ) AS change_events_written
FROM new_run;`;

const workflow = {
  name: 'Đồng bộ mapping và quét thay đổi các lớp trong view Lark',
  nodes: [
    {
      id: '8d34160d-82fc-44ef-88c9-a339759ef9fc',
      name: 'Chạy đồng bộ thủ công',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-980, -100],
      parameters: {}
    },
    {
      id: 'a0cc52bd-7425-45f4-af8b-f2a792faea41',
      name: 'Quét thay đổi mỗi ngày',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.3,
      position: [-980, 100],
      parameters: {
        rule: {
          interval: [{ triggerAtHour: 4, triggerAtMinute: 30 }]
        }
      }
    },
    {
      id: '066e53f4-6fd3-489c-87c4-8beea0f3f700',
      name: 'Lấy quyền đọc Lark hiện tại',
      type: 'n8n-nodes-base.redis',
      typeVersion: 1,
      position: [-760, 0],
      parameters: {
        operation: 'get',
        propertyName: 'tenant_access_token',
        key: 'lark:tenant_access_token',
        options: {}
      },
      credentials: {
        redis: {
          id: credentialIds.redis,
          name: 'Redis account'
        }
      }
    },
    {
      id: 'efb101ce-a801-4fcc-9be3-53a784f625e7',
      name: 'Đọc toàn bộ lớp trong view Lark',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.3,
      position: [-540, 0],
      parameters: {
        method: 'GET',
        url: 'https://open.larksuite.com/open-apis/bitable/v1/apps/KrAobhWiiaZvqSssrvrlAhNSgOb/tables/tblgO1AayTmAciVD/records',
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'view_id', value: 'vewp7nmiS4' },
            { name: 'field_names', value: '["Lớp"]' },
            { name: 'page_size', value: '500' }
          ]
        },
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '=Bearer {{ $json.tenant_access_token }}' }
          ]
        },
        options: {
          response: { response: { responseFormat: 'json' } },
          timeout: 45000
        }
      }
    },
    {
      id: '916ca9a8-a746-483f-8530-e6ba1127e284',
      name: 'Chuẩn bị danh sách lớp theo dõi',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-320, 0],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: prepareClassesCode
      }
    },
    {
      id: '6a816e85-83df-46d2-8065-1f23ef4b44db',
      name: 'Lấy học viên có dữ liệu điểm danh từ Metabase',
      type: 'n8n-nodes-base.metabase',
      typeVersion: 1,
      position: [-100, 0],
      parameters: {
        operation: 'resultData',
        questionId: '237',
        format: 'json',
        requestOptions: {}
      },
      credentials: {
        metabaseApi: {
          id: credentialIds.metabase,
          name: 'Metabase account'
        }
      }
    },
    {
      id: 'acddce2a-9ee0-4e38-9973-a4b59d1135ad',
      name: 'Gom dữ liệu ERP',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [120, 0],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: collectErpCode
      }
    },
    {
      id: 'c92e81e5-a9ad-4b43-bc82-c7509ba4c9b5',
      name: 'Lấy roster Google Classroom',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.3,
      position: [340, 0],
      parameters: {
        method: 'POST',
        url: 'https://script.google.com/macros/s/AKfycbwyLn5uI6_WRftLzKNY0nDk5EtfICxD-J8kZhXln1qOibvBkF4np_HUSXSkOsJ4kpmW/exec',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpQueryAuth',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' }
          ]
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ { action: 'listRoster', classNames: $('Chuẩn bị danh sách lớp theo dõi').first().json.monitoredClassNames } }}",
        options: {
          response: { response: { responseFormat: 'json' } },
          timeout: 60000
        }
      },
      credentials: {
        httpQueryAuth: {
          id: credentialIds.classroom,
          name: 'Classroom roster endpoint'
        }
      }
    },
    {
      id: '9629600c-e8ec-4f01-958b-02198c038198',
      name: 'Tạo đề xuất ghép để giảng viên duyệt',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [560, 0],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: matchCode
      }
    },
    {
      id: '27478774-ebef-438b-af1d-90be2341f8f8',
      name: 'Lưu snapshot và hàng chờ duyệt',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [800, 0],
      parameters: {
        resource: 'database',
        operation: 'executeQuery',
        query: upsertSql,
        options: {
          queryReplacement: '={{ [$json.payloadJson] }}',
          queryBatching: 'transaction'
        }
      },
      credentials: {
        postgres: {
          id: credentialIds.postgres,
          name: 'Postgres account'
        }
      }
    }
  ],
  connections: {
    'Chạy đồng bộ thủ công': {
      main: [[{ node: 'Lấy quyền đọc Lark hiện tại', type: 'main', index: 0 }]]
    },
    'Quét thay đổi mỗi ngày': {
      main: [[{ node: 'Lấy quyền đọc Lark hiện tại', type: 'main', index: 0 }]]
    },
    'Lấy quyền đọc Lark hiện tại': {
      main: [[{ node: 'Đọc toàn bộ lớp trong view Lark', type: 'main', index: 0 }]]
    },
    'Đọc toàn bộ lớp trong view Lark': {
      main: [[{ node: 'Chuẩn bị danh sách lớp theo dõi', type: 'main', index: 0 }]]
    },
    'Chuẩn bị danh sách lớp theo dõi': {
      main: [[{ node: 'Lấy học viên có dữ liệu điểm danh từ Metabase', type: 'main', index: 0 }]]
    },
    'Lấy học viên có dữ liệu điểm danh từ Metabase': {
      main: [[{ node: 'Gom dữ liệu ERP', type: 'main', index: 0 }]]
    },
    'Gom dữ liệu ERP': {
      main: [[{ node: 'Lấy roster Google Classroom', type: 'main', index: 0 }]]
    },
    'Lấy roster Google Classroom': {
      main: [[{ node: 'Tạo đề xuất ghép để giảng viên duyệt', type: 'main', index: 0 }]]
    },
    'Tạo đề xuất ghép để giảng viên duyệt': {
      main: [[{ node: 'Lưu snapshot và hàng chờ duyệt', type: 'main', index: 0 }]]
    }
  },
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Ho_Chi_Minh',
    saveExecutionProgress: true,
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all'
  }
};

process.stdout.write(JSON.stringify(workflow));
