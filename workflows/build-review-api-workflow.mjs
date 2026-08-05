/*
 * Mục đích: tạo JSON workflow n8n phục vụ trang giảng viên duyệt mapping.
 * Dữ liệu nhận vào: ID credential Header Auth và PostgreSQL qua biến môi trường.
 * Xử lý: xác thực header, đọc hàng chờ hoặc ghi quyết định, rồi trả JSON có CORS giới hạn.
 * Kết quả: in JSON workflow ra stdout; workflow được tạo ở trạng thái chưa kích hoạt.
 * Lỗi: PostgreSQL trả thông báo rõ và không ghi mapping khi ứng viên không hợp lệ hoặc bị trùng.
 */

const credentialIds = {
  headerAuth: process.env.N8N_REVIEW_HEADER_CREDENTIAL_ID || '__REVIEW_HEADER_CREDENTIAL_ID__',
  postgres: process.env.N8N_POSTGRES_CREDENTIAL_ID || '__POSTGRES_CREDENTIAL_ID__'
};

const githubPagesOrigin = 'https://tranhoangduc90.github.io';

const responseHeaders = {
  entries: [
    { name: 'Access-Control-Allow-Origin', value: githubPagesOrigin },
    { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
    { name: 'Access-Control-Allow-Headers', value: 'Content-Type, x-review-token' },
    { name: 'Cache-Control', value: 'no-store' },
    { name: 'Vary', value: 'Origin' }
  ]
};

const listSql = `WITH input AS (
  SELECT
    NULLIF($1, '')::bigint AS class_id,
    COALESCE(NULLIF($2, ''), 'all') AS requested_status
),
filtered AS (
  SELECT
    r.*,
    cm.erp_class_name_snapshot,
    current_roster.classroom_name_snapshot AS current_classroom_name,
    current_roster.classroom_email_snapshot AS current_classroom_email
  FROM mapping.student_mapping_review AS r
  JOIN mapping.classroom_course_mapping AS cm
    ON cm.erp_course_class_id = r.erp_course_class_id
  LEFT JOIN mapping.classroom_roster_snapshot AS current_roster
    ON current_roster.classroom_course_id = r.classroom_course_id
   AND current_roster.classroom_user_id = r.classroom_user_id
   AND current_roster.roster_state = 'active'
  CROSS JOIN input
  WHERE (input.class_id IS NULL OR r.erp_course_class_id = input.class_id)
    AND (input.requested_status = 'all' OR r.status = input.requested_status)
),
items AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', filtered.id::text,
      'classId', filtered.erp_course_class_id::text,
      'className', filtered.erp_class_name_snapshot,
      'erpStudentId', filtered.erp_student_contact_id::text,
      'erpStudentName', filtered.erp_student_name_snapshot,
      'classroomCourseId', filtered.classroom_course_id,
      'classroomUserId', filtered.classroom_user_id,
      'classroomName', COALESCE(filtered.current_classroom_name, filtered.classroom_name_snapshot),
      'classroomEmail', COALESCE(filtered.current_classroom_email, filtered.classroom_email_snapshot),
      'confidence', COALESCE(filtered.ai_score, 0),
      'reason', filtered.ai_reason,
      'status', filtered.status,
      'candidates', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'userId', roster.classroom_user_id,
            'fullName', roster.classroom_name_snapshot,
            'email', roster.classroom_email_snapshot
          ) ORDER BY roster.classroom_name_snapshot, roster.classroom_email_snapshot
        )
        FROM mapping.classroom_roster_snapshot AS roster
        WHERE roster.classroom_course_id = filtered.classroom_course_id
          AND roster.roster_state = 'active'
      ), '[]'::jsonb)
    ) ORDER BY filtered.erp_class_name_snapshot, filtered.erp_student_name_snapshot
  ) AS data
  FROM filtered
)
SELECT jsonb_build_object(
  'ok', true,
  'items', COALESCE(items.data, '[]'::jsonb)
) AS response
FROM items;`;

const decisionSql = `WITH input AS (
  SELECT
    NULLIF($1, '')::bigint AS review_id,
    NULLIF($2, '') AS decision,
    NULLIF($3, '') AS requested_google_user_id,
    NULLIF($4, '') AS note,
    COALESCE(NULLIF($5, ''), 'Giảng viên không ghi tên') AS reviewer_name
),
target AS (
  SELECT
    r.*,
    input.decision,
    input.requested_google_user_id,
    input.note,
    input.reviewer_name,
    CASE
      WHEN input.decision = 'approve' THEN r.classroom_user_id
      WHEN input.decision IN ('choose_another', 'edit_mapping') THEN input.requested_google_user_id
      ELSE NULL
    END AS selected_google_user_id
  FROM mapping.student_mapping_review AS r
  CROSS JOIN input
  WHERE r.id = input.review_id
    AND (
      (r.status = 'pending_review' AND input.decision IN ('approve', 'reject', 'choose_another'))
      OR (r.status IN ('approved', 'rejected') AND input.decision = 'reopen')
      OR (r.status = 'approved' AND input.decision = 'edit_mapping')
    )
),
selected_roster AS (
  SELECT
    target.*,
    roster.classroom_name_snapshot AS selected_google_name,
    roster.classroom_email_snapshot AS selected_google_email,
    CASE
      WHEN target.decision IN ('reject', 'reopen') THEN true
      WHEN target.decision IN ('approve', 'choose_another', 'edit_mapping')
        AND roster.classroom_user_id IS NOT NULL THEN true
      ELSE false
    END AS candidate_is_valid
  FROM target
  LEFT JOIN mapping.classroom_roster_snapshot AS roster
    ON roster.classroom_course_id = target.classroom_course_id
   AND roster.classroom_user_id = target.selected_google_user_id
   AND roster.roster_state = 'active'
),
validated AS (
  SELECT
    selected_roster.*,
    NOT EXISTS (
      SELECT 1
      FROM mapping.student_identity_mapping AS existing
      WHERE existing.google_user_id = selected_roster.selected_google_user_id
        AND existing.erp_student_contact_id <> selected_roster.erp_student_contact_id
        AND existing.status = 'approved'
    ) AS google_user_is_available
  FROM selected_roster
  WHERE selected_roster.decision IN ('approve', 'reject', 'choose_another', 'edit_mapping', 'reopen')
),
accepted AS (
  SELECT *
  FROM validated
  WHERE candidate_is_valid
    AND (decision IN ('reject', 'reopen') OR google_user_is_available)
),
decision_event AS (
  INSERT INTO mapping.mapping_decision_event (
    review_id,
    decision,
    selected_google_user_id,
    reviewer_email,
    note
  )
  SELECT
    id,
    decision,
    selected_google_user_id,
    reviewer_name,
    note
  FROM accepted
  RETURNING id
),
updated_review AS (
  UPDATE mapping.student_mapping_review AS review
  SET
    classroom_user_id = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.classroom_user_id ELSE accepted.selected_google_user_id END,
    classroom_name_snapshot = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.classroom_name_snapshot ELSE accepted.selected_google_name END,
    classroom_email_snapshot = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.classroom_email_snapshot ELSE accepted.selected_google_email END,
    match_method = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.match_method ELSE 'teacher_confirmed' END,
    status = CASE
      WHEN accepted.decision = 'reject' THEN 'rejected'
      WHEN accepted.decision = 'reopen' THEN 'pending_review'
      ELSE 'approved'
    END,
    reviewer_email = CASE WHEN accepted.decision = 'reopen' THEN NULL ELSE accepted.reviewer_name END,
    reviewer_note = CASE WHEN accepted.decision = 'reopen' THEN NULL ELSE accepted.note END,
    decided_at = CASE WHEN accepted.decision = 'reopen' THEN NULL ELSE now() END,
    updated_at = now()
  FROM accepted
  WHERE review.id = accepted.id
  RETURNING review.*
),
upsert_mapping AS (
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
    accepted.erp_student_contact_id,
    accepted.selected_google_user_id,
    accepted.selected_google_email,
    accepted.erp_student_name_snapshot,
    accepted.selected_google_name,
    'approved',
    'teacher_confirmed',
    accepted.reviewer_name,
    now(),
    now(),
    now()
  FROM accepted
  WHERE accepted.decision IN ('approve', 'choose_another', 'edit_mapping')
  ON CONFLICT (erp_student_contact_id) DO UPDATE SET
    google_user_id = EXCLUDED.google_user_id,
    google_email_snapshot = EXCLUDED.google_email_snapshot,
    erp_name_snapshot = EXCLUDED.erp_name_snapshot,
    google_name_snapshot = EXCLUDED.google_name_snapshot,
    status = 'approved',
    match_method = 'teacher_confirmed',
    approved_by = EXCLUDED.approved_by,
    approved_at = now(),
    last_seen_at = now(),
    updated_at = now()
  RETURNING id
),
deactivate_reopened_mapping AS (
  UPDATE mapping.student_identity_mapping AS identity
  SET
    status = 'inactive',
    updated_at = now()
  FROM accepted
  WHERE accepted.decision = 'reopen'
    AND identity.erp_student_contact_id = accepted.erp_student_contact_id
  RETURNING identity.id
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM target) THEN jsonb_build_object(
    'ok', false,
    'error', 'REVIEW_NOT_FOUND',
    'message', 'Phiếu duyệt không tồn tại hoặc đã được xử lý.'
  )
  WHEN NOT EXISTS (SELECT 1 FROM validated) THEN jsonb_build_object(
    'ok', false,
    'error', 'INVALID_DECISION',
    'message', 'Quyết định không hợp lệ.'
  )
  WHEN EXISTS (SELECT 1 FROM validated WHERE NOT candidate_is_valid) THEN jsonb_build_object(
    'ok', false,
    'error', 'INVALID_CLASSROOM_USER',
    'message', 'Tài khoản Google không thuộc roster hiện tại của lớp.'
  )
  WHEN EXISTS (SELECT 1 FROM validated WHERE decision NOT IN ('reject', 'reopen') AND NOT google_user_is_available) THEN jsonb_build_object(
    'ok', false,
    'error', 'GOOGLE_ACCOUNT_ALREADY_MAPPED',
    'message', 'Tài khoản Google này đã được duyệt cho học viên khác.'
  )
  ELSE jsonb_build_object(
    'ok', true,
    'reviewId', (SELECT id::text FROM updated_review LIMIT 1),
    'status', (SELECT status FROM updated_review LIMIT 1),
    'mappingId', (SELECT id::text FROM upsert_mapping LIMIT 1),
    'reopenedMappingId', (SELECT id::text FROM deactivate_reopened_mapping LIMIT 1),
    'decidedAt', now()
  )
END AS response;`;

function webhookNode({ id, name, method, path, x, y, authenticated = false }) {
  const node = {
    id,
    name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2.1,
    position: [x, y],
    webhookId: id,
    parameters: {
      httpMethod: method,
      path,
      responseMode: 'responseNode',
      options: {}
    }
  };

  if (authenticated) {
    node.parameters.authentication = 'headerAuth';
    node.credentials = {
      httpHeaderAuth: {
        id: credentialIds.headerAuth,
        name: 'Quyền truy cập duyệt mapping'
      }
    };
  }

  return node;
}

function responseNode({ id, name, x, y, bodyExpression, code = 200 }) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.4,
    position: [x, y],
    parameters: {
      respondWith: 'json',
      responseBody: bodyExpression,
      options: {
        responseCode: code,
        responseHeaders
      }
    }
  };
}

const workflow = {
  name: 'API để giảng viên duyệt mapping học viên',
  nodes: [
    webhookNode({
      id: 'e3b117e4-376d-4eed-98f8-38620ae8c141',
      name: 'Nhận yêu cầu tải hàng chờ',
      method: 'GET',
      path: 'api/mapping/reviews',
      x: -720,
      y: -220,
      authenticated: true
    }),
    {
      id: '0f9f8b20-29a7-4f07-a9af-bd9ee9db5155',
      name: 'Đọc hàng chờ từ PostgreSQL',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [-460, -220],
      parameters: {
        resource: 'database',
        operation: 'executeQuery',
        query: listSql,
        options: {
          queryReplacement: "={{ [$json.query?.class_id || '', $json.query?.status || 'all'] }}"
        }
      },
      credentials: {
        postgres: {
          id: credentialIds.postgres,
          name: 'Postgres account'
        }
      }
    },
    responseNode({
      id: 'cb1252a1-0fd3-48ac-a647-c01312188f4e',
      name: 'Trả hàng chờ cho trang duyệt',
      x: -180,
      y: -220,
      bodyExpression: '={{ $json.response }}'
    }),
    webhookNode({
      id: 'ad05f5d9-4ab0-4266-bdb9-86fa337e01e7',
      name: 'Nhận quyết định của giảng viên',
      method: 'POST',
      path: 'api/mapping/reviews/decision',
      x: -720,
      y: 100,
      authenticated: true
    }),
    {
      id: '01ea839b-d26a-47af-b1db-b22f23de7d7c',
      name: 'Ghi quyết định và mapping chính thức',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [-460, 100],
      parameters: {
        resource: 'database',
        operation: 'executeQuery',
        query: decisionSql,
        options: {
          queryReplacement: "={{ [$json.body?.reviewId || '', $json.body?.decision || '', $json.body?.classroomUserId || '', $json.body?.note || '', $json.body?.reviewerName || ''] }}",
          queryBatching: 'transaction'
        }
      },
      credentials: {
        postgres: {
          id: credentialIds.postgres,
          name: 'Postgres account'
        }
      }
    },
    responseNode({
      id: '56af0d82-b556-4ed6-bf21-794766c31c11',
      name: 'Trả kết quả quyết định',
      x: -180,
      y: 100,
      bodyExpression: '={{ $json.response }}'
    })
  ],
  connections: {
    'Nhận yêu cầu tải hàng chờ': {
      main: [[{ node: 'Đọc hàng chờ từ PostgreSQL', type: 'main', index: 0 }]]
    },
    'Đọc hàng chờ từ PostgreSQL': {
      main: [[{ node: 'Trả hàng chờ cho trang duyệt', type: 'main', index: 0 }]]
    },
    'Nhận quyết định của giảng viên': {
      main: [[{ node: 'Ghi quyết định và mapping chính thức', type: 'main', index: 0 }]]
    },
    'Ghi quyết định và mapping chính thức': {
      main: [[{ node: 'Trả kết quả quyết định', type: 'main', index: 0 }]]
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
