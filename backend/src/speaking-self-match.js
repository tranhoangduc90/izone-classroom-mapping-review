import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {OAuth2Client} from 'google-auth-library';
import {SpeakingHomeworkError} from './speaking-homework.js';

const reasons = {
  CLASS_MISMATCH: 'Nguồn bài nộp hoặc hồ sơ không còn khớp lớp.',
  OWNER_UNRESOLVED: 'Chưa xác định được tài khoản Google của chủ bài nộp.',
  MAPPING_CONFLICT: 'Hồ sơ, tài khoản hoặc chủ bài hiện tại đang có liên kết mâu thuẫn.',
};
const fail = (code, message) => { throw new SpeakingHomeworkError(code, message, 409); };
const signature = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

// Token chỉ công bố hạn và chữ ký. Server tra lại toàn bộ nguồn trước khi nhận lựa chọn.
export function createSpeakingSelfMatch({pool, secret, eligibleRefs, eligibleDocuments, now = Date.now}) {
  const allowed = new Set(eligibleRefs.map(ref => ref.toLowerCase()));
  const scoped = new Set(eligibleDocuments);
  if (!allowed.size || !scoped.size || secret.length < 32) throw new Error('SELF_MATCH_CONFIG_INVALID');
  async function inspect({documentId, assignmentCode, classCode}) {
    if (!scoped.has(documentId)) return {state: 'not_registered'};
    const {rows: [{state}]} = await pool.query(
      'SELECT speaking_independent.self_match($1,$2,$3) AS state', [documentId, assignmentCode, classCode || null]);
    return state;
  }
  async function record(input, reason, trustedClass, studentRef = null) {
    const key = digest([reason, input.documentId, input.assignmentCode, trustedClass, studentRef]);
    await pool.query(`INSERT INTO speaking_independent.self_match_notice
      (dedupe_key,reason,class_code,assignment_code,document_id,student_ref)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,
    [key, reason, trustedClass || 'Chưa xác định', input.assignmentCode, input.documentId, studentRef]);
  }
  async function entry(input) {
    const state = await inspect(input);
    if (Object.hasOwn(reasons, state.state)) {
      await record(input, state.state, state.classCode);
      fail(state.state, reasons[state.state]);
    }
    if (state.state === 'wrong_request_class') fail('CLASS_MISMATCH', 'Lớp đã chọn chưa khớp bản Docs này.');
    return state;
  }
  function sign(input, state, studentRefs, expires) {
    return signature(secret, JSON.stringify(['speaking-self-match-v1', input.documentId,
      input.assignmentCode, state.classCode, state.sourceKey, studentRefs, expires]));
  }
  function form(input, state) {
    if (state.state !== 'choose') return null;
    const studentRefs = state.students.map(student => student.student_ref).filter(ref => allowed.has(ref));
    if (!studentRefs.length) return null;
    const account = state.email.trim();
    if (!emailAddress.test(account)) return null;
    const expires = now() + 15 * 60_000;
    return {studentRefs, account,
      token: `${expires}.${sign(input, state, studentRefs, expires)}`};
  }
  async function confirm(input, workUnitId) {
    if (!allowed.has(input.studentRef)) fail('SELF_MATCH_INVALID', 'Hồ sơ chưa được mở xác nhận. Hãy tải lại danh sách.');
    const [expiry, received] = input.selfMatchToken.split('.');
    const expires = Number(expiry);
    if (!received || expires < now() || expires > now() + 15 * 60_000)
      fail('SELF_MATCH_EXPIRED', 'Màn xác nhận đã hết hạn. Hãy tải lại danh sách.');
    const state = await entry(input);
    if (!state.sourceKey || state.classCode !== input.classCode)
      fail('SELF_MATCH_INVALID', 'Nguồn bài đã thay đổi. Hãy tải lại trang để mở đúng bài.');
    const expected = sign(input, state, input.selfMatchStudentRefs, expires);
    if (received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
        || !input.selfMatchStudentRefs.includes(input.studentRef))
      fail('SELF_MATCH_INVALID', 'Lựa chọn chưa khớp màn xác nhận. Hãy tải lại danh sách.');
    const {rows: [{result}]} = await pool.query('SELECT speaking_independent.self_match($1,$2,$3,$4,$5,$6) AS result',
      [input.documentId, input.assignmentCode, input.classCode, input.studentRef, state.sourceKey, workUnitId]);
    if (result.state === 'confirmed') return result.decisionId;
    if (Object.hasOwn(reasons, result.state)) {
      await record(input, result.state, result.classCode, input.studentRef);
      fail(result.state, reasons[result.state]);
    }
    fail('SELF_MATCH_INVALID', 'Nguồn bài vừa thay đổi. Hãy tải lại trang để mở đúng bài.');
  }
  return {entry, form, confirm, record};
}

const emailAddress = /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;
export function createSpeakingSelfMatchMailer({to, from, accessToken, call = fetch}) {
  if (![to, from].every(address => typeof address === 'string' && emailAddress.test(address)))
    throw new Error('SELF_MATCH_EMAIL_CONFIG_INVALID');
  return async notice => {
    const title = `[IZONE] Cần xác minh Speaking · ${notice.class_code} · ${notice.id}`;
    const body = [`Mã ca: ${notice.id}`, `Lý do: ${reasons[notice.reason]}`,
      `Lớp: ${notice.class_code}`, `Bài: ${notice.assignment_code}`,
      `Hồ sơ đã chọn (mã nội bộ): ${notice.student_ref || 'Chưa chọn'}`,
      `Phát hiện lúc: ${new Date(notice.created_at).toISOString()}`,
      'Tra nhật ký nội bộ theo mã ca để kiểm nguồn và xử lý.'].join('\r\n');
    const raw = Buffer.from([`To: ${to}`, `From: ${from}`, `Subject: =?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(body).toString('base64').match(/.{1,76}/g).join('\r\n')].join('\r\n')).toString('base64url');
    const token = await accessToken();
    const response = await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({raw}),
    });
    if (!response.ok) throw new Error(`MAIL_HTTP_${response.status}`);
    const result = await response.json();
    if (typeof result.id !== 'string' || !result.id || result.id.length > 200) throw new Error('MAIL_ACK_MISSING');
    return result.id;
  };
}

export function speakingSelfMatchMailFromEnv(env) {
  const {clientId, clientSecret, refreshToken} = JSON.parse(readFileSync(env.SPEAKING_SELF_MATCH_MAIL_CREDENTIAL_FILE, 'utf8'));
  if (![clientId, clientSecret, refreshToken].every(value => typeof value === 'string' && value.trim()))
    throw new Error('SELF_MATCH_EMAIL_CONFIG_INVALID');
  const oauth = new OAuth2Client({clientId, clientSecret, credentials: {refresh_token: refreshToken},
    transporterOptions: {timeout: 8_000, retry: false}});
  return createSpeakingSelfMatchMailer({to: env.SPEAKING_SELF_MATCH_MAIL_TO, from: env.SPEAKING_SELF_MATCH_MAIL_FROM,
    async accessToken() {
      const {token} = await oauth.getAccessToken();
      if (!token) throw new Error('MAIL_AUTH_UNAVAILABLE');
      return token;
    }});
}

export async function deliverSpeakingSelfMatchNotice(pool, send) {
  const lease = randomUUID();
  const {rows: [notice]} = await pool.query(`WITH next AS (
    SELECT id FROM speaking_independent.self_match_notice WHERE sent_at IS NULL AND attempts < 8
      AND available_at <= now() AND (lease_until IS NULL OR lease_until < now())
    ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE speaking_independent.self_match_notice n
    SET lease_id=$1, lease_until=now()+interval '2 minutes', attempts=attempts+1
    FROM next WHERE n.id=next.id RETURNING n.*`, [lease]);
  if (!notice) return false;
  try {
    const messageId = await send(notice);
    await pool.query(`UPDATE speaking_independent.self_match_notice SET sent_at=now(),message_id=$3,
      lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_id=$2`, [notice.id, lease, messageId]);
  } catch (error) {
    const code = /^MAIL_(HTTP_\d{3}|ACK_MISSING|AUTH_UNAVAILABLE)$/.test(error.message) ? error.message : 'MAIL_DELIVERY_ERROR';
    await pool.query(`UPDATE speaking_independent.self_match_notice SET lease_id=NULL,lease_until=NULL,last_error=$3,
      available_at=now()+($4::integer*interval '1 second') WHERE id=$1 AND lease_id=$2`,
    [notice.id, lease, code, Math.min(300, 2 ** notice.attempts * 5)]);
  }
  return true;
}

export function startSpeakingSelfMatchMailer({pool, send}) {
  if (!send) return {stop: async () => {}};
  let running = Promise.resolve();
  let timer;
  let stopped = false;
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      running = deliverSpeakingSelfMatchNotice(pool, send)
        .catch(error => console.error('Hàng email xác minh Speaking:', String(error.code || 'MAIL_QUEUE_ERROR')))
        .finally(schedule);
    }, 5_000).unref();
  }
  schedule();
  return {async stop() { stopped = true; clearTimeout(timer); await running; }};
}
