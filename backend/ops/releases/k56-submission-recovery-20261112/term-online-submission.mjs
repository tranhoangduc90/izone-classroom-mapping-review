import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical as canonicalAnswers } from './submission-status.mjs';
import { createK56HoldStore, holdEnabled, submissionHoldPolicy } from './term1-submission-hold.mjs';

const terms = new Set(['term-test-1-k56', 'term-test-2-k56']);
const identity = z.object({
  classCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  studentRef: z.string().uuid(),
  attemptToken: z.string().uuid(),
  examSessionToken: z.string().uuid(),
  generation: z.number().int().nonnegative().safe(),
  operationId: z.string().uuid()
});
const capture = identity.extend({ capturedAt: z.string().datetime(), automatic: z.boolean() }).strict();
const traceId = z.string().uuid();
const store = createK56HoldStore('term_online');
const digest = value => createHash('sha256').update(value).digest('hex');
const writingFrom = row => ({
  task1: row.writing_task_1, task2: row.writing_task_2, outline: row.writing_outline
});
const contentsMatch = (row, operation) => operation.section === 'writing'
  ? Object.entries(writingFrom(row)).every(([key, value]) => operation.writing[key] === value)
  : canonicalAnswers(row[operation.section + '_answers']) === canonicalAnswers(operation.answers);

export function onlineRecoveryCapability(attempt) {
  return terms.has(attempt.test_slug) && holdEnabled(attempt) ? { submissionRecoveryVersion: 1 } : {};
}

export function createTermOnlineRecovery({ pool, transaction, load, assertRetainedIdentity, assertLegacyWrite,
  rejectMainSkillIfBound, parseStoredTest, serialize, resultFor, record, failure, readWritingResponse }) {
  const policy = submissionHoldPolicy('term_online');
  if (policy.configured) setInterval(() => { void store.expire(pool).catch(() => {}); }, 15000).unref();

  async function enroll(attempt, input) {
    if (!terms.has(attempt.test_slug) || !input.submissionRecovery || holdEnabled(attempt)
        || !policy.admits(attempt.class_name_snapshot)) return attempt;
    const offlineRun = attempt.test_slug === 'term-test-1-k56' ? 'term1_offline_run' : 'term2_offline_run';
    const { rows: [limits] } = await pool.query(`UPDATE assessment.term_test_attempt a
      SET submission_hold_hours=$2, submission_hold_limit=$3
      WHERE id=$1 AND superseded_at IS NULL AND submission_hold_hours=0
        AND NOT EXISTS (SELECT 1 FROM assessment.${offlineRun} r WHERE r.attempt_id=a.id AND r.generation=a.generation)
      RETURNING submission_hold_hours, submission_hold_limit`,
    [attempt.attempt_token, policy.hours, policy.limit]);
    if (limits) return { ...attempt, ...limits };
    const { rows: [current] } = await pool.query(`SELECT submission_hold_hours, submission_hold_limit
      FROM assessment.term_test_attempt WHERE id=$1 AND superseded_at IS NULL`, [attempt.attempt_token]);
    return { ...attempt, ...current };
  }

  function parse(schema, input) {
    const result = schema.safeParse(input);
    if (!result.success) throw failure('INVALID_SUBMISSION_RECOVERY', 'Thông tin bản chốt chưa hợp lệ.', 400);
    return result.data;
  }

  async function admit(client, slug, proof, section, lock) {
    if (!terms.has(slug)) throw failure('SUBMISSION_RECOVERY_NOT_ENABLED', 'Đường đối soát này chưa mở.', 403);
    const a = await load(client, slug, proof.attemptToken, false, lock, false);
    if (!holdEnabled(a) || a.exam_session_token !== proof.examSessionToken
        || Number(a.generation) !== proof.generation || Number(a.session_generation) !== proof.generation
        || a.session_superseded_at || a.attempt_mode !== 'cbt' || a.session_attempt_mode !== 'cbt') {
      throw failure('SUBMISSION_RECOVERY_SCOPE', 'Lượt thi hoặc quyền đã thay đổi. Hãy giữ bản trên thiết bị.', 403);
    }
    await assertRetainedIdentity(client, a, proof);
    if (lock) {
      await assertLegacyWrite(client, slug, a.attempt_token);
      if (slug === 'term-test-1-k56') await rejectMainSkillIfBound(client, a, section);
      const offlineRun = slug === 'term-test-1-k56' ? 'term1_offline_run' : 'term2_offline_run';
      const { rows } = await client.query(`SELECT 1 FROM assessment.${offlineRun}
        WHERE attempt_id=$1 AND generation=$2`, [a.attempt_token, proof.generation]);
      if (rows.length) throw failure('OFFLINE_ALREADY_PREPARED', 'Hãy tiếp tục trên thiết bị đã mở bài offline.', 409);
    }
    return a;
  }

  async function stored(db, a, operation) {
    const { rows: [row] } = await db.query(`SELECT receipt FROM assessment.term_online_submission_hold
      WHERE attempt_id=$1 AND generation=$2 AND operation_id=$3 AND section=$4`,
    [a.attempt_token, operation.generation, operation.operationId, operation.section]);
    return row?.receipt || undefined;
  }

  async function hasOtherWritingReceipt(db, a, operation) {
    if (operation.section !== 'writing') return false;
    const { rows } = await db.query(`SELECT 1 FROM assessment.term_online_submission_hold
      WHERE attempt_id=$1 AND generation=$2 AND section='writing' AND receipt IS NOT NULL AND operation_id<>$3`,
    [a.attempt_token, operation.generation, operation.operationId]);
    return rows.length > 0;
  }

  function describe(req, input, operation) {
    const requestId = traceId.safeParse(req.get('x-exam-journal-request-id'));
    return { operationId: input.operationId, section: operation.section, generation: input.generation,
      revision: operation.revision, ...(requestId.success ? { requestId: requestId.data } : {}) };
  }

  async function retain(req, slug, section, body) {
    if (req.body?.recovery === undefined) return;
    const proof = parse(capture, req.body.recovery);
    if ((body.attemptToken && body.attemptToken !== proof.attemptToken)
        || (body.examSessionToken && body.examSessionToken !== proof.examSessionToken)
        || (body.studentRef && body.studentRef !== proof.studentRef)
        || (body.classCode && body.classCode !== proof.classCode)) {
      throw failure('SUBMISSION_RECOVERY_SCOPE', 'Thông tin bản chốt không khớp lượt thi.', 403);
    }
    const operation = { operationId: proof.operationId, attemptToken: proof.attemptToken, generation: proof.generation,
      section, revision: body.draftRevision ?? null, capturedAt: proof.capturedAt, automatic: proof.automatic,
      ...(section === 'writing' ? { writing: body.writing } : { answers: body.answers }) };
    const hash = digest(JSON.stringify(section === 'writing'
      ? operation : { ...operation, answers: canonicalAnswers(operation.answers) }));
    const meta = describe(req, proof, operation);
    const result = await transaction(async client => {
      const a = await admit(client, slug, proof, section, true);
      if (section === 'writing') {
        const unused = slug === 'term-test-1-k56' ? 'task1' : 'task2';
        if (body.writing[unused] !== '')
          throw failure('INVALID_WRITING_TASK', 'Bản chốt chứa Task không thuộc đề Writing của lượt thi.', 400);
      } else {
        const definition = parseStoredTest(a)[section + '_definition'];
        const keys = new Set(definition.questions.flatMap(q => q.compound?.keys || [String(q.number)]));
        if (Object.keys(operation.answers).some(key => !keys.has(key)))
          throw failure('OFFLINE_ANSWER_KEYS', 'Có ô không thuộc định nghĩa đã ghim.', 400);
      }
      await store.assertIdentity(client, a.attempt_token, operation, hash);
      const receipt = await stored(client, a, operation);
      if (receipt) return { receipt, a };
      return store.hold(client, a.attempt_token, operation, hash, a);
    }).catch(error => {
      record('offline_request_failed', slug, proof.attemptToken, { ...meta, phase: 'hold',
        errorCode: error.status ? error.code : 'OFFLINE_HOLD_UNAVAILABLE' });
      if (error.status) throw error;
      throw failure('OFFLINE_HOLD_UNAVAILABLE', 'Chưa lưu được bản đối soát. Hãy giữ bản trên thiết bị.', 503);
    });
    if (result.held) record('offline_submission_held', slug, proof.attemptToken, { ...meta, phase: 'hold',
      heldAtMs: result.held.heldAt, expiresAtMs: result.held.expiresAt, replayed: result.replayed,
      capturedAtMs: Date.parse(proof.capturedAt), automatic: proof.automatic,
      ...(section === 'writing' ? {
        task1Length: body.writing.task1.length, task2Length: body.writing.task2.length
      } : { answeredCount: Object.values(body.answers).filter(Boolean).length }) });
    return { ...result, operation, proof, hash, meta };
  }

  async function read(req, slug) {
    const input = parse(identity.extend({ section: z.enum(['listening', 'reading', 'writing']) }).strict(), req.body);
    const { a, receipt, held, review, response } = await transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const a = await admit(client, slug, input, input.section, false);
      const receipt = await stored(client, a, input);
      if (receipt) return { a, receipt, response: input.section === 'writing'
        ? await readWritingResponse(client, a)
        : { ...serialize(a), result: resultFor(a), portalSyncStatus: 'unknown', resultAvailable: true } };
      const entry = await store.read(client, a.attempt_token, input);
      const held = entry?.section === input.section ? entry.held : undefined;
      if (!held || !a[input.section + '_submitted_at']) return { a, held };
      const field = input.section === 'writing' ? 'writing' : 'answers';
      const contents = input.section === 'writing' ? writingFrom(a) : a[input.section + '_answers'] || {};
      const { rows: [row] } = await client.query(`SELECT (payload->$4::text) IS DISTINCT FROM $5::jsonb AS differs
        FROM assessment.term_online_submission_hold WHERE attempt_id=$1 AND generation=$2 AND operation_id=$3`,
      [a.attempt_token, input.generation, input.operationId, field, JSON.stringify(contents)]);
      if (row?.differs) return { a, held, review: 'SUBMISSION_DIFFERENT_CANONICAL' };
      const otherReceipt = await hasOtherWritingReceipt(client, a, input);
      return { a, held, review: otherReceipt ? 'WRITING_ALREADY_RECEIVED' : undefined };
    });
    if (held) record('offline_submission_hold_read', slug, a.attempt_token, { ...describe(req, input, input),
      phase: 'readback', heldAtMs: held.heldAt, expiresAtMs: held.expiresAt });
    return { ok: true, persisted: Boolean(receipt), receipt: receipt || null, ...(held ? { held } : {}),
      ...(review ? { recoveryReview: review } : {}),
      ...(receipt ? { response } : {}) };
  }

  async function finish(client, a, retained) {
    if (!retained) return {};
    const { operation, hash, proof } = retained;
    if (a.exam_session_token !== proof.examSessionToken || Number(a.generation) !== proof.generation)
      throw failure('SUBMISSION_RECOVERY_SCOPE', 'Lượt thi đã thay đổi. Hãy giữ bản trên thiết bị.', 403);
    const receipt = await stored(client, a, operation);
    if (receipt) return { receipt };
    const section = operation.section;
    if (!contentsMatch(a, operation)) {
      return { review: 'SUBMISSION_DIFFERENT_CANONICAL', held: retained.held };
    }
    if (await hasOtherWritingReceipt(client, a, operation)) {
      return { review: 'WRITING_ALREADY_RECEIVED', held: retained.held };
    }
    const result = { version: 1, receiptId: randomUUID(), operationId: operation.operationId, testSlug: a.test_slug,
      attemptToken: a.attempt_token, examSessionToken: a.exam_session_token, generation: proof.generation, section,
      revision: operation.revision, payloadHash: hash, submittedAt: new Date(a[section + '_submitted_at']).toISOString() };
    const written = await client.query(`UPDATE assessment.term_online_submission_hold SET receipt=$4::jsonb,payload=NULL
      WHERE attempt_id=$1 AND generation=$2 AND operation_id=$3 AND receipt IS NULL
        AND payload IS NOT NULL AND expires_at>clock_timestamp() RETURNING receipt`,
    [a.attempt_token, proof.generation, operation.operationId, JSON.stringify(result)]);
    if (written.rowCount !== 1) throw Error('Online submission receipt could not be committed');
    return { receipt: result };
  }

  return { enroll, retain, read, finish, admit,
    finishIfReplayed: (client, a, retained) => stored(client, a, retained.operation) };
}
