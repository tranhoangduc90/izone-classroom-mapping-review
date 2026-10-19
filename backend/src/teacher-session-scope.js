// Quyền và dữ liệu cùng một snapshot SQL; không dùng cờ admin đã đọc trước khi bị thu hồi.
import crypto from 'node:crypto';

export class TeacherSessionScopeError extends Error {
  constructor() {
    super('Phiên giảng viên không còn hợp lệ. Vui lòng đăng nhập lại.');
    this.name = 'TeacherSessionScopeError';
    this.code = 'UNAUTHORIZED';
    this.httpStatus = 401;
  }
}

// Chỉ nhận SQL nội bộ và vị trí placeholder cố định từ route, không nhận SQL của người dùng.
export async function queryTeacherSessionScope(pool, req, text, values, emailIndex, adminIndex) {
  if (!['session', 'google_bearer'].includes(req.authSource)) return pool.query(text, values);
  if (![emailIndex, adminIndex].every(i => Number.isInteger(i) && i > 0 && i <= values.length)) {
    throw new TypeError('Vị trí quyền giảng viên không hợp lệ.');
  }
  const hashIndex = values.length + 1;
  const tokenHash = req.authSource === 'session'
    ? crypto.createHash('sha256').update(req.teacherSessionToken).digest()
    : null;
  const scoped = text.trim().replace(/;$/, '')
    .replace(new RegExp('\\$' + emailIndex + '\\b', 'g'), `(SELECT email FROM current_teacher_scope)`)
    .replace(new RegExp('\\$' + adminIndex + '\\b', 'g'), `COALESCE((SELECT can_access_all_classes FROM current_teacher_scope), false)`);
  // Giữ type cho các tham số cũ ngay cả khi chúng chỉ còn được dùng trong CTE này.
  const guarded = `WITH current_teacher_scope AS MATERIALIZED (
    SELECT account.email,
      (account.role = 'admin' OR account.can_access_all_classes) AND $${adminIndex}::boolean AS can_access_all_classes
    FROM mapping.reviewer_account AS account
    WHERE account.email = $${emailIndex}::text AND account.status = 'active'
      AND ($${hashIndex}::bytea IS NULL OR EXISTS (
        SELECT 1 FROM mapping.reviewer_session AS session
        WHERE session.token_hash = $${hashIndex}::bytea
          AND session.reviewer_email = account.email
          AND session.google_subject = account.google_subject
          AND session.revoked_at IS NULL
          AND session.idle_expires_at > now() AND session.absolute_expires_at > now()
      ))
  ), protected_teacher_data AS (${scoped})
  SELECT protected_teacher_data.*,
    EXISTS (SELECT 1 FROM current_teacher_scope) AS teacher_session_scope_valid
  FROM protected_teacher_data;`;
  const result = await pool.query(guarded, [...values, tokenHash]);
  if (result.rows.some(row => row.teacher_session_scope_valid === false)) throw new TeacherSessionScopeError();
  return result;
}
