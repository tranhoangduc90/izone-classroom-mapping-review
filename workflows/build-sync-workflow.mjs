/*
 * Mục đích: tạo JSON workflow n8n đồng bộ học viên ERP và roster Google Classroom.
 * Dữ liệu nhận vào: ID credential qua biến môi trường; không nhận hoặc lưu mật khẩu/token.
 * Xử lý: đọc câu hỏi Metabase 236, gọi Apps Script Classroom, ghép tên/email cục bộ,
 * rồi ghi snapshot và phiếu chờ duyệt vào PostgreSQL trong một giao dịch.
 * Kết quả: in JSON workflow ra stdout để công cụ triển khai gửi lên n8n.
 * Lỗi: dừng với thông báo thiếu biến môi trường hoặc lỗi cấu trúc workflow.
 */

const credentialIds = {
  metabase: process.env.N8N_METABASE_CREDENTIAL_ID || '__METABASE_CREDENTIAL_ID__',
  classroom: process.env.N8N_CLASSROOM_CREDENTIAL_ID || '__CLASSROOM_CREDENTIAL_ID__',
  postgres: process.env.N8N_POSTGRES_CREDENTIAL_ID || '__POSTGRES_CREDENTIAL_ID__'
};

const collectErpCode = `// Nhận toàn bộ dòng từ Metabase, chuẩn hóa tên cột và gom thành một gói duy nhất.
// Nếu Metabase không trả dữ liệu, node dừng để không ghi đè hàng chờ bằng danh sách rỗng.
const rows = $input.all().map(item => item.json);

function readValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
}

const erpStudents = rows.map(row => ({
  courseClassId: Number(readValue(row, ['course_class_id', 'COURSE_CLASS_ID'])),
  className: String(readValue(row, ['class_name', 'CLASS_NAME']) || '').trim(),
  studentId: Number(readValue(row, ['erp_student_id', 'ERP_STUDENT_ID'])),
  fullName: String(readValue(row, ['erp_student_name', 'ERP_STUDENT_NAME']) || '').trim(),
  email: String(readValue(row, ['erp_email', 'ERP_EMAIL']) || '').trim().toLowerCase()
})).filter(row => row.courseClassId && row.className && row.studentId && row.fullName);

if (erpStudents.length === 0) {
  throw new Error('Metabase không trả về học viên hợp lệ; chưa ghi dữ liệu mapping.');
}

return [{ json: { erpStudents } }];`;

const matchCode = `// Nhận roster Classroom và gói ERP, sau đó tạo đề xuất ghép cục bộ.
// Chỉ các trường hợp email/tên trùng rõ hoặc tên rất gần và có khoảng cách an toàn mới được đề xuất.
// Mọi đề xuất vẫn ở trạng thái chờ giảng viên duyệt; node này không tự phê duyệt mapping.
const classroomPayload = $input.first().json;
const erpStudents = $('Gom dữ liệu ERP').first().json.erpStudents;

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
const courseByName = new Map(courses.map(course => [normalizeText(course.name), course]));
const courseMappings = [];
const rosters = [];

for (const course of courses) {
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

if (courseMappings.length !== 2) {
  throw new Error('Không tìm thấy đủ hai lớp IC2172 và IC2200 trên Google Classroom.');
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
const usedGoogleIds = new Set();
proposals.sort((a, b) => (b.best?.score || 0) - (a.best?.score || 0));

const reviews = proposals.map(proposal => {
  const { erp, course, best } = proposal;
  let selected = proposal.obvious ? best : null;
  if (selected && usedGoogleIds.has(String(selected.student.userId))) selected = null;
  if (selected) usedGoogleIds.add(String(selected.student.userId));

  return {
    erpCourseClassId: erp.courseClassId,
    erpStudentId: erp.studentId,
    erpStudentName: erp.fullName,
    erpStudentEmail: erp.email || null,
    classroomCourseId: course ? String(course.id) : null,
    classroomUserId: selected ? String(selected.student.userId) : null,
    classroomName: selected ? String(selected.student.fullName || '') : null,
    classroomEmail: selected ? String(selected.student.email || '').trim().toLowerCase() : null,
    aiScore: selected ? selected.score : null,
    aiReason: selected
      ? selected.reason
      : 'Chưa có ứng viên đủ rõ ràng; giảng viên cần chọn thủ công từ roster lớp.',
    matchMethod: selected ? selected.method : 'pending'
  };
});

const payload = {
  classNames: ['IC2172', 'IC2200'],
  courseMappings,
  rosters,
  reviews
};

return [{
  json: {
    payloadJson: JSON.stringify(payload),
    summary: {
      erpStudents: erpStudents.length,
      classroomStudents: rosters.length,
      suggested: reviews.filter(review => review.classroomUserId).length,
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
course_rows AS (
  SELECT row
  FROM payload, LATERAL jsonb_array_elements(body -> 'courseMappings') AS row
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
mark_old_roster AS (
  UPDATE mapping.classroom_roster_snapshot AS existing
  SET roster_state = 'removed', seen_at = now()
  WHERE existing.classroom_course_id IN (
    SELECT row ->> 'classroomCourseId' FROM course_rows
  )
  RETURNING existing.id
),
roster_rows AS (
  SELECT row
  FROM payload, LATERAL jsonb_array_elements(body -> 'rosters') AS row
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
review_rows AS (
  SELECT row
  FROM payload, LATERAL jsonb_array_elements(body -> 'reviews') AS row
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
    'pending_review',
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
    source_run_id = EXCLUDED.source_run_id,
    updated_at = now()
  WHERE mapping.student_mapping_review.status = 'pending_review'
  RETURNING id
)
SELECT
  new_run.id AS sync_run_id,
  (SELECT count(*) FROM upsert_courses) AS courses_written,
  (SELECT count(*) FROM upsert_roster) AS roster_rows_written,
  (SELECT count(*) FROM upsert_reviews) AS review_rows_written,
  (SELECT count(*) FROM supersede_stale) AS stale_reviews_superseded
FROM new_run;`;

const workflow = {
  name: 'Đồng bộ học viên IC2172 IC2200 để giảng viên duyệt',
  nodes: [
    {
      id: '8d34160d-82fc-44ef-88c9-a339759ef9fc',
      name: 'Chạy đồng bộ thủ công',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-720, 0],
      parameters: {}
    },
    {
      id: '6a816e85-83df-46d2-8065-1f23ef4b44db',
      name: 'Lấy học viên có dữ liệu điểm danh từ Metabase',
      type: 'n8n-nodes-base.metabase',
      typeVersion: 1,
      position: [-480, 0],
      parameters: {
        operation: 'resultData',
        questionId: '236',
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
      position: [-240, 0],
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
      position: [0, 0],
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
        jsonBody: "={{ { action: 'listRoster', classNames: ['IC2172', 'IC2200'] } }}",
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
      position: [240, 0],
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
      position: [500, 0],
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
    saveExecutionProgress: true,
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all'
  }
};

process.stdout.write(JSON.stringify(workflow));
