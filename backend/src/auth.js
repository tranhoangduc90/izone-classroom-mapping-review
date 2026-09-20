import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

function sessionSettings(config) {
  return {
    cookieName: config.teacherSessionCookieName || 'izone_teacher_session',
    cookiePath: config.teacherSessionCookiePath || '/mapping-api',
    cookieSecure: config.teacherSessionCookieSecure ?? config.nodeEnv === 'production',
    cookiePartitioned: config.teacherSessionCookiePartitioned ?? config.nodeEnv === 'production',
    cookieSameSite: config.teacherSessionCookieSameSite || (config.nodeEnv === 'production' ? 'None' : 'Lax'),
    idleDays: config.teacherSessionIdleDays || 90,
    absoluteDays: config.teacherSessionAbsoluteDays || 365
  };
}

function readCookie(req, name) {
  const header = String(req.get('cookie') || '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function sessionCookie(settings, value, maxAgeSeconds) {
  const parts = [
    `${settings.cookieName}=${encodeURIComponent(value)}`,
    `Path=${settings.cookiePath}`,
    'HttpOnly',
    `SameSite=${settings.cookieSameSite}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (settings.cookieSecure) parts.push('Secure');
  if (settings.cookiePartitioned) parts.push('Partitioned');
  return parts.join('; ');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest();
}

function reviewerFromAccount(account, fallbackName = '') {
  return {
    email: account.email,
    displayName: account.display_name || fallbackName || account.email,
    role: account.role,
    canAccessAllClasses: Boolean(account.can_access_all_classes)
  };
}

function requireSessionCsrf(req, res, config) {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.get('origin') || '';
  if (req.get('x-izone-csrf') === '1' && config.allowedOrigins.has(origin)) return true;
  res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Yêu cầu thay đổi dữ liệu không hợp lệ.' });
  return false;
}

// Nhận Google credential đúng một lần để mở phiên dài hạn. Cookie thô chỉ ở trình duyệt;
// database chỉ nhận SHA-256 nên không thể dùng bản ghi database để giả mạo phiên.
export function createAuthService({ config, pool, verifyGoogleToken }) {
  const settings = sessionSettings(config);
  const oauthClient = new OAuth2Client(config.googleClientId || undefined);
  const verifyToken = verifyGoogleToken || (async token => {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: config.googleClientId });
    return ticket.getPayload();
  });

  async function accountFromGoogleToken(token) {
    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      return { error: 'unauthorized' };
    }
    const email = String(payload?.email || '').trim().toLowerCase();
    const googleSubject = String(payload?.sub || '').trim();
    if (!email || !googleSubject || payload?.email_verified !== true) return { error: 'unauthorized' };

    const result = await pool.query(
      `UPDATE mapping.reviewer_account
       SET google_subject = COALESCE(google_subject, $2), last_login_at = now(), updated_at = now()
       WHERE email = $1 AND status = 'active' AND (google_subject IS NULL OR google_subject = $2)
       RETURNING email, display_name, role, can_access_all_classes`,
      [email, googleSubject]
    );
    if (result.rowCount !== 1) return { error: 'forbidden' };
    return { reviewer: reviewerFromAccount(result.rows[0], payload.name), googleSubject };
  }

  async function accountFromSession(rawToken) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const result = await pool.query(
      `UPDATE mapping.reviewer_session AS session
       SET last_seen_at = now(),
           idle_expires_at = LEAST(session.absolute_expires_at, now() + ($2::int * interval '1 day'))
       FROM mapping.reviewer_account AS account
       WHERE session.token_hash = $1
         AND session.reviewer_email = account.email
         AND session.google_subject = account.google_subject
         AND session.revoked_at IS NULL
         AND session.idle_expires_at > now()
         AND session.absolute_expires_at > now()
         AND account.status = 'active'
       RETURNING account.email, account.display_name, account.role,
                 account.can_access_all_classes, session.idle_expires_at, session.absolute_expires_at`,
      [tokenHash(rawToken), settings.idleDays]
    );
    if (result.rowCount !== 1) return null;
    return { reviewer: reviewerFromAccount(result.rows[0]), row: result.rows[0] };
  }

  function refreshCookie(res, rawToken, row) {
    const idleExpiry = new Date(row.idle_expires_at).getTime();
    const absoluteExpiry = new Date(row.absolute_expires_at).getTime();
    const fallbackMs = settings.idleDays * 86_400_000;
    const remainingMs = Math.min(
      Number.isFinite(idleExpiry) ? idleExpiry - Date.now() : fallbackMs,
      Number.isFinite(absoluteExpiry) ? absoluteExpiry - Date.now() : fallbackMs
    );
    res.append('Set-Cookie', sessionCookie(settings, rawToken, Math.max(0, remainingMs / 1000)));
  }

  async function authenticate(req, res, next) {
    if (config.authMode === 'legacy') {
      if (!constantTimeEqual(req.get('x-review-token'), config.legacyReviewToken)) return unauthorized(res);
      req.reviewer = { email: 'legacy@mapping.local', displayName: 'Truy cập chuyển tiếp', role: 'admin', canAccessAllClasses: true };
      req.authSource = 'legacy';
      return next();
    }

    const rawSession = readCookie(req, settings.cookieName);
    if (rawSession) {
      const session = await accountFromSession(rawSession);
      if (session) {
        req.reviewer = session.reviewer;
        req.authSource = 'session';
        req.teacherSessionToken = rawSession;
        if (req.method !== 'DELETE') refreshCookie(res, rawSession, session.row);
        if (!requireSessionCsrf(req, res, config)) return undefined;
        return next();
      }
    }

    // Giữ Bearer cũ trong giai đoạn phát hành cuốn chiếu để frontend đang mở không bị gián đoạn.
    const authorization = req.get('authorization') || '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!bearer) {
      if (rawSession) res.append('Set-Cookie', sessionCookie(settings, '', 0));
      return unauthorized(res);
    }
    const account = await accountFromGoogleToken(bearer);
    if (account.error === 'forbidden') return forbidden(res);
    if (account.error) return unauthorized(res);
    req.reviewer = account.reviewer;
    req.authSource = 'google_bearer';
    return next();
  }

  async function login(req, res) {
    if (config.authMode !== 'google') return res.status(503).json({ ok: false, error: 'SESSION_LOGIN_DISABLED' });
    const credential = typeof req.body?.credential === 'string' ? req.body.credential.trim() : '';
    if (credential.length < 20 || credential.length > 8192) return unauthorized(res);
    const account = await accountFromGoogleToken(credential);
    if (account.error === 'forbidden') return forbidden(res);
    if (account.error) return unauthorized(res);

    const rawSession = crypto.randomBytes(32).toString('base64url');
    const inserted = await pool.query(
      `INSERT INTO mapping.reviewer_session (
         token_hash, reviewer_email, google_subject, idle_expires_at, absolute_expires_at
       ) VALUES (
         $1, $2, $3, now() + ($4::int * interval '1 day'), now() + ($5::int * interval '1 day')
       )
       RETURNING idle_expires_at, absolute_expires_at`,
      [tokenHash(rawSession), account.reviewer.email, account.googleSubject, settings.idleDays, settings.absoluteDays]
    );
    refreshCookie(res, rawSession, inserted.rows[0] || {});
    return res.status(201).json({ ok: true, reviewer: account.reviewer });
  }

  async function logout(req, res) {
    const rawSession = req.teacherSessionToken || readCookie(req, settings.cookieName);
    if (rawSession) {
      await pool.query(
        `UPDATE mapping.reviewer_session
         SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, 'logout')
         WHERE token_hash = $1`,
        [tokenHash(rawSession)]
      );
    }
    res.append('Set-Cookie', sessionCookie(settings, '', 0));
    return res.json({ ok: true });
  }

  return { authenticate, login, logout };
}

// Export cũ được giữ để test hoặc module ngoài repo chưa cần đổi đồng thời.
export function createAuthMiddleware(dependencies) {
  return createAuthService(dependencies).authenticate;
}
