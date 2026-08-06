import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

function unauthorized(res) {
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
}

function forbidden(res) {
  return res.status(403).json({ ok: false, error: 'ACCESS_DENIED', message: 'Tài khoản Google này chưa được cấp quyền.' });
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

// Xác thực Google ID token; token chỉ tồn tại trong bộ nhớ trình duyệt và header request.
export function createAuthMiddleware({ config, pool, verifyGoogleToken }) {
  const oauthClient = new OAuth2Client(config.googleClientId || undefined);
  const verifyToken = verifyGoogleToken || (async token => {
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: config.googleClientId
    });
    return ticket.getPayload();
  });

  return async function authenticate(req, res, next) {
    if (config.authMode === 'legacy') {
      if (!constantTimeEqual(req.get('x-review-token'), config.legacyReviewToken)) return unauthorized(res);
      req.reviewer = {
        email: 'legacy@mapping.local',
        displayName: 'Truy cập chuyển tiếp',
        role: 'admin',
        canAccessAllClasses: true
      };
      return next();
    }

    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token) return unauthorized(res);

    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      return unauthorized(res);
    }
    const email = String(payload?.email || '').trim().toLowerCase();
    const googleSubject = String(payload?.sub || '').trim();
    if (!email || !googleSubject || payload?.email_verified !== true) return unauthorized(res);

    const result = await pool.query(
      `UPDATE mapping.reviewer_account
       SET
         google_subject = COALESCE(google_subject, $2),
         last_login_at = now(),
         updated_at = now()
       WHERE email = $1
         AND status = 'active'
         AND (google_subject IS NULL OR google_subject = $2)
       RETURNING email, display_name, role, can_access_all_classes`,
      [email, googleSubject]
    );
    if (result.rowCount !== 1) return forbidden(res);

    const account = result.rows[0];
    req.reviewer = {
      email: account.email,
      displayName: account.display_name || payload.name || account.email,
      role: account.role,
      canAccessAllClasses: Boolean(account.can_access_all_classes)
    };
    return next();
  };
}
