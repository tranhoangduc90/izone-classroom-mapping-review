import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleWriting, servingWritingSha, writingFile } from './assemble-writing.mjs';

const entryFile = 'k56-exam-order.js';
const servingEntrySha = 'edb33ece4327892e6c9ecaa7f86b2f3b1a7036261ea623eb5dbe38886c70be33';
const recoveryFile = 'term-online-submission.mjs';
const servingRecoverySha = '0b161966ba67c1335bd71d02af850f80424210943ce52b55bb951190158385cf';
const digest = content => createHash('sha256').update(content).digest('hex');

function replaceUnique(source, before, after) {
  assert.equal(source.split(before).length, 2, before);
  return source.replace(before, () => after);
}

export function assembleRecovery(bytes) {
  assert.equal(digest(bytes), servingRecoverySha, 'Unexpected serving source of ' + recoveryFile);
  let source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  function replaceOnce(before, after) {
    source = replaceUnique(source, before, after);
  }
  replaceOnce('failure, readWritingResponse })',
    'failure, readWritingResponse, viewStoredSubmission = (_client, scope) => scope })');
  replaceOnce('      if (receipt) return { receipt, a };',
    '      if (receipt) return { receipt, a: await viewStoredSubmission(client, a, receipt) };');
  replaceOnce(`      if (receipt) return { a, receipt, response: input.section === 'writing'
        ? await readWritingResponse(client, a)
        : { ...serialize(a), result: resultFor(a), portalSyncStatus: 'unknown', resultAvailable: true } };`,
    `      if (receipt) {
        const view = await viewStoredSubmission(client, a, receipt);
        return { a, receipt, response: input.section === 'writing'
          ? await readWritingResponse(client, view.paperOfficial ?? view)
          : { ...serialize(view), result: resultFor(view), portalSyncStatus: 'unknown', resultAvailable: true } };
      }`);
  replaceOnce(`  async function finish(client, a, retained) {
    if (!retained) return {};
    const { operation, hash, proof } = retained;
    if (a.exam_session_token !== proof.examSessionToken || Number(a.generation) !== proof.generation)
      throw failure('SUBMISSION_RECOVERY_SCOPE', 'Lượt thi đã thay đổi. Hãy giữ bản trên thiết bị.', 403);
    const receipt = await stored(client, a, operation);`,
    `  async function finish(client, a, retained, scope = a) {
    if (!retained) return {};
    const { operation, hash, proof } = retained;
    const linked = a.attempt_token !== scope.attempt_token;
    if (scope.attempt_token !== proof.attemptToken || scope.exam_session_token !== proof.examSessionToken
        || Number(scope.generation) !== proof.generation || Number(a.generation) !== proof.generation
        || (linked && (!scope.term2_paper_profile_id || a.test_slug !== scope.test_slug
          || a.attempt_mode !== scope.attempt_mode || a.class_id !== scope.class_id || a.student_id !== scope.student_id
          || a.definition_version !== scope.definition_version || !a.term2_official_submission)))
      throw failure('SUBMISSION_RECOVERY_SCOPE', 'Lượt thi đã thay đổi. Hãy giữ bản trên thiết bị.', 403);
    const receipt = await stored(client, scope, operation);`);
  replaceOnce('    if (await hasOtherWritingReceipt(client, a, operation)) {',
    '    if (await hasOtherWritingReceipt(client, scope, operation)) {');
  replaceOnce('      attemptToken: a.attempt_token, examSessionToken: a.exam_session_token, generation: proof.generation, section,',
    '      attemptToken: scope.attempt_token, examSessionToken: scope.exam_session_token, generation: proof.generation, section,\n      ...(linked ? {officialAttemptToken:a.attempt_token} : {}),');
  replaceOnce(`    [a.attempt_token, proof.generation, operation.operationId, section, hash, JSON.stringify(result),
      Number(a.submission_hold_hours)]);`,
    `    [scope.attempt_token, proof.generation, operation.operationId, section, hash, JSON.stringify(result),
      Number(scope.submission_hold_hours)]);`);
  return source;
}

export function assembleEntry(bytes) {
  assert.equal(digest(bytes), servingEntrySha, 'Unexpected serving source of ' + entryFile);
  let source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  function replaceOnce(before, after) {
    source = replaceUnique(source, before, after);
  }

  replaceOnce('import {findTerm2Official, officialProgress, term2ParallelMode}',
    'import {findTerm2Official, lockTerm2Candidate, officialProgress, term2ParallelMode, writeTerm2OfficialDraft}');
  replaceOnce("const modeSchema =", "const term2PaperSlug = 'term-test-2-k56';\nconst modeSchema =");
  replaceOnce('function failure(code, message, status = 409)', `function paperScope(a) {
  return {attemptToken:a.attempt_token, examSessionToken:a.exam_session_token, generation:Number(a.generation)};
}
function paperLegacySnapshot(a) {
  return {...paperScope(a), examMode:a.exam_mode,
    listeningStartedAt:a.listening_started_at, listeningDeadlineAt:a.listening_deadline_at,
    listeningCheckpoint:Number(a.listening_audio_checkpoint_seconds) || 0,
    readingStartedAt:a.reading_started_at, readingDeadlineAt:a.reading_deadline_at,
    writingStartedAt:a.writing_started_at, writingDeadlineAt:a.writing_deadline_at,
    writingUpdatedAt:a.writing_updated_at};
}
function matchesPaperLegacy(a, original) {
  const bridge = a.term2_paper_legacy_bridge;
  return bridge?.attemptToken === original.attemptToken && bridge.examSessionToken === original.examSessionToken
    && bridge.generation === original.generation;
}
function failure(code, message, status = 409)`);
  replaceOnce('  term2ContinuationVersion: z.literal(1).optional(),',
    '  term2ContinuationVersion: z.literal(1).optional(),\n  term2PaperProfileId: z.string().uuid().optional(),');
  replaceOnce('  s.listening_draft, s.listening_draft_revision, s.listening_audio_checkpoint_seconds,',
    '  s.listening_draft, s.listening_draft_revision, s.listening_audio_checkpoint_seconds,\n  s.term2_paper_profile_id, s.term2_paper_legacy_bridge,');
  replaceOnce('    ...onlineRecoveryCapability(a),',
    '    ...onlineRecoveryCapability(a),\n    ...(a.term2_paper_profile_id ? {term2PaperParallelEntry:true} : {}),\n    ...(a.paperResumedFrom ? {paperResumedFrom:a.paperResumedFrom} : {}),');
  replaceOnce(`  return order.find(skill => !a[\`\${skill}_submitted_at\`] && !(skill === 'listening' && a.listening_interrupted_at)) || (a.writing_submitted_at ? 'result' : 'writing');`,
    `  const progress = a.paperOfficial ?? a;
  return order.find(skill => !progress[\`\${skill}_submitted_at\`] && !(skill === 'listening' && progress.listening_interrupted_at))
    || (progress.writing_submitted_at ? 'result' : 'writing');`);
  replaceOnce('function serialize(a) {\n  return {',
    'function serialize(a) {\n  const progress = a.paperOfficial ?? a;\n  return {');
  replaceOnce(`    studentName: a.student_name, completed: Boolean(a.completed_at), serverNow: a.server_now,
    listeningInterrupted: Boolean(a.listening_interrupted_at),
    listeningSubmitted: Boolean(a.listening_submitted_at), readingSubmitted: Boolean(a.reading_submitted_at),`,
    `    studentName: a.student_name, completed: Boolean(progress.completed_at), serverNow: a.server_now,
    listeningInterrupted: Boolean(progress.listening_interrupted_at),
    listeningSubmitted: Boolean(progress.listening_submitted_at), readingSubmitted: Boolean(progress.reading_submitted_at),`);
  replaceOnce('    writingSubmittedAt: a.writing_submitted_at',
    '    writingSubmittedAt: progress.writing_submitted_at');
  replaceOnce('function resultFor(a) {\n  const definition',
    'function resultFor(a) {\n  a = a.paperOfficial ?? a;\n  const definition');
  replaceOnce('  const term2Mode = term2ParallelMode();',
    "  const term2Mode = term2ParallelMode();\n  const term2PaperMode = term2ParallelMode(process.env.K56_TERM2_PAPER_PARALLEL_ENTRY_MODE || 'off');");
  replaceOnce('  const withOfficialProgress = async (client, a) => a.mini_cbt_parallel_entry',
    `  async function paperTarget(client, scope, lock = false) {
    if (!scope.term2_paper_profile_id) return scope;
    const chosen = await findTerm2Official(client, scope);
    if (!chosen || chosen.attempt_token === scope.attempt_token) return scope;
    const official = await load(client, scope.test_slug, chosen.attempt_token, false, lock, false);
    if (!official.term2_official_submission || official.definition_version !== scope.definition_version)
      throw failure('DEFINITION_CHANGED', 'Bài chính thức dùng định nghĩa khác. Hãy giữ nguyên nháp.');
    return official;
  }
  function paperView(scope, official) {
    return scope.term2_paper_profile_id ? {...scope,
      paperOfficial:official, term2_official_progress:officialProgress(official)} : scope;
  }
  async function viewStoredSubmission(client, scope, receipt) {
    if (!scope.term2_paper_profile_id) return scope;
    const official = await paperTarget(client, scope);
    if (receipt.officialAttemptToken && official.attempt_token !== receipt.officialAttemptToken)
      throw failure('SUBMISSION_RECOVERY_SCOPE', 'Không tìm thấy bài chính thức của biên nhận này.', 409);
    return paperView(scope, official);
  }
  async function assertOpenSection(client, scope, skill) {
    const official = await paperTarget(client, scope);
    if (scope.term2_paper_profile_id && official[\`\${skill}_submitted_at\`])
      throw failure('EXAM_FIRST_SUBMISSION_ACCEPTED', 'Kỹ năng này đã được ghi nhận.');
    assertSection(paperView(scope, official), skill);
  }
  const withOfficialProgress = async (client, a) => a.term2_paper_profile_id
    ? paperView(a, await paperTarget(client, a)) : a.mini_cbt_parallel_entry`);
  replaceOnce('      response.content = a.completed_at || a.listening_submitted_at ? content : {',
    '      const progress = a.paperOfficial ?? a;\n      response.content = progress.completed_at || progress.listening_submitted_at ? content : {');
  replaceOnce('    assertLegacyWrite, rejectMainSkillIfBound, parseStoredTest, serialize, resultFor, record, failure, readWritingResponse: readOnlineWriting });',
    '    assertLegacyWrite, rejectMainSkillIfBound, parseStoredTest, serialize, resultFor, record, failure, readWritingResponse: readOnlineWriting, viewStoredSubmission });');
  replaceOnce('    onWriting, readWritingResponse: readOnlineWriting, serializeWriting: serializeOnlineWriting, notifyWriting: notifyOnlineWriting',
    `    onWriting, readWritingResponse: readOnlineWriting, serializeWriting: serializeOnlineWriting, notifyWriting: notifyOnlineWriting,
    paperTarget,
    async lockPaperWriting(client, slug, token) {
      if (slug === term2PaperSlug && term2PaperMode !== 'off') await lockTerm2Candidate(client,token);
    },
    async loadPaperWriting(client, slug, token, generation) {
      const scope = await load(client,slug,token,false,true);
      assertDelivery(scope,{generation,attemptMode:'cbt'},slug);
      if (!scope.term2_paper_profile_id || scope.session_superseded_at || Number(scope.session_generation) !== generation)
        throw failure('SUBMISSION_RECOVERY_SCOPE', 'Lượt Writing không còn khớp hồ sơ phiếu.', 403);
      return scope;
    }`);
  replaceOnce("    assertSection(a,'listening');\n    if(['mini-test-k56'",
    "    await assertOpenSection(pool,a,'listening');\n    if(['mini-test-k56'");
  replaceOnce("    assertSection(a,'listening'); next();",
    "    assertSection(paperView(a,await paperTarget(pool,a)),'listening'); next();");
  replaceOnce("assertDelivery(row,body,req.params.testSlug);assertSection(row,'reading');",
    "assertDelivery(row,body,req.params.testSlug);await assertOpenSection(client,row,'reading');");
  replaceOnce("      return load(client,req.params.testSlug,token);\n    });\n    res.json(await withContent(a));",
    "      return withOfficialProgress(client,await load(client,req.params.testSlug,token));\n    });\n    res.json(await withContent(a));");
  replaceOnce("body.attemptToken,false,true); assertSection(a,'reading');",
    "body.attemptToken,false,true); await assertOpenSection(client,a,'reading');");
  replaceOnce("    if(current.attempt_mode!=='answer_sheet') return next();",
    "    if (current.term2_paper_profile_id) await assertOpenSection(pool,current,'listening');\n    if(current.attempt_mode!=='answer_sheet') return next();");

  replaceOnce("    const observeIdentity = slug === 'term-test-1-k56' && !existingClient;", `    const observeIdentity = slug === 'term-test-1-k56' && !existingClient;
    const wantsTerm2Paper = Boolean(body.term2PaperProfileId);
    if (wantsTerm2Paper && (slug !== term2PaperSlug || body.attemptMode !== 'cbt' || body.term2ContinuationVersion))
      throw failure('MODE_CONFLICT', 'Hãy mở đúng trang nhập phiếu Term Test 2 K56.', 400);
    if (wantsTerm2Paper && body.identityConfirmed !== true)
      throw failure('IDENTITY_REQUIRED', 'Hãy xác nhận lớp và họ tên trước khi mở phiếu.', 400);
    if (wantsTerm2Paper && term2PaperMode === 'off')
      throw failure('TERM2_PAPER_ADMISSION_DISABLED', 'Chưa mở được lượt phiếu này.', 503);`);
  replaceOnce('        await assertRetainedIdentity(client,a,body);\n        assertDelivery', `        await assertRetainedIdentity(client,a,body);
        if (wantsTerm2Paper && a.term2_paper_profile_id !== body.term2PaperProfileId)
          throw failure('STUDENT_MISMATCH', 'Hồ sơ phiếu không khớp lượt đã lưu.',403);
        assertDelivery`);
  replaceOnce('      const parallelMode = miniCbt ? miniCbtMode : term1Cbt ? term1Mode : term2Mode;',
    '      const parallelMode = wantsTerm2Paper ? term2PaperMode : miniCbt ? miniCbtMode : term1Cbt ? term1Mode : term2Mode;');
  replaceOnce('      const wantsParallel = parallelCbt && (',
    '      const wantsParallel = wantsTerm2Paper || parallelCbt && (');
  replaceOnce('      if (parallelCbt && (body.attemptToken || body.examSessionToken)) {', `      let paperLegacySource = null;
      let paperResumedFrom = null;
      if (wantsTerm2Paper) {
        const found = (await client.query(\`
          SELECT a.id FROM assessment.term_test_attempt a
          JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id AND s.generation=a.generation
          WHERE a.test_slug=$1 AND s.term2_paper_profile_id=$2 AND a.erp_course_class_id=$3
            AND a.erp_student_contact_id=$4 AND a.superseded_at IS NULL AND s.superseded_at IS NULL
          LIMIT 1\`, [slug, body.term2PaperProfileId, student.class_id, student.student_id])).rows[0];
        let exact = found ? await load(client,slug,found.id,false,true) : null;
        if (body.attemptToken || body.examSessionToken) {
          if (!body.attemptToken || !body.examSessionToken || body.generation === undefined)
            throw failure('INVALID_K56_REQUEST', 'Thiếu thông tin của lượt phiếu đã mở.',400);
          const retained = exact?.attempt_token === body.attemptToken ? exact
            : await load(client,slug,body.attemptToken,false,true);
          if (retained.attempt_token !== body.attemptToken || retained.exam_session_token !== body.examSessionToken
              || String(retained.class_id) !== String(student.class_id) || String(retained.student_id) !== String(student.student_id)
              || Number(retained.generation) !== body.generation || Number(retained.session_generation) !== body.generation
              || retained.session_superseded_at)
            throw failure('STUDENT_MISMATCH', 'Hồ sơ phiếu không khớp lượt đã lưu.',403);
          assertDelivery(retained,body,slug);
          if (!retained.term2_paper_profile_id) {
            if (!create || exact || retained.term2_parallel_entry)
              throw failure('MODE_CONFLICT', 'Lượt này không thuộc hồ sơ phiếu đã xác nhận.');
            const offline = await client.query('SELECT 1 FROM assessment.term2_offline_run WHERE attempt_id=$1 AND generation=$2',
              [retained.attempt_token,retained.generation]);
            if (offline.rows.length)
              throw failure('OFFLINE_ALREADY_PREPARED', 'Hãy tiếp tục trên thiết bị đã mở bài offline.');
            await client.query(\`UPDATE assessment.term_test_exam_session SET term2_parallel_entry=true,
              term2_paper_profile_id=$2,term2_paper_legacy_bridge=$3::jsonb WHERE id=$1\`,
              [retained.exam_session_token,body.term2PaperProfileId,JSON.stringify(paperLegacySnapshot(retained))]);
            await client.query('UPDATE assessment.term_test_attempt SET term2_parallel_entry=true WHERE id=$1',
              [retained.attempt_token]);
            exact = await load(client,slug,retained.attempt_token);
          } else if (retained.term2_paper_profile_id === body.term2PaperProfileId) {
            exact = retained;
          } else {
            const original = paperScope(retained);
            if (!create || !matchesPaperLegacy(retained,original)
                || (exact && (!matchesPaperLegacy(exact,original)
                  || Number(exact.generation) !== original.generation
                  || exact.definition_version !== retained.definition_version)))
              throw failure('STUDENT_MISMATCH', 'Hồ sơ phiếu không khớp lượt đã lưu.',403);
            paperResumedFrom = original;
            paperLegacySource = retained;
          }
        }
        latest = {rows:exact ? [exact] : []};
      } else if (parallelCbt && (body.attemptToken || body.examSessionToken)) {`);
  replaceOnce('        latest = {rows:[exact]};', `        if (term2Cbt && body.term2ContinuationVersion && exact.term2_paper_profile_id)
          throw failure('MODE_CONFLICT', 'Lượt này đang dùng trang nhập phiếu.');
        latest = {rows:[exact]};`);
  replaceOnce('        if (body.attemptToken && a.attempt_token !== body.attemptToken)',
    '        if (body.attemptToken && !paperResumedFrom && a.attempt_token !== body.attemptToken)');
  replaceOnce('        return withOfficialProgress(client,a);', `        const view = await withOfficialProgress(client,a);
        return paperResumedFrom ? {...view,paperResumedFrom} : view;`);
  replaceOnce("      if (body.attemptToken) throw failure('ATTEMPT_NOT_FOUND', 'Lượt làm trước đã được reset.",
    "      if (body.attemptToken && !paperLegacySource) throw failure('ATTEMPT_NOT_FOUND', 'Lượt làm trước đã được reset.");
  replaceOnce("      if (body.mode === 'read_first' && !allowNewReadFirst)",
    "      if (!paperLegacySource && body.mode === 'read_first' && !allowNewReadFirst)");
  replaceOnce("      const mode = s?.listening_started_at ? 'lis_first' : body.mode;",
    "      const legacyClock = paperLegacySource?.term2_paper_legacy_bridge;\n      const mode = legacyClock?.examMode ?? (s?.listening_started_at ? 'lis_first' : body.mode);");
  replaceOnce('      const definitionVersion = pinnedOfficial?.definition_version ?? student.definition_version;',
    '      const definitionVersion = paperLegacySource?.definition_version ?? pinnedOfficial?.definition_version ?? student.definition_version;');
  replaceOnce('      if (!s) s = (await client.query(', `      if (paperLegacySource && (candidateGeneration !== Number(paperLegacySource.generation)
          || (pinnedOfficial && pinnedOfficial.definition_version !== definitionVersion)))
        throw failure('STALE_GENERATION', 'Lượt thi đã thay đổi. Hãy giữ nháp trên thiết bị.');
      if (!s) s = (await client.query(`);
  replaceOnce("         student_name_snapshot,attempt_mode,generation${wantsParallel?','+parallelFlag:''})",
    "         student_name_snapshot,attempt_mode,generation${wantsParallel?','+parallelFlag:''}${wantsTerm2Paper?',term2_paper_profile_id':''})");
  replaceOnce("        VALUES($1,$2,$3,$4,$5,$6,$7,$8${wantsParallel?',true':''}) RETURNING *`,",
    "        VALUES($1,$2,$3,$4,$5,$6,$7,$8${wantsParallel?',true':''}${wantsTerm2Paper?',$9':''}) RETURNING *`,");
  replaceOnce('          student.student_name,body.attemptMode,candidateGeneration])).rows[0];',
    '          student.student_name,body.attemptMode,candidateGeneration,...(wantsTerm2Paper?[body.term2PaperProfileId]:[])])).rows[0];');
  replaceOnce("      return withOfficialProgress(client,await load(client, slug, inserted.rows[0].id));", `      if (legacyClock) {
        await client.query(\`UPDATE assessment.term_test_exam_session SET
          term2_paper_legacy_bridge=$2::jsonb, listening_started_at=$3, listening_deadline_at=$4,
          listening_audio_checkpoint_seconds=$5 WHERE id=$1\`,
          [s.id,JSON.stringify(legacyClock),legacyClock.listeningStartedAt,legacyClock.listeningDeadlineAt,legacyClock.listeningCheckpoint]);
        await client.query(\`UPDATE assessment.term_test_attempt SET term2_parallel_entry=true,
          reading_started_at=$2, reading_deadline_at=$3, writing_started_at=$4,
          writing_deadline_at=$5, writing_updated_at=$6, term2_paper_private_writing=($4::timestamptz IS NOT NULL)
          WHERE id=$1\`, [inserted.rows[0].id,legacyClock.readingStartedAt,legacyClock.readingDeadlineAt,
          legacyClock.writingStartedAt,legacyClock.writingDeadlineAt,legacyClock.writingUpdatedAt ?? legacyClock.writingStartedAt]);
      }
      const view = await withOfficialProgress(client,await load(client,slug,inserted.rows[0].id));
      return paperResumedFrom ? {...view,paperResumedFrom,paperLegacyCreated:true} : view;`);
  replaceOnce("    if (observeIdentity) record('term1_identity_decision',slug,prepared?.attempt_token,", `    if (prepared?.paperLegacyCreated) record('term2_paper_legacy_resumed',slug,prepared.attempt_token,{
      generation:Number(prepared.generation), legacyAttemptToken:prepared.paperResumedFrom.attemptToken
    });
    if (observeIdentity) record('term1_identity_decision',slug,prepared?.attempt_token,`);

  replaceOnce(`    const saved = await transaction(async client => {
      let a = await load(client,req.params.testSlug,skill==='listening'?body.examSessionToken:body.attemptToken,skill==='listening',true);`,
    `    const saved = await transaction(async client => {
      const sourceToken = skill==='listening'?body.examSessionToken:body.attemptToken;
      if (term2PaperMode !== 'off' && req.params.testSlug === term2PaperSlug) {
        const source = await load(client,term2PaperSlug,sourceToken,skill==='listening',false,false);
        await lockTerm2Candidate(client,source.attempt_token);
      }
      let a = await load(client,req.params.testSlug,sourceToken,skill==='listening',true);`);
  replaceOnce("      if (a[`${skill}_submitted_at`]) return { a, changed:false, ...await onlineRecovery.finish(client,a,retained) };",
    `      const scope = a;
      const official = await paperTarget(client, scope, true);
      const linked = official.attempt_token !== scope.attempt_token;
      if (official[\`\${skill}_submitted_at\`]) {
        if (linked) throw failure('EXAM_FIRST_SUBMISSION_ACCEPTED', 'Kỹ năng này đã được ghi nhận từ lượt khác.');
        return { a, official:a, changed:false, ...await onlineRecovery.finish(client,a,retained) };
      }`);
  replaceOnce("      assertSection(a,skill);\n      if(legacy",
    "      assertSection(paperView(a,official),skill);\n      if(legacy");
  replaceOnce("      const answers = submittedAnswers(a,skill,body);\n      const definition = parseStoredTest(a);",
    `      const answers = submittedAnswers(a,skill,body);
      if (linked) {
        await writeTerm2OfficialDraft(client, scope, official, skill, {
          answers, startedAt:a[skill+'_started_at'], deadlineAt:a[skill+'_deadline_at']
        }, Number(a[skill+'_draft_revision']) || 0);
        a = official;
      }
      const definition = parseStoredTest(a);`);
  replaceOnce('      return { a,changed:true, ...await onlineRecovery.finish(client,a,retained) };',
    '      return { a:paperView(linked ? scope : a,a),official:a,changed:true, ...await onlineRecovery.finish(client,a,retained,linked ? scope : a) };');
  replaceOnce("      if (!retained) throw error;\n      record('offline_request_failed'", `      if (error.code === 'P5651' || (error.code === '23505' && error.constraint === 'uq_term2_k56_official_submission'))
        error = failure('EXAM_FIRST_SUBMISSION_ACCEPTED', 'Bài đã được ghi nhận từ lượt khác.');
      if (!retained) throw error;
      record('offline_request_failed'`);
  replaceOnce(`    record('submission_completed',req.params.testSlug,saved.a.attempt_token,{section:skill,revision:Number(saved.a[skill+'_draft_revision'])||0,
      accepted:saved.changed,completed:Boolean(saved.a.completed_at),keyVersion:saved.a.definition_version},retained?undefined:saved.a[skill+'_answers']);
    record('score_committed',req.params.testSlug,saved.a.attempt_token,{section:skill,rawScore:Number(saved.a[skill+'_result']?.correct)||0,
      keyVersion:saved.a.definition_version,...(saved.receipt?{...retained.meta,`,
    `    const accepted = saved.official;
    const officialLink = accepted.attempt_token !== saved.a.attempt_token ? {officialAttemptToken:accepted.attempt_token} : {};
    record('submission_completed',req.params.testSlug,saved.a.attempt_token,{section:skill,revision:Number(accepted[skill+'_draft_revision'])||0,
      accepted:saved.changed,completed:Boolean(accepted.completed_at),keyVersion:accepted.definition_version,...officialLink},retained?undefined:accepted[skill+'_answers']);
    record('score_committed',req.params.testSlug,saved.a.attempt_token,{section:skill,rawScore:Number(accepted[skill+'_result']?.correct)||0,
      keyVersion:accepted.definition_version,...officialLink,...(saved.receipt?{...retained.meta,`);
  replaceOnce("try {status=await requestPortalSync(saved.a,{listening:skill==='listening'?saved.a.listening_result:null,reading:skill==='reading'?saved.a.reading_result:null});}",
    "try {status=await requestPortalSync(accepted,{listening:skill==='listening'?accepted.listening_result:null,reading:skill==='reading'?accepted.reading_result:null});}");
  replaceOnce('    const ownTerm1=term1Mode',
    `    if (owner.term2_paper_profile_id) {
      const official = await paperTarget(pool,owner);
      const view = serialize(paperView(owner,official));
      const result = resultFor(official);
      // A linked profile reads its own unfinished work; once Writing is
      // accepted every profile reads the official submission and grading.
      const writingRow = official.writing_submitted_at ? official : owner;
      const writing = readOnlineWriting && official.completed_at
        ? (await readOnlineWriting(pool,writingRow)).writing : null;
      res.set('Cache-Control','no-store, private').json({
        ...view, exam:view, className:owner.class_name_snapshot, result, writing,
        portalSyncStatus:await readPortalSyncStatus(official,result)
      });
      return;
    }
    const ownTerm1=term1Mode`);
  return source;
}

async function main() {
  const [captured, output] = process.argv.slice(2);
  assert.ok(captured && output, 'Usage: node assemble-overlay.mjs CAPTURED_SRC OUTPUT');
  const writingSqlBytes = await readFile(join(captured,'k56-term-writing-draft.js'));
  await mkdir(output,{recursive:true});
  const files = {};
  for (const [file,previous,assemble] of [
    [entryFile,servingEntrySha,assembleEntry], [recoveryFile,servingRecoverySha,assembleRecovery],
    [writingFile,servingWritingSha,bytes=>assembleWriting(bytes,writingSqlBytes)],
  ]) {
    const source = assemble(await readFile(join(captured,file)));
    await writeFile(join(output,file),source);
    files[file] = {preimage:previous,sha256:digest(source)};
  }
  const migration = await readFile(new URL('./migration.sql',import.meta.url));
  const legacyBridgeMigration = await readFile(new URL('./legacy-bridge.sql',import.meta.url));
  await writeFile(join(output,'migration.sql'),migration);
  await writeFile(join(output,'legacy-bridge.sql'),legacyBridgeMigration);
  const manifest = { baseBuild:'b40e2391ad796ad44067d658d1887fad42df14a9',
    build:digest(JSON.stringify(files)).slice(0,40),files,migrationSha256:digest(migration),
    legacyBridgeMigrationSha256:digest(legacyBridgeMigration) };
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify(manifest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
