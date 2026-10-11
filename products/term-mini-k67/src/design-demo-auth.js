// Mọi tài khoản Google đã xác minh được mở riêng demo IC2200 theo yêu cầu của Đức.
// Cookie riêng chỉ chứa chứng thực Google đã ký; không tạo tài khoản hay quyền quản lý lớp.
import { OAuth2Client } from 'google-auth-library';

const NAME = 'izone_k67_demo_google';
const PATH = '/term-mini-k67-api/api/term-tests/teacher/design-demo';
export function createDemoGoogleAuth({ config, verifyGoogleToken }) {
  const client = new OAuth2Client(config.googleClientId || undefined);
  const verify = verifyGoogleToken || (async credential => (await client.verifyIdToken({
    idToken: credential, audience: config.googleClientId
  })).getPayload());
  const cookie = (value, age) => `${NAME}=${encodeURIComponent(value)}; Path=${PATH}; HttpOnly; Max-Age=${age}; ${config.nodeEnv === 'production' ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax'}`;
  const deny = res => res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Hãy đăng nhập Google để mở demo.' });
  function originAllowed(req) {
    return config.allowedOrigins?.has(req.get('origin'));
  }
  async function identity(credential) {
    if (typeof credential !== 'string' || credential.length < 20 || credential.length > 8192) return null;
    try {
      const p = await verify(credential);
      if (!p?.sub || !p.email || p.email_verified !== true || !Number.isFinite(p.exp) || p.exp * 1000 <= Date.now()) return null;
      return { reviewer: { email: p.email, displayName: p.name || p.email }, subject: p.sub, expires: p.exp };
    } catch { return null; }
  }
  async function login(req, res) {
    if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'ORIGIN_REJECTED' });
    const credential = req.body?.credential, user = await identity(credential);
    if (!user) return deny(res);
    const age = Math.max(0, Math.min(3600, Math.floor(user.expires - Date.now() / 1000)));
    res.append('Set-Cookie', cookie(credential, age));
    return res.status(201).json({ ok: true, reviewer: user.reviewer });
  }
  async function authenticate(req, res, next) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (!originAllowed(req) || req.get('x-izone-csrf') !== '1')) {
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED' });
    }
    const value = String(req.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(NAME + '='));
    let credential = '';
    try { credential = decodeURIComponent(value?.slice(NAME.length + 1) || ''); } catch {}
    const user = await identity(credential);
    if (!user) return deny(res);
    req.reviewer = user.reviewer;
    req.demoGoogleSubject = user.subject;
    return next();
  }
  function logout(_req, res) {
    res.append('Set-Cookie', cookie('', 0));
    return res.json({ ok: true });
  }
  return { login, authenticate, logout,
    readAuthorization: req => ({ source: 'demo_google', googleSubject: req.demoGoogleSubject }) };
}
