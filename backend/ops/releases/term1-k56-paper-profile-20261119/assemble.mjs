import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const baseBuild = '59e4c428326c1f29db8a1c09497d39ff2ecaa660';
const pins = {
  'k56-exam-order.js':'cb578acfccfd7d1a66d7eaff789677413aaa80891798324aff9719d1accb6b52',
  'term-online-submission.mjs':'661d5afbb5d77f806bb976828f241705cbdbdd2541b60e3e0319ca7baff21759',
  'term-online-writing.mjs':'35d2eeb1196957dc698b010b70dc5885e8fd89cfd8f818e2283680496470dbbe',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function edit(source, name) {
  return (before, after) => {
    assert.equal(source.text.split(before).length, 2, name + ' anchor: ' + before);
    source.text = source.text.replace(before, () => after);
  };
}

function order(source) {
  const put = edit(source, 'exam order');
  put('import {findTerm1Official, term1ParallelMode}',
    'import {findTerm1Official, lockTerm1Candidate, term1ParallelMode, writeTerm1OfficialDraft}');
  put("const term2PaperSlug = 'term-test-2-k56';", `const term1PaperSlug = 'term-test-1-k56';
const term2PaperSlug = 'term-test-2-k56';
const paperKinds = {
  [term1PaperSlug]: {request:'term1PaperProfileId',profile:'term1_paper_profile_id',
    bridge:'term1_paper_legacy_bridge',parallel:'term1_parallel_entry',official:'term1_official_submission',
    progress:'term1_official_progress',offlineRun:'term1_offline_run',privateWriting:'term1_paper_private_writing',
    find:findTerm1Official,lock:lockTerm1Candidate,write:writeTerm1OfficialDraft},
  [term2PaperSlug]: {request:'term2PaperProfileId',profile:'term2_paper_profile_id',
    bridge:'term2_paper_legacy_bridge',parallel:'term2_parallel_entry',official:'term2_official_submission',
    progress:'term2_official_progress',offlineRun:'term2_offline_run',privateWriting:'term2_paper_private_writing',
    find:findTerm2Official,lock:lockTerm2Candidate,write:writeTerm2OfficialDraft}
};
const paperKind = slug => Object.hasOwn(paperKinds,slug) ? paperKinds[slug] : undefined;
const paperProfile = row => row[paperKind(row.test_slug)?.profile];`);
  put('  term2PaperProfileId: z.string().uuid().optional(),',
    '  term1PaperProfileId: z.string().uuid().optional(),\n  term2PaperProfileId: z.string().uuid().optional(),');
  put('  s.term2_paper_profile_id, s.term2_paper_legacy_bridge,',
    '  s.term2_paper_profile_id, s.term2_paper_legacy_bridge, s.term1_paper_profile_id, s.term1_paper_legacy_bridge,');
  put('const bridge = a.term2_paper_legacy_bridge;', 'const bridge = a[paperKind(a.test_slug)?.bridge];');
  put('    ...(a.term2_paper_profile_id ? {term2PaperParallelEntry:true} : {}),',
    '    ...(a.term2_paper_profile_id ? {term2PaperParallelEntry:true} : {}),\n    ...(a.term1_paper_profile_id ? {term1PaperParallelEntry:true} : {}),');
  put("  const term2PaperMode = term2ParallelMode(process.env.K56_TERM2_PAPER_PARALLEL_ENTRY_MODE || 'off');", `  const paperModes = {
    [term1PaperSlug]:term1ParallelMode(process.env.K56_TERM1_PAPER_PARALLEL_ENTRY_MODE || 'off'),
    [term2PaperSlug]:term2ParallelMode(process.env.K56_TERM2_PAPER_PARALLEL_ENTRY_MODE || 'off')
  };`);
  put(`    if (!scope.term2_paper_profile_id) return scope;
    const chosen = await findTerm2Official(client, scope);`,
  `    if (!paperProfile(scope)) return scope;
    const kind = paperKind(scope.test_slug);
    const chosen = await kind.find(client, scope);`);
  put('if (!official.term2_official_submission || official.definition_version !== scope.definition_version)',
    'if (!official[kind.official] || official.definition_version !== scope.definition_version)');
  put(`    return scope.term2_paper_profile_id ? {...scope,
      paperOfficial:official, term2_official_progress:officialProgress(official)} : scope;`,
    `    return paperProfile(scope) ? {...scope,
      paperOfficial:official, [paperKind(scope.test_slug).progress]:officialProgress(official)} : scope;`);
  put('    if (!scope.term2_paper_profile_id) return scope;', '    if (!paperProfile(scope)) return scope;');
  put('    if (scope.term2_paper_profile_id && official[`${skill}_submitted_at`])',
    '    if (paperProfile(scope) && official[`${skill}_submitted_at`])');
  put('    assertSection(paperView(scope, official), skill);',
    `    if (scope.test_slug === term1PaperSlug && paperProfile(scope) && official.attempt_token !== scope.attempt_token)
      await rejectMainSkillIfBound(client,official,skill);
    assertSection(paperView(scope, official), skill);`);
  put('const withOfficialProgress = async (client, a) => a.term2_paper_profile_id',
    'const withOfficialProgress = async (client, a) => paperProfile(a)');

  put(`    const wantsTerm2Paper = Boolean(body.term2PaperProfileId);
    if (wantsTerm2Paper && (slug !== term2PaperSlug || body.attemptMode !== 'cbt' || body.term2ContinuationVersion))`,
    `    const paper = paperKind(slug);
    const profileId = body[paper?.request];
    const wantsPaper = Boolean(body.term1PaperProfileId || body.term2PaperProfileId);
    if (wantsPaper && (!profileId || body.attemptMode !== 'cbt'
        || (body.term1PaperProfileId && body.term2PaperProfileId)
        || body.term1ContinuationVersion || body.term2ContinuationVersion || body.miniCbtContinuationVersion))`);
  put("    if (wantsTerm2Paper && term2PaperMode === 'off')", "    if (wantsPaper && paperModes[slug] === 'off')");
  put('if (wantsTerm2Paper && body.identityConfirmed !== true)', 'if (wantsPaper && body.identityConfirmed !== true)');
  put('if (wantsTerm2Paper && a.term2_paper_profile_id !== body.term2PaperProfileId)',
    'if (wantsPaper && paperProfile(a) !== profileId)');
  put("const parallelFlag = miniCbt ?", "const parallelFlag = wantsPaper ? paper.parallel : miniCbt ?");
  put('const parallelMode = wantsTerm2Paper ? term2PaperMode :',
    'const parallelMode = wantsPaper ? paperModes[slug] :');
  put('const findOfficial = miniCbt ?', 'const findOfficial = wantsPaper ? paper.find : miniCbt ?');
  put('const wantsParallel = wantsTerm2Paper ||', 'const wantsParallel = wantsPaper ||');
  put('      if (wantsTerm2Paper) {', '      if (wantsPaper) {');
  put('s.term2_paper_profile_id=$2 AND a.erp_course_class_id=$3',
    's.${paper.profile}=$2 AND a.erp_course_class_id=$3');
  put('[slug, body.term2PaperProfileId, student.class_id, student.student_id]',
    '[slug, profileId, student.class_id, student.student_id]');
  put('          if (!retained.term2_paper_profile_id) {', '          if (!paperProfile(retained)) {');
  put('if (!create || exact || retained.term2_parallel_entry)', 'if (!create || exact || retained[paper.parallel])');
  put("'SELECT 1 FROM assessment.term2_offline_run WHERE attempt_id=$1 AND generation=$2'",
    '`SELECT 1 FROM assessment.${paper.offlineRun} WHERE attempt_id=$1 AND generation=$2`');
  put('`UPDATE assessment.term_test_exam_session SET term2_parallel_entry=true,\n              term2_paper_profile_id=$2,term2_paper_legacy_bridge=$3::jsonb WHERE id=$1`',
    '`UPDATE assessment.term_test_exam_session SET ${paper.parallel}=true,\n              ${paper.profile}=$2,${paper.bridge}=$3::jsonb WHERE id=$1`');
  put('[retained.exam_session_token,body.term2PaperProfileId,JSON.stringify(paperLegacySnapshot(retained))]',
    '[retained.exam_session_token,profileId,JSON.stringify(paperLegacySnapshot(retained))]');
  put("'UPDATE assessment.term_test_attempt SET term2_parallel_entry=true WHERE id=$1'",
    '`UPDATE assessment.term_test_attempt SET ${paper.parallel}=true WHERE id=$1`');
  put('} else if (retained.term2_paper_profile_id === body.term2PaperProfileId) {',
    '} else if (paperProfile(retained) === profileId) {');
  put('if (term2Cbt && body.term2ContinuationVersion && exact.term2_paper_profile_id)',
    'if ((body.term1ContinuationVersion || body.term2ContinuationVersion) && paperProfile(exact))');
  put('const legacyClock = paperLegacySource?.term2_paper_legacy_bridge;',
    'const legacyClock = paperLegacySource?.[paper.bridge];');
  put("${wantsTerm2Paper?',term2_paper_profile_id':''}", "${wantsPaper?','+paper.profile:''}");
  put("${wantsTerm2Paper?',$9':''}", "${wantsPaper?',$9':''}");
  put('...(wantsTerm2Paper?[body.term2PaperProfileId]:[])', '...(wantsPaper?[profileId]:[])');
  put('const snapshot = pinnedOfficial?.mini_definition_snapshot || {',
    'const snapshot = paperLegacySource?.mini_definition_snapshot || pinnedOfficial?.mini_definition_snapshot || {');
  put('          term2_paper_legacy_bridge=$2::jsonb, listening_started_at=$3, listening_deadline_at=$4,',
    '          ${paper.bridge}=$2::jsonb, listening_started_at=$3, listening_deadline_at=$4,');
  put('`UPDATE assessment.term_test_attempt SET term2_parallel_entry=true,',
    '`UPDATE assessment.term_test_attempt SET ${paper.parallel}=true,');
  put('writing_deadline_at=$5, writing_updated_at=$6, term2_paper_private_writing=',
    'writing_deadline_at=$5, writing_updated_at=$6, ${paper.privateWriting}=');
  put("if (prepared?.paperLegacyCreated) record('term2_paper_legacy_resumed',",
    "if (prepared?.paperLegacyCreated) record(slug === term1PaperSlug ? 'term1_paper_legacy_resumed' : 'term2_paper_legacy_resumed',");

  put(`      if (slug === term2PaperSlug && term2PaperMode !== 'off') await lockTerm2Candidate(client,token);`,
    `      const kind = paperKind(slug);
      if (kind && paperModes[slug] !== 'off') await kind.lock(client,token);`);
  put('      if (!scope.term2_paper_profile_id || scope.session_superseded_at',
    '      if (!paperProfile(scope) || scope.session_superseded_at');
  put(`    paperTarget,
    async lockPaperWriting`, `    paperTarget,
    async guardPaperWriting(client, scope, official) {
      if (scope.test_slug !== term1PaperSlug) return;
      await rejectMainSkillIfBound(client,scope,'writing');
      if (scope.attempt_token !== official.attempt_token) await rejectMainSkillIfBound(client,official,'writing');
    },
    async lockPaperWriting`);
  put("if (current.term2_paper_profile_id) await assertOpenSection(pool,current,'listening');",
    "if (paperProfile(current)) await assertOpenSection(pool,current,'listening');");
  put(`      if (term2PaperMode !== 'off' && req.params.testSlug === term2PaperSlug) {
        const source = await load(client,term2PaperSlug,sourceToken,skill==='listening',false,false);
        await lockTerm2Candidate(client,source.attempt_token);
      }`, `      const kind = paperKind(req.params.testSlug);
      if (kind && paperModes[req.params.testSlug] !== 'off') {
        const source = await load(client,req.params.testSlug,sourceToken,skill==='listening',false,false);
        await kind.lock(client,source.attempt_token);
      }`);
  put('        await writeTerm2OfficialDraft(client, scope, official, skill, {',
    "        if (scope.test_slug === term1PaperSlug) await rejectMainSkillIfBound(client,official,skill);\n        await kind.write(client, scope, official, skill, {");
  put('    if (owner.term2_paper_profile_id) {', '    if (paperProfile(owner)) {');
}

function recovery(source) {
  const put = edit(source, 'submission receipt');
  put(`        || (linked && (!scope.term2_paper_profile_id || a.test_slug !== scope.test_slug
          || a.attempt_mode !== scope.attempt_mode || a.class_id !== scope.class_id || a.student_id !== scope.student_id
          || a.definition_version !== scope.definition_version || !a.term2_official_submission)))`,
    `        || (linked && (!(scope.test_slug === 'term-test-1-k56'
          ? scope.term1_paper_profile_id && a.term1_official_submission
          : scope.term2_paper_profile_id && a.term2_official_submission) || a.test_slug !== scope.test_slug
          || a.attempt_mode !== scope.attempt_mode || a.class_id !== scope.class_id || a.student_id !== scope.student_id
          || a.definition_version !== scope.definition_version)))`);
}

function writing(source) {
  const put = edit(source, 'online writing');
  put('export function registerTermOnlineWriting', `const term1PaperDraftSchema = paperDraftSchema.extend({term1PaperParallelEntry:z.literal(true)});
const term1PaperSql = paperSql.replaceAll('term-test-2-k56','term-test-1-k56')
  .replaceAll('term2_paper_profile_id','term1_paper_profile_id')
  .replaceAll('term2_official_submission','term1_official_submission')
  .replaceAll('term2_paper_private_writing','term1_paper_private_writing');
const sqlForPaper = slug => slug === 'term-test-1-k56' ? term1PaperSql : paperSql;

export function registerTermOnlineWriting`);
  put('notifyWriting, lockPaperWriting, loadPaperWriting, paperTarget',
    'notifyWriting, lockPaperWriting, loadPaperWriting, paperTarget, guardPaperWriting');
  put(`    if (slug !== 'term-test-2-k56') return next();
    const parsed = paperDraftSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.task2 !== '')`, `    const term1Paper = slug === 'term-test-1-k56' && req.body?.term1PaperParallelEntry === true;
    if (slug !== 'term-test-2-k56' && !term1Paper) return next();
    const parsed = (term1Paper ? term1PaperDraftSchema : paperDraftSchema).safeParse(req.body);
    if (!parsed.success || (term1Paper ? parsed.data.task1 !== '' : parsed.data.task2 !== ''))`);
  put('      const {rows:[row]} = await client.query(paperSql,',
    '      await guardPaperWriting(client,scope,official);\n      const {rows:[row]} = await client.query(sqlForPaper(slug),');
  put('      const paper = Boolean(scope.term2_paper_profile_id);',
    '      const paper = Boolean(scope.term1_paper_profile_id || scope.term2_paper_profile_id);');
  put('      const { rows: [row] } = await client.query(paper ? paperSql : saveK56TermWritingSql,',
    `      if (scope.term1_paper_profile_id) {
        if (task1 !== '') throw failure('INVALID_WRITING', 'Phiếu này chỉ nhận Writing Task 2.', 400);
        await guardPaperWriting(client,scope,a);
      }
      const { rows: [row] } = await client.query(paper ? sqlForPaper(slug) : saveK56TermWritingSql,`);
}

export function assemble(file, bytes) {
  assert.equal(digest(bytes), pins[file], file);
  const source = {text:bytes.toString('utf8').replaceAll('\r\n','\n')};
  ({'k56-exam-order.js':order,'term-online-submission.mjs':recovery,'term-online-writing.mjs':writing})[file](source);
  return source.text;
}

async function main() {
  const [baseline, output] = process.argv.slice(2);
  assert.ok(baseline && output);
  await mkdir(output,{recursive:true});
  const files = {};
  for (const [name, preimage] of Object.entries(pins)) {
    const text = assemble(name, await readFile(join(baseline,name)));
    files[name] = {preimage,sha256:digest(text)};
    await writeFile(join(output,name),text);
  }
  const migration = await readFile(new URL('./migration.sql',import.meta.url));
  await writeFile(join(output,'migration.sql'),migration);
  const manifest = {baseBuild,build:digest(JSON.stringify(files)).slice(0,40),files,migrationSha256:digest(migration)};
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify(manifest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
