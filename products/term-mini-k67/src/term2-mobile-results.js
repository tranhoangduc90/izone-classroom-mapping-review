import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { explanationAttemptSql, loadAnswerExplanations } from './answer-explanations.js';

const slug = 'term-test-2';
const prefix = '/api/term-tests/term-test-2/mobile-results';
const lifetime = 24 * 60 * 60;
const classPattern = /^[A-Z0-9._-]{2,32}$/;
const mode = z.enum(['lis_first', 'read_first']);
const issueInput = z.object({
  examSessionToken: z.uuid(), generation: z.number().int().nonnegative(),
  deviceProof: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const readInput = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{75,280}$/),
  classCode: z.string().regex(classPattern).nullable(),
  examMode: mode.nullable()
}).strict();
const domain = Buffer.from('term2-k67-mobile-review:v1');
const scopeSql = `SELECT s.id AS session_id, s.generation, s.exam_mode, s.class_name_snapshot AS class_name,
    s.student_name_snapshot AS student_name, j.student_ref, j.device_hash, j.audio_hash,
    a.id AS attempt_id, a.completed_at, a.writing_submitted_at, a.combined_result
  FROM assessment.term_test_exam_session s
  JOIN assessment.term_k67_cbt_journey j ON j.session_id = s.id AND j.generation = s.generation
  LEFT JOIN assessment.term_test_attempt a ON a.id = s.attempt_id AND a.exam_session_id = s.id
    AND a.generation = s.generation AND a.definition_version = s.definition_version
    AND a.erp_course_class_id = s.erp_course_class_id AND a.erp_student_contact_id = s.erp_student_contact_id
    AND a.test_slug = s.test_slug AND a.superseded_at IS NULL AND a.writing_scope = 'exam'
    AND a.attempt_mode IN ('legacy','cbt') AND a.exam_delivery <> 'answer_sheet'
  WHERE s.id = $1 AND s.test_slug = 'term-test-2' AND s.attempt_mode IN ('legacy','cbt')
    AND s.superseded_at IS NULL AND j.audio_hash <> 'paper'`;

function ownerMatches(row, proof, permit, secret) {
  if (!row || !/^[a-f0-9]{64}$/.test(permit || '')) return false;
  const hash = createHash('sha256').update(proof).digest('hex');
  if (hash !== row.device_hash) return false;
  const expected = createHmac('sha256', secret).update([
    'term2-k67-cbt-journey-v1', row.session_id, row.generation, row.student_ref, row.device_hash, row.audio_hash
  ].join(':')).digest();
  return timingSafeEqual(expected, Buffer.from(permit, 'hex'));
}

function encode(key, row, expires) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(domain);
  // Keep native session and attempt identifiers opaque on the second device.
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify([row.session_id, row.attempt_id, expires])), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function decode(key, code, now) {
  try {
    const bytes = Buffer.from(code, 'base64url');
    if (bytes.toString('base64url') !== code) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      .setAAD(domain).setAuthTag(bytes.subarray(12, 28));
    const [session, attempt, expires] = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
    return Number.isSafeInteger(expires) && expires > now ? {session, attempt} : null;
  } catch {
    return null;
  }
}

const published = row => Boolean(row?.completed_at && row.writing_submitted_at && row.combined_result);
const allowed = (row, binding, input) => row?.attempt_id === binding.attempt
  && (!input.classCode || row.class_name.trim().toUpperCase() === input.classCode)
  && (!input.examMode || row.exam_mode === input.examMode);

export function mountTerm2MobileResults(app, {config, pool, limiter, readGrading, logEvent, now = Date.now}) {
  const secret = config.termTestSessionSecret;
  if (!config.term2MobileResultsEnabled || !secret || secret.length < 32) return;
  const key = createHmac('sha256', secret).update(domain).digest();
  const seconds = () => Math.floor(now() / 1000);
  const readScope = async session => (await pool.query(scopeSql, [session])).rows[0];
  function event(req, outcome, session) {
    try {
      const started = req.mobileReviewStarted;
      logEvent?.('mobile_result_access', slug, session || 'unverified',
        {action: req.path.slice(prefix.length + 1), outcome, durationMs: Math.round(performance.now() - started)});
    } catch { /* Result access stays available during a journal outage. */ }
  }
  function fail(req, res, status, error, message, session) {
    event(req, error, session);
    return res.status(status).json({ok: false, error, message});
  }
  const denied = (req, res) => fail(req, res, 403, 'MOBILE_REVIEW_DENIED',
    'Mã xem hết hạn hoặc không khớp bài thi. Hãy lấy mã mới từ máy tính đã dùng để thi.');
  const wait = (req, res, session) => fail(req, res, 409, 'MOBILE_REVIEW_NOT_PUBLISHED',
    'Chưa thể xem kết quả. Hãy kiểm tra bài đã nộp đủ và kết quả đã được công bố.', session);
  const start = (req, res, next) => {
    req.mobileReviewStarted = performance.now();
    res.set('Cache-Control', 'no-store, private');
    next();
  };

  app.post(prefix + '/issue', start, limiter, async (req, res) => {
    const input = issueInput.safeParse(req.body);
    if (!input.success) return denied(req, res);
    const body = input.data;
    const row = await readScope(body.examSessionToken);
    if (!ownerMatches(row, body.deviceProof, req.get('x-term2-permit'), secret)
        || Number(row.generation) !== body.generation) return denied(req, res);
    if (!published(row)) return wait(req, res, row.session_id);
    event(req, 'ok', row.session_id);
    return res.json({ok: true, code: encode(key, row, seconds() + lifetime), expiresInSeconds: lifetime});
  });

  for (const action of ['result', 'explanations']) {
    app.post(prefix + '/' + action, start, limiter, async (req, res) => {
      const input = readInput.safeParse(req.body);
      const binding = input.success && decode(key, input.data.code, seconds());
      if (!binding) return denied(req, res);
      const row = await readScope(binding.session);
      if (!allowed(row, binding, input.data)) return denied(req, res);
      if (!published(row)) return wait(req, res, row.session_id);
      let response;
      if (action === 'result') {
        const grading = await readGrading?.(row.attempt_id);
        response = {ok: true, completed: true, className: row.class_name, studentName: row.student_name,
          result: row.combined_result, writing: {submitted: true, grading: grading || null}};
      } else {
        const {rows} = await pool.query(explanationAttemptSql, [row.attempt_id]);
        try {
          const review = rows[0] && await loadAnswerExplanations(config.termTestAssetDir, rows[0]);
          if (!review) return fail(req, res, 404, 'EXPLANATIONS_UNAVAILABLE', 'Lời giải chưa sẵn sàng.', row.session_id);
          response = {ok: true, review};
        } catch (error) {
          if (!/^EXPLANATION_/.test(error.message)) throw error;
          return fail(req, res, 409, 'EXPLANATION_VERSION_MISMATCH', 'Lời giải chưa khớp phiên bản đề.', row.session_id);
        }
      }
      // Recheck scope and expiry after grading / file I/O.
      const current = await readScope(binding.session);
      if (!allowed(current, binding, input.data) || !decode(key, input.data.code, seconds())) return denied(req, res);
      if (!published(current)) return wait(req, res, row.session_id);
      event(req, 'ok', row.session_id);
      return res.json(response);
    });
  }
}
