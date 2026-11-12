"""Overlay the qualified online Term K56 receiver on the verified K56 runtime."""
from pathlib import Path
import hashlib
import shutil
import sys

MODULE = 'k56-exam-order.js'
EXPECTED = 'bdd00a6a11bb227869ed4931525fa9075dd18a020999d06fcdbd64da118266a3'
HERE = Path(__file__).resolve().parent


def stage(source):
    def replace(before, after):
        nonlocal source
        before, after = (value.replace('§', chr(96)).replace('¤', '$') for value in (before, after))
        if source.count(before) != 1:
            raise ValueError(f'Unexpected K56 online runtime anchor: {before}')
        source = source.replace(before, after)

    replace("import { queueK56Grades } from './k56-ordered-grade-sync.js';",
            """import { queueK56Grades } from './k56-ordered-grade-sync.js';
import { createTermOnlineRecovery, onlineRecoveryCapability } from './term-online-submission.mjs';""")
    replace("identityConfirmed:z.boolean().optional(), identityOnly:z.boolean().optional()",
            "identityConfirmed:z.boolean().optional(), identityOnly:z.boolean().optional(), submissionRecovery:z.literal(1).optional()")
    replace("  s.attempt_mode AS session_attempt_mode, s.generation AS session_generation,",
            "  s.attempt_mode AS session_attempt_mode, s.generation AS session_generation, s.superseded_at AS session_superseded_at,")
    replace("    policy:{timed:a.attempt_mode!=='answer_sheet',autoSubmit:a.attempt_mode!=='answer_sheet'},",
            """    policy:{timed:a.attempt_mode!=='answer_sheet',autoSubmit:a.attempt_mode!=='answer_sheet'},
    ...onlineRecoveryCapability(a),""")
    replace("res.status(error.status).json({ ok: false, error: error.code, message: error.message });",
            "res.status(error.status).json({ ok: false, error: error.code, message: error.message, ...(error.held ? { held: error.held } : {}) });")
    replace("async function load(client, slug, token, bySession = false, lock = false)",
            "async function load(client, slug, token, bySession = false, lock = false, pinDefinition = true)")
    replace("    return pinK56TermDefinition(client, assets, found.rows[0]);",
            "    return pinDefinition ? pinK56TermDefinition(client, assets, found.rows[0]) : found.rows[0];")
    replace("""  for (const path of ['attempt/prepare', 'session/prepare']) router.post""",
            """  const onlineRecovery = createTermOnlineRecovery({ pool, transaction, load, assertRetainedIdentity,
    assertLegacyWrite, rejectMainSkillIfBound, parseStoredTest, serialize, resultFor, record, failure });
  router.post('/:testSlug/submission-recovery/status', readLimiter || limiter, route(async (req,res) => {
    res.set('Cache-Control', 'no-store, private').json(await onlineRecovery.read(req, req.params.testSlug));
  }));
  for (const path of ['attempt/prepare', 'session/prepare']) router.post""")
    replace("""    const a = await prepare(req.params.testSlug, body);
    const response = { ...await withContent""",
            """    const prepared = await prepare(req.params.testSlug, body);
    const a = path === 'attempt/prepare' ? await onlineRecovery.enroll(prepared, body) : prepared;
    const response = { ...await withContent""")
    replace("""    if(legacy) {
      if(body.attemptMode==='answer_sheet')""",
            """    if(legacy) {
      if(req.body?.recovery !== undefined) throw failure('SUBMISSION_RECOVERY_SCOPE','Cần xác nhận phiên thi trước khi gửi bản chốt.',403);
      if(body.attemptMode==='answer_sheet')""")
    replace("""    const saved = await transaction(async client => {
      let a = await load(client,req.params.testSlug,skill==='listening'""",
            """    const retained = await onlineRecovery.retain(req, req.params.testSlug, skill, body);
    if (retained?.receipt) {
      record('offline_operation_committed',req.params.testSlug,retained.a.attempt_token,{
        ...retained.meta,receiptId:retained.receipt.receiptId,phase:'after_commit',accepted:true,replayed:true
      });
      res.json({ ...serialize(retained.a), next:nextK56Section(retained.a), result:resultFor(retained.a),
        portalSyncStatus:'unknown', resultAvailable:true, receipt:retained.receipt });
      return;
    }
    const saved = await transaction(async client => {
      let a = await load(client,req.params.testSlug,skill==='listening'""")
    replace("""      if (a[§¤{skill}_submitted_at§]) return { a, changed:false };""",
            """      if (a[§¤{skill}_submitted_at§]) return { a, changed:false, ...await onlineRecovery.finish(client,a,retained) };""")
    replace("""      return { a,changed:true };
    });
    record('submission_completed',req.params.testSlug,saved.a.attempt_token,{section:skill,revision:Number(saved.a[skill+'_draft_revision'])||0,
      accepted:saved.changed,completed:Boolean(saved.a.completed_at),keyVersion:saved.a.definition_version},saved.a[skill+'_answers']);""",
            """      return { a,changed:true, ...await onlineRecovery.finish(client,a,retained) };
    }).catch(error => {
      if (!retained) throw error;
      record('offline_request_failed',req.params.testSlug,retained.proof.attemptToken,{
        ...retained.meta, phase:'commit', errorCode:error.status ? error.code : 'OFFLINE_SUBMISSION_UNAVAILABLE'
      });
      if (!error.status) error=failure('OFFLINE_SUBMISSION_UNAVAILABLE','Chưa xác nhận được bài nộp. Hãy giữ bản trên thiết bị.',503);
      if (![401,403,404].includes(error.status)) error.held=retained.held;
      throw error;
    });
    if (saved.receipt) record('offline_operation_committed',req.params.testSlug,saved.a.attempt_token,{
      ...retained.meta,receiptId:saved.receipt.receiptId,phase:'after_commit',accepted:true,replayed:!saved.changed
    });
    if (saved.review) record('offline_request_failed',req.params.testSlug,saved.a.attempt_token,{
      ...retained.meta, phase:'after_commit', errorCode:saved.review
    });
    record('submission_completed',req.params.testSlug,saved.a.attempt_token,{section:skill,revision:Number(saved.a[skill+'_draft_revision'])||0,
      accepted:saved.changed,completed:Boolean(saved.a.completed_at),keyVersion:saved.a.definition_version},retained?undefined:saved.a[skill+'_answers']);""")
    replace("""    res.json({ ...serialize(saved.a), next:nextK56Section(saved.a), result:resultFor(saved.a),portalSyncStatus:status, resultAvailable:true });""",
            """    res.json({ ...serialize(saved.a), next:nextK56Section(saved.a), result:resultFor(saved.a),portalSyncStatus:status, resultAvailable:true,
      ...(saved.receipt?{receipt:saved.receipt}:{}),...(saved.review?{recoveryReview:saved.review,held:saved.held}:{}) });""")
    replace("""    record('score_committed',req.params.testSlug,saved.a.attempt_token,{section:skill,rawScore:Number(saved.a[skill+'_result']?.correct)||0,
      keyVersion:saved.a.definition_version});""",
            """    record('score_committed',req.params.testSlug,saved.a.attempt_token,{section:skill,rawScore:Number(saved.a[skill+'_result']?.correct)||0,
      keyVersion:saved.a.definition_version,...(saved.receipt?{...retained.meta,
        receiptId:saved.receipt.receiptId,phase:'after_commit',replayed:!saved.changed}:{})});""")
    return source


if __name__ == '__main__':
    baseline, candidate = map(lambda arg: Path(arg).resolve(), sys.argv[1:])
    raw = (baseline / 'src' / MODULE).read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED:
        raise ValueError('K56 online baseline differs from VPS1')
    if candidate.exists():
        raise ValueError('Candidate destination already exists')
    patched = stage(raw.decode('utf8'))
    shutil.copytree(baseline / 'src', candidate / 'src')
    for name in ('term1-submission-hold.mjs', 'term-online-submission.mjs'):
        shutil.copy2(HERE / name, candidate / 'src')
    (candidate / 'src' / MODULE).write_text(patched, encoding='utf8', newline='\n')
    print(hashlib.sha256(patched.encode('utf8')).hexdigest())
