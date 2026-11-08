"""Stage the Term 1-only skill admission overlay against a verified source image."""
import argparse
import hashlib
from pathlib import Path
import shutil

CORE_SHA = '9dc5ceef6f06f222326bd22c0b30c17651f135eb9891a388ee747acb497a3006'
R2_CORE_SHA = 'ce8994a9895ab004f873bd64154afe0a15d445079c8b76a7a25d3d8307a98e03'
R2_FILES = {
    'audio-r2.js': '30cd162944d276ccbef8e9b13e0963ebd53f8834a3dea2cb6a63934ecf806902',
    'k56-term-audio-r2.mjs': '2674eb373706393361126efa1179600675eb597847986517062d274d577a6beb',
    'r2-audio-catalog.json': 'bda4fd37608693339ce17c391c1b4b88ee45515b00834a6c225100b44fec48bf',
}
WRAPPER_SHA = 'ea46a95bb4e82a09d13f9bdc62221aae930174059530aad4dfde125e231453bc'
ORDER_SHA = 'b7c2972e110063d342cc52a12819bb7c7c9d78e1d04cfb7e5f5fca796ebb85c6'
APP_SHA = '18fde64f44462d1da1d4ea540ba82465ed8e88aad2ae9241ca5c71dd1b534b90'
LISTENING_RECOVERY_SHA = 'c848bd6a8569a7a7ba5b26d9597ca09a65ef8025bfaec41706b8c80672280e93'
WRITING_GRADING_SHA = 'cbfde2cd4a3c4ba76268552b19a590fad9fc8f096db891c62af01462290036da'


def pinned(path, expected, *, git_text=False):
    raw = path.read_bytes()
    if git_text:
        raw = raw.replace(b'\r\n', b'\n')
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Unverified base source: ' + str(path))
    return raw.decode()


def edit(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Term 1 overlay anchor is not unique: ' + old)
    return source.replace(old, new)


def build(runtime):
    target = runtime.resolve(strict=True) / 'src'
    order = pinned(target / 'k56-exam-order.js', ORDER_SHA)
    app = pinned(target / 'app.js', APP_SHA)
    recovery_path = target / 'k56-listening-audio-recovery.js'
    recovery = pinned(recovery_path, LISTENING_RECOVERY_SHA)
    grading_path = target / 'term-test-writing-grading.js'
    grading = pinned(grading_path, WRITING_GRADING_SHA)
    core_path = target / 'k56-offline-core.mjs'
    r2 = hashlib.sha256(core_path.read_bytes()).hexdigest() == R2_CORE_SHA
    if r2:
        for name, expected in R2_FILES.items():
            pinned(target / name, expected)
        # Start the Term 1 fork from the pinned pre-R2 source. Reapply the exact
        # R2 opt-in at the authorization point of the new Term 1 receiver below.
        core_path = Path(__file__).resolve().parent.parent / 'term1-offline-20261107' / core_path.name
    core = pinned(core_path, CORE_SHA, git_text=r2)
    wrapper = pinned(target / 'term1-offline.mjs', WRAPPER_SHA)
    core = "import {readBoundSkillGrant, rejectMainSkillIfBound, resolveBoundSkillTarget, skillGrantSchema} from './term1-skill-grant.mjs';\n" + core
    core = edit(core, "const schema=tables(", "const schema=skillGrantSchema+tables(")
    core = edit(core, "WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';",
                "WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';\n"
                "ALTER TABLE assessment.term2_offline_run ADD COLUMN IF NOT EXISTS main_owner_pending boolean NOT NULL DEFAULT false;")
    core = edit(core, 'async function admitted(client,body,token){', 'async function admitted(client,body,token,grantToken){')
    core = edit(core, """  const a=await load(client,SLUG,body.attemptToken,false,true);
  const run=(await client.query(tables('SELECT * FROM assessment.term2_offline_run WHERE attempt_id=$1 FOR UPDATE'),[body.attemptToken])).rows[0];""",
                """  if(grantToken!==undefined&&body.attemptToken!==body.examSessionToken)
    throw fail('TERM1_SKILL_GRANT_DENIED','Link dự phòng không khớp lượt thi.',403);
  const target=grantToken===undefined
    ? {attempt_id:body.attemptToken,session_id:body.examSessionToken}
    : await resolveBoundSkillTarget(client,grantToken,body.ownerId,body.attemptToken);
  const a=await load(client,SLUG,target.attempt_id,false,true);
  const run=(await client.query(tables('SELECT * FROM assessment.term2_offline_run WHERE attempt_id=$1 FOR UPDATE'),[target.attempt_id])).rows[0];""")
    core = edit(core, 'run.policy!==POLICY||run.owner_id!==body.ownerId||run.session_id!==body.examSessionToken||',
                'run.policy!==POLICY||run.session_id!==target.session_id||')
    core = edit(core, 'a.exam_session_token!==body.examSessionToken||a.attempt_mode', 'a.exam_session_token!==target.session_id||a.attempt_mode')
    core = edit(core, "||a.attempt_mode!=='cbt'\n    ||!equal(token,permitFor(secret,run)))",
                "||a.attempt_mode!=='cbt')")
    core = edit(core, '  return {a,run};',
                """  const grant=grantToken===undefined ? null
    : await readBoundSkillGrant(client,a,grantToken,body.ownerId,body.section);
  if(!grant&&(run.main_owner_pending||run.owner_id!==body.ownerId||!equal(token,permitFor(secret,run))))
    throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi hoặc quyền đã thay đổi. Giữ bài và liên hệ giảng viên.',403);
  return {a,run,grant};""")
    core = edit(core, """await admitted(client,b,req.get('x-term2-permit'));
   return (await client.query(tables('SELECT receipt FROM assessment.term2_offline_operation WHERE operation_id=$1 AND attempt_id=$2'),[b.operationId,b.attemptToken]))""",
                """const {a,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));
   return (await client.query(tables(`SELECT receipt FROM assessment.term2_offline_operation
     WHERE operation_id=$1 AND attempt_id=$2 AND ($3::text IS NULL OR section=$3)
       AND receipt->>'attemptToken'=$4`),[b.operationId,a.attempt_token,grant?.section??null,b.attemptToken]))""")
    core = edit(core, "let {a,run}=await admitted(client,b,req.get('x-term2-permit'));",
                "let {a,run,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));")
    core = edit(core, "previous.attempt_id!==b.attemptToken||previous.payload_hash!==hash",
                "previous.attempt_id!==a.attempt_token||(grant&&previous.section!==grant.section)||previous.payload_hash!==hash")
    core = edit(core, "   if(index&&(!prior?.sealed||prior.operationId!==b.dependency))",
                """   if(!grant)await rejectMainSkillIfBound(client,a,b.section);
   if(grant&&b.dependency!==null)throw fail('TERM1_SKILL_DEPENDENCY','Link dự phòng không nhận quyền của kỹ năng khác.',403);
   if(!grant&&index&&(!prior?.sealed||prior.operationId!==b.dependency))""")
    core = edit(core, '   if(item.sealed)throw fail(', "   if(item.sealed||a[b.section+'_submitted_at'])throw fail(")
    # Keep public aliases in the signed payload and receipt, native IDs in DB keys.
    core = edit(core, '[b.operationId,b.attemptToken,hash,b.section,b.kind,JSON.stringify(b),JSON.stringify(receipt)]',
                '[b.operationId,a.attempt_token,hash,b.section,b.kind,JSON.stringify(b),JSON.stringify(receipt)]')
    core = edit(core, 'SLUG,b.attemptToken,{section:b.section,operationId:b.operationId,receiptId:',
                'SLUG,out.a.attempt_token,{section:b.section,operationId:b.operationId,receiptId:')
    core = edit(core, '   if(row.owner_id!==body.ownerId)',
                """   if(row.session_id!==body.examSessionToken||Number(row.generation)!==body.generation||row.policy!==POLICY)
    throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi chưa khớp.',403);
   if(row.main_owner_pending) {
    row=(await client.query(tables('UPDATE assessment.term2_offline_run SET owner_id=$2,main_owner_pending=false WHERE attempt_id=$1 RETURNING *'),[a.attempt_token,body.ownerId])).rows[0];
   }
   if(row.owner_id!==body.ownerId)""")
    core = edit(core, '  const run=await transaction(async client=>{', '  const {current,run}=await transaction(async client=>{')
    core = edit(core, '   return row;\n  });\n  const content=a.', '   return {current,run:row};\n  });\n  const content=current.')
    core = edit(core, 'timing=a.mini_definition_snapshot?.timing||assets.getTiming(SLUG);\n  res.json({...serialize(a),content,timing,',
                'timing=current.mini_definition_snapshot?.timing||assets.getTiming(SLUG);\n'
                '  res.json({...serialize(current),content,timing,...mainProgress(current,run),')
    if r2:
        core = "import {issueK56TermAudio} from './k56-term-audio-r2.mjs';\n" + core
        core = edit(core, "mode:z.enum(['lis_first','read_first'])",
                    "mode:z.enum(['lis_first','read_first']),audioTransport:z.literal('r2-direct-v1').optional()")
        core = edit(core, '  const {current,run}=await transaction(async client=>{',
                    '  const {current,run,audioDownload}=await transaction(async client=>{')
        core = edit(core, '   return {current,run:row};',
                    '   return {current,run:row,audioDownload:issueK56TermAudio(current,body.audioTransport)};')
        core = edit(core, '...mainProgress(current,run),offline:',
                    '...mainProgress(current,run),...(audioDownload?{audioDownload}:{}),offline:')
    core = edit(core, " router.post('/:testSlug/offline/status'",
                """ function mainProgress(a,run){
  const completedElsewhere={};
  for(const section of ['listening','reading','writing']){
   const item=run.state?.[section];
   if(item?.fallbackSeal&&item.sealed&&a[section+'_submitted_at']){
    completedElsewhere[section]={operationId:item.operationId,startedAt:item.startedAt,deadlineAt:item.deadlineAt,
     revision:item.revision};
   }
  }
  return {completedElsewhere};
 }
 router.post('/:testSlug/offline/resume',onlyThis,readLimiter,route(async(req,res)=>{
  const b=parse(scope.strict(),req.body);
  const progress=await transaction(async client=>{
   const {a,run}=await admitted(client,b,req.get('x-term2-permit'));
   return mainProgress(a,run);
  });
  res.json({ok:true,...progress});
 }));
 router.post('/:testSlug/offline/status'""")
    core = edit(core, "operationId:b.kind==='seal'?b.operationId:null};",
                "operationId:b.kind==='seal'?b.operationId:null,...(grant&&b.kind==='seal'?{fallbackSeal:true}:{})};")
    core = edit(core, '   const review=validateTimeline(b,run,a,timing);',
                """   const review=validateTimeline(b,run,a,timing) || (
    grant&&b.section==='listening'&&b.kind==='seal'&&p.reason!=='manual'
      &&(!Number.isFinite(p.heardSeconds)||Date.parse(b.occurredAt)-Date.parse(p.startedAt)
        <(timing.listeningDurationSeconds+timing.listeningReviewSeconds-2)*1000)
    ? 'AUDIO_NOT_FINISHED' : null);
""".rstrip())
    order = "import {registerTerm1SkillRoutes} from './term1-skill-routes.mjs';\n" + order
    order = "import {rejectMainSkillIfBound} from './term1-skill-grant.mjs';\n" + order
    order = edit(order, 'import {registerTerm1Offline}', 'import {registerTerm1Offline,POLICY as TERM1_OFFLINE_POLICY}')
    order = edit(order, '  onJournalEvent, secret, onWriting, readLimiter, draftLimiter,',
                 '  onJournalEvent, secret, onWriting, readLimiter, draftLimiter, authenticate, readTeacherSkillScope, readSkillWriting,')
    order = edit(order, 'async function prepare(slug, body, create = true)', 'async function prepare(slug, body, create = true, existingClient = null)')
    order = edit(order, '    return transaction(async client => {\n      const student =',
                 '    const run = existingClient ? work => work(existingClient) : transaction;\n    return run(async client => {\n      const student =')
    marker = '  registerTerm1Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});'
    if r2:
        order = "import {issueTerm1SkillAudio} from './term1-skill-audio-r2.mjs';\n" + order
    order = edit(order, marker, marker + """
  if(authenticate&&readTeacherSkillScope)registerTerm1SkillRoutes(router,{
    authenticate,readTeacherScope:readTeacherSkillScope,transaction,prepare,load,assets,policy:TERM1_OFFLINE_POLICY,limiter,readLimiter,record,readWriting:readSkillWriting,"""
    + ("\n    issueAudio:issueTerm1SkillAudio," if r2 else "") + """
    findStudent:async(client,input)=>{
      const rows=(await client.query(findStudentForTermTestSql,[input.classCode,'term-test-1-k56',input.studentRef])).rows;
      return rows.length===1?rows[0]:null;
    }
  });""")
    order = edit(order, '    // Bộ nạp cũ hiểu attemptToken là Listening đã nộp.',
                 """    if(a.test_slug==='term-test-1-k56'&&response.nextSection==='listening'&&a.reading_submitted_at){
      const {rows:[run]}=await pool.query(`SELECT state->'reading'->>'fallbackSeal'='true' AS done
        FROM assessment.term1_offline_run WHERE attempt_id=$1 AND generation=$2`,[a.attempt_token,a.generation]);
      if(run?.done)response.resumeTerm1Offline=true;
    }
    // Bộ nạp cũ hiểu attemptToken là Listening đã nộp.""")
    order = edit(order, "      if (row.reading_submitted_at) throw failure('READING_LOCKED'",
                 "      if(row.test_slug==='term-test-1-k56')await rejectMainSkillIfBound(client,row,'reading');\n"
                 "      if (row.reading_submitted_at) throw failure('READING_LOCKED'")
    order = edit(order, "      const accepted = body.revision>Number(a.reading_draft_revision||0);",
                 "      if(a.test_slug==='term-test-1-k56')await rejectMainSkillIfBound(client,a,'reading');\n"
                 "      const accepted = body.revision>Number(a.reading_draft_revision||0);")
    order = edit(order, "      if (a[`${skill}_submitted_at`]) return { a, changed:false };",
                 "      if (a[`${skill}_submitted_at`]) return { a, changed:false };\n"
                 "      if(a.test_slug==='term-test-1-k56')await rejectMainSkillIfBound(client,a,skill);")
    recovery = "import {rejectListeningSessionIfBound} from './term1-skill-grant.mjs';\n" + recovery
    recovery = edit(recovery, '    const row = found.rows[0];',
                    "    const row = found.rows[0];\n    if(slug==='term-test-1-k56')await rejectListeningSessionIfBound(client,token);")
    app = "import {withMainListeningSession,withMainWritingAttempt} from './term1-skill-grant.mjs';\n" + app
    app = edit(app, "    const saved = await pool.query(saveTermTestListeningDraftSql, [\n      parsed.data.examSessionToken,\n      slug.data,\n      JSON.stringify(parsed.data.answers),\n      parsed.data.revision ?? null\n    ]);",
               """    const saved = await withMainListeningSession(pool, slug.data, parsed.data.examSessionToken, client =>
      client.query(saveTermTestListeningDraftSql, [parsed.data.examSessionToken, slug.data,
        JSON.stringify(parsed.data.answers), parsed.data.revision ?? null]));""")
    app = edit(app, "x-exam-journal-request-id, x-term2-permit');",
               "x-exam-journal-request-id, x-term2-permit, x-term1-skill-grant');")
    auth = '  const auth = createAuthService({ config, pool, verifyGoogleToken });\n  const authenticate = auth.authenticate;\n'
    app = edit(app, auth, '')
    app = edit(app, '  const app = express();\n', '  const app = express();\n' + auth)
    app = edit(app, '    limiter: testWriteLimiter, readLimiter: testReadLimiter, draftLimiter: testDraftLimiter, secret: config.termTestSessionSecret,',
               '    authenticate, readTeacherSkillScope: readTeacherSavedProgress,\n'
               '    readSkillWriting: async (client,row) => studentWritingGrading(row.test_slug,await termTestWritingGradingService?.getStatus(row.attempt_token,client)),\n'
               '    limiter: testWriteLimiter, readLimiter: testReadLimiter, draftLimiter: testDraftLimiter, secret: config.termTestSessionSecret,')
    app = edit(app, '    const saved = await pool.query(miniWriting ? saveMiniTestWritingSql : k56TermWriting ? saveK56TermWritingSql : saveTermTestWritingSql, [',
               '    const saved = await withMainWritingAttempt(pool,attemptSlug,parsed.data.attemptToken, client =>\n'
               '      client.query(miniWriting ? saveMiniTestWritingSql : k56TermWriting ? saveK56TermWritingSql : saveTermTestWritingSql, [')
    app = edit(app, '      ...(miniWriting || k56TermWriting ? [parsed.data.outline ?? null] : [])\n    ]);',
               '      ...(miniWriting || k56TermWriting ? [parsed.data.outline ?? null] : [])\n    ]));')
    grading = edit(grading, 'const GRADING_VERSION = 1;', """const GRADING_VERSION = 1;
const TERM1_SKILL_WRITING_SEALED = `(test_slug='term-test-1-k56' AND superseded_at IS NULL AND EXISTS (
  SELECT 1 FROM assessment.term1_offline_run run JOIN assessment.term1_offline_operation operation ON operation.attempt_id=run.attempt_id
  WHERE run.attempt_id=term_test_attempt.id AND run.session_id=term_test_attempt.exam_session_id
    AND run.generation=term_test_attempt.generation AND run.policy='term1-offline-v1'
    AND run.state->'writing'->>'fallbackSeal'='true'
    AND operation.operation_id::text=run.state->'writing'->>'operationId'
    AND operation.section='writing' AND operation.kind='seal' AND operation.receipt->>'status'='accepted'
))`;""")
    grading = edit(grading, '        AND completed_at IS NOT NULL\n        AND writing_submitted_at IS NOT NULL',
                   "        AND (completed_at IS NOT NULL OR ${testSlug==='term-test-1-k56'?TERM1_SKILL_WRITING_SEALED:'false'})\n        AND writing_submitted_at IS NOT NULL")
    grading = edit(grading, '        portalSyncRequired,\n        attemptId: job.attempt_id',
                   '        portalSyncRequired,\n        testSlug: job.test_slug,\n        attemptId: job.attempt_id')
    grading = edit(grading, '    const attemptResult = await pool.query(`SELECT\n      id::text AS attempt_token,',
                   "    const writingFallback = stored.testSlug==='term-test-1-k56'?TERM1_SKILL_WRITING_SEALED:'false';\n"
                   '    const attemptResult = await pool.query(`SELECT\n      id::text AS attempt_token,')
    grading = edit(grading, '      combined_result\n    FROM assessment.term_test_attempt\n    WHERE id = $1::uuid\n      AND completed_at IS NOT NULL',
                   '      combined_result, ${writingFallback} AS writing_fallback\n    FROM assessment.term_test_attempt\n    WHERE id = $1::uuid\n'
                   '      AND (completed_at IS NOT NULL OR ${writingFallback})')
    grading = edit(grading, '          attempt.combined_result,', '          attempt.writing_fallback ? null : attempt.combined_result,')
    grading = edit(grading, '  async function getStatus(attemptToken) {\n    return readStatus(pool, attemptToken);',
                   '  async function getStatus(attemptToken, executor = pool) {\n    return readStatus(executor, attemptToken);')
    wrapper = edit(wrapper, "'./k56-offline-core.mjs'", "'./term1-skill-offline-core.mjs'")
    modules = ('term1-skill-grant.mjs', 'term1-skill-routes.mjs') + (('term1-skill-audio-r2.mjs',) if r2 else ())
    for name in (*modules, 'term1-skill-offline-core.mjs'):
        if (target / name).exists():
            raise ValueError('Overlay target already exists: ' + name)
    for name in modules:
        shutil.copyfile(Path(__file__).with_name(name), target / name)
    (target / 'app.js').write_text(app, encoding='utf-8', newline='\n')
    recovery_path.write_text(recovery, encoding='utf-8', newline='\n')
    grading_path.write_text(grading, encoding='utf-8', newline='\n')
    (target / 'k56-exam-order.js').write_text(order, encoding='utf-8', newline='\n')
    (target / 'term1-skill-offline-core.mjs').write_text(core, encoding='utf-8', newline='\n')
    (target / 'term1-offline.mjs').write_text(wrapper, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('candidate', type=Path, help='Dedicated copy of the verified K56 source')
    build(parser.parse_args().candidate)
