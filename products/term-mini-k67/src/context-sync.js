import { parseContextSnapshot, CONTEXT_MAX_BYTES, ContextError } from './context-contract.js';

// Nhận snapshot đã kiểm; thay mirror trong một transaction và thu hồi phiên khi quyền đổi.
// Lỗi HTTP/hợp đồng/SQL giữ nguyên mirror cũ; guard tự đóng quyền sau 120 giây.
const columns = {
  classroom_course_mapping: ['erp_course_class_id', 'erp_class_name_snapshot'],
  student_mapping_review: ['public_id', 'erp_course_class_id', 'erp_student_contact_id', 'erp_student_name_snapshot', 'status'],
  erp_class_membership_snapshot: ['erp_course_class_id', 'erp_student_contact_id', 'erp_student_name_snapshot', 'source_state'],
  reviewer_class_access: ['reviewer_email', 'erp_course_class_id']
};
const types = { erp_course_class_id: 'bigint', erp_student_contact_id: 'bigint', public_id: 'uuid' };
const keys = {
  classroom_course_mapping: ['erp_course_class_id'],
  student_mapping_review: ['public_id'],
  erp_class_membership_snapshot: ['erp_course_class_id', 'erp_student_contact_id'],
  reviewer_class_access: ['reviewer_email', 'erp_course_class_id']
};
async function reconcileRows(client, table, rows) {
  const fields = columns[table];
  const identity = keys[table], changes = fields.filter(field => !identity.includes(field));
  // Nhận cả nhóm đã kiểm; xóa đúng hàng mất, thêm/sửa đúng hàng đổi.
  // Vẫn đối chiếu mirror khi hash nguồn không đổi để sửa được drift cục bộ.
  const conflict = changes.length ? `DO UPDATE SET ${changes.map(field => `${field}=EXCLUDED.${field}`).join(',')}
    WHERE ROW(${changes.map(field => `existing.${field}`).join(',')})
      IS DISTINCT FROM ROW(${changes.map(field => `EXCLUDED.${field}`).join(',')})` : 'DO NOTHING';
  await client.query(`WITH incoming AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(${fields.map(field => `${field} ${types[field] || 'text'}`).join(',')})
    ), removed AS (
      DELETE FROM mapping.${table} existing WHERE NOT EXISTS (
        SELECT 1 FROM incoming WHERE ${identity.map(field => `incoming.${field}=existing.${field}`).join(' AND ')})
    ) INSERT INTO mapping.${table} AS existing (${fields.join(',')})
      SELECT ${fields.join(',')} FROM incoming
      ON CONFLICT (${identity.join(',')}) ${conflict}`, [JSON.stringify(rows)]);
}
export async function applyContextSnapshot(pool, input, now = Date.now()) {
  const snapshot = parseContextSnapshot(input, now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query('SELECT pg_advisory_xact_lock(670067,1)');
    const old = (await client.query('SELECT captured_at FROM mapping.k67_context_state WHERE singleton=true FOR UPDATE')).rows[0];
    if (old && new Date(old.captured_at).getTime() > Date.parse(snapshot.capturedAt)) {
      throw new ContextError('CONTEXT_OLDER_SNAPSHOT');
    }
    const incoming = JSON.stringify(snapshot.accounts);
    const grants = JSON.stringify(snapshot.access);
    await client.query(`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS a(email text,google_subject text,role text,status text,can_access_all_classes boolean)
      ), rights AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(reviewer_email text,erp_course_class_id bigint)
      ), changed AS (
        SELECT a.email FROM mapping.reviewer_account a LEFT JOIN incoming i ON i.email=a.email
        WHERE i.email IS NULL OR a.status IS DISTINCT FROM i.status OR a.role IS DISTINCT FROM i.role
          OR a.can_access_all_classes IS DISTINCT FROM i.can_access_all_classes
          OR (i.google_subject IS NOT NULL AND a.google_subject IS DISTINCT FROM i.google_subject)
          OR EXISTS (SELECT 1 FROM mapping.reviewer_class_access r WHERE r.reviewer_email=a.email
             AND NOT EXISTS (SELECT 1 FROM rights n WHERE n.reviewer_email=r.reviewer_email AND n.erp_course_class_id=r.erp_course_class_id))
          OR EXISTS (SELECT 1 FROM rights n WHERE n.reviewer_email=a.email
             AND NOT EXISTS (SELECT 1 FROM mapping.reviewer_class_access r WHERE r.reviewer_email=n.reviewer_email AND r.erp_course_class_id=n.erp_course_class_id))
      ) UPDATE mapping.reviewer_session SET revoked_at=coalesce(revoked_at,now()),revoked_reason='context_changed'
        WHERE reviewer_email IN (SELECT email FROM changed) AND revoked_at IS NULL`, [incoming, grants]);
    await client.query("UPDATE mapping.reviewer_account SET status='disabled',updated_at=now() WHERE NOT (email=ANY($1::text[])) AND status<>'disabled'", [snapshot.accounts.map(row => row.email)]);
    // Gộp account thành một lần gọi; giữ Google binding khi nguồn trả NULL.
    // updated_at chỉ đổi khi nội dung account đổi; freshness vẫn ghi riêng bên dưới.
    await client.query(`INSERT INTO mapping.reviewer_account AS existing
        (email,google_subject,display_name,role,status,can_access_all_classes)
      SELECT email,google_subject,display_name,role,status,can_access_all_classes
        FROM jsonb_to_recordset($1::jsonb) AS a(email text,google_subject text,display_name text,role text,status text,can_access_all_classes boolean)
      ON CONFLICT(email) DO UPDATE SET
        google_subject=coalesce(EXCLUDED.google_subject,existing.google_subject),
        display_name=EXCLUDED.display_name,role=EXCLUDED.role,status=EXCLUDED.status,
        can_access_all_classes=EXCLUDED.can_access_all_classes,updated_at=now()
      WHERE ROW(existing.google_subject,existing.display_name,existing.role,existing.status,existing.can_access_all_classes)
        IS DISTINCT FROM ROW(coalesce(EXCLUDED.google_subject,existing.google_subject),EXCLUDED.display_name,EXCLUDED.role,EXCLUDED.status,EXCLUDED.can_access_all_classes)`, [incoming]);
    await reconcileRows(client, 'reviewer_class_access', snapshot.access);
    await reconcileRows(client, 'classroom_course_mapping', snapshot.classes);
    await reconcileRows(client, 'student_mapping_review', snapshot.students);
    await reconcileRows(client, 'erp_class_membership_snapshot', snapshot.memberships);
    await client.query(`INSERT INTO mapping.k67_context_state(singleton,api_version,product_id,source_revision,captured_at)
      VALUES(true,1,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET
        source_revision=EXCLUDED.source_revision,captured_at=EXCLUDED.captured_at,applied_at=now()`,
    [snapshot.productId, snapshot.sourceRevision, snapshot.capturedAt]);
    await client.query('COMMIT');
    return { sourceRevision: snapshot.sourceRevision, capturedAt: snapshot.capturedAt };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function fetchContextSnapshot({ url, secret, fetchImpl = fetch, now = Date.now() }) {
  const response = await fetchImpl(url, {
    headers: { 'x-k67-context-key': secret, accept: 'application/json' },
    signal: AbortSignal.timeout(5000), redirect: 'error'
  });
  if (!response.ok) throw new ContextError('CONTEXT_SOURCE_UNAVAILABLE');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > CONTEXT_MAX_BYTES) throw new ContextError('CONTEXT_TOO_LARGE');
    chunks.push(chunk);
  }
  let json;
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ContextError('CONTEXT_INVALID_JSON'); }
  return parseContextSnapshot(json, now);
}
