"""Assemble the Mini K56 paper profile overlay on the captured API."""
from hashlib import sha256
from pathlib import Path
import json
import sys

PREIMAGES = {
    'k56-exam-order.js': 'c6bb4e4e5ec69d12030fccc3447513536d278bc8423e7598080b0dbb7cf17cd3',
    'mini-k56-recovery-core.mjs': 'f0d06a4b17731867dc16e4c0630073591ebc9592bf3fae0c71d809b0a3b4a5b8',
}
IMPORT = "import {findMiniPaperOfficial, isMiniPaper, lockMiniPaperCandidate, miniPaperParallelMode} from './mini-paper-parallel-entry.mjs';"


def apply(source, changes):
    for before, after in changes:
        before = before.replace('SQLQUOTE', chr(96)).replace('JSVAR{', '$'+'{')
        after = after.replace('SQLQUOTE', chr(96)).replace('JSVAR{', '$'+'{')
        if source.count(before) != 1:
            raise ValueError(f'Missing or repeated anchor: {before[:160]!r}')
        source = source.replace(before, after, 1)
    return source


def order(source):
    return apply(source,[
        ('import { findStudentForTermTestSql', IMPORT + "\nimport {writeMiniCbtOfficialDraft} from './mini-cbt-parallel-entry.mjs';\nimport { findStudentForTermTestSql"),
        ('const paperKinds = {', """const miniPaperSlug = 'mini-test-k56';
const paperKinds = {
  [miniPaperSlug]: {request:'miniPaperProfileId',profile:'mini_paper_profile_id',delivery:'answer_sheet',
    parallel:'mini_paper_parallel_entry',official:'mini_paper_official_submission',
    progress:'mini_paper_official_progress',offlineRun:'mini_k56_offline_run',
    find:findMiniPaperOfficial,lock:lockMiniPaperCandidate,write:writeMiniCbtOfficialDraft},"""),
        ('  term1PaperProfileId: z.string().uuid().optional(),', '  miniPaperProfileId: z.string().uuid().optional(),\n  term1PaperProfileId: z.string().uuid().optional(),'),
        ('  s.term2_paper_profile_id,', '  s.mini_paper_profile_id, s.term2_paper_profile_id,'),
        ("    || (progress.writing_submitted_at ? 'result' : 'writing');", "    || (isMiniPaper(a) || progress.writing_submitted_at ? 'result' : 'writing');"),
        ('    ...(a.paperResumedFrom ?', '    ...(a.mini_paper_profile_id ? {miniPaperParallelEntry:true, officialProgress:a.mini_paper_official_progress ?? null} : {}),\n    ...(a.paperResumedFrom ?'),
        ('  const paperModes = {', '  const paperModes = {\n    [miniPaperSlug]:miniPaperParallelMode(),'),
        ('  async function paperTarget(client, scope, lock = false) {\n    if (!paperProfile(scope)) return scope;', """  const hasPaperAuthority = row => Boolean(paperProfile(row)) ||
    (paperModes[miniPaperSlug] !== 'off' && isMiniPaper(row));
  async function paperTarget(client, scope, lock = false) {
    if (!hasPaperAuthority(scope)) return scope;"""),
        ('if (!official[kind.official] || official.definition_version !== scope.definition_version)',
         'if ((!isMiniPaper(scope) && !official[kind.official]) || official.definition_version !== scope.definition_version)'),
        ('return paperProfile(scope) ? {...scope,','return hasPaperAuthority(scope) ? {...scope,'),
        ('if (paperProfile(scope) && official[','if (hasPaperAuthority(scope) && official['),
        ('const withOfficialProgress = async (client, a) => paperProfile(a)','const withOfficialProgress = async (client, a) => hasPaperAuthority(a)'),
        ("assertDelivery(row,body,req.params.testSlug);assertSection(row,'listening');", "assertDelivery(row,body,req.params.testSlug);await assertOpenSection(client,row,'listening');"),
        ("assertDelivery(a,body,req.params.testSlug);assertSection(a,'listening');", "assertDelivery(a,body,req.params.testSlug);await assertOpenSection(client,a,'listening');"),
        ('      });res.json(await withContent(started));return;', '      });res.json(await withContent(await withOfficialProgress(pool,started)));return;'),
        ("      if (kind && paperModes[req.params.testSlug] !== 'off') {", "      if (kind && paperModes[req.params.testSlug] !== 'off' && (kind.delivery !== 'answer_sheet' || body.attemptMode === 'answer_sheet')) {"),
        ('    if (paperProfile(owner)) {','    if (hasPaperAuthority(owner)) {'),
        ('      const writing = readOnlineWriting && official.completed_at','      const writing = !isMiniPaper(owner) && readOnlineWriting && official.completed_at'),
        ("""    const wantsPaper = Boolean(body.term1PaperProfileId || body.term2PaperProfileId);
    if (wantsPaper && (!profileId || body.attemptMode !== 'cbt'
        || (body.term1PaperProfileId && body.term2PaperProfileId)
""","""    const miniPaper = slug === miniPaperSlug && body.attemptMode === 'answer_sheet';
    const profiles = [body.term1PaperProfileId,body.term2PaperProfileId,body.miniPaperProfileId].filter(Boolean);
    const wantsPaper = profiles.length !== 0;
    if (wantsPaper && (!profileId || body.attemptMode !== (paper?.delivery ?? 'cbt') || profiles.length !== 1
"""),
        ('          if (!paperProfile(retained)) {',"""          if (miniPaper) {
            if (paperProfile(retained) && paperProfile(retained) !== profileId)
              throw failure('STUDENT_MISMATCH','Hồ sơ phiếu không khớp lượt đã lưu.',403);
            if (!paperProfile(retained) && create && !exact) {
              const {rows:[run]} = await client.query(
                'SELECT owner_id FROM assessment.mini_k56_offline_run WHERE attempt_id=$1 AND generation=$2',
                [retained.attempt_token,retained.generation]);
              if (run?.owner_id === profileId) {
                await client.query('UPDATE assessment.term_test_exam_session SET mini_paper_profile_id=$2 WHERE id=$1',
                  [retained.exam_session_token,profileId]);
                await client.query('UPDATE assessment.term_test_attempt SET mini_paper_parallel_entry=true WHERE id=$1',
                  [retained.attempt_token]);
                exact=await load(client,slug,retained.attempt_token);
              } else {
                paperResumedFrom=paperScope(retained);
                paperLegacySource=retained;
              }
            } else if (paperProfile(retained) === profileId) exact=retained;
            else if (exact && Number(exact.generation) === Number(retained.generation) && exact.definition_version === retained.definition_version) {
              paperResumedFrom=paperScope(retained);
              paperLegacySource=retained;
            } else throw failure('STUDENT_MISMATCH','Hồ sơ phiếu không khớp lượt đã lưu.',403);
          } else if (!paperProfile(retained)) {"""),
        ('      } else if (parallelCbt && (body.attemptToken || body.examSessionToken)) {',
         '      } else if ((parallelCbt || miniPaper) && (body.attemptToken || body.examSessionToken)) {'),
        ("test_slug:slug,attempt_mode:'cbt',class_id:student.class_id,student_id:student.student_id",
         "test_slug:slug,attempt_mode:body.attemptMode,class_id:student.class_id,student_id:student.student_id"),
        ("""FROM assessment.term_test_attempt WHERE test_slug=$1 AND attempt_mode='cbt'
            AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND superseded_at IS NULLSQLQUOTE,
          [slug,student.class_id,student.student_id]""",
         """FROM assessment.term_test_attempt WHERE test_slug=$1 AND attempt_mode=$4
            AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND superseded_at IS NULLSQLQUOTE,
          [slug,student.class_id,student.student_id,body.attemptMode]"""),
        ("generationJSVAR{wantsParallel?','+parallelFlag:''}JSVAR{wantsPaper?','+paper.profile:''})",
         "generationJSVAR{wantsParallel&&!miniPaper?','+parallelFlag:''}JSVAR{wantsPaper?','+paper.profile:''})"),
        ("VALUES($1,$2,$3,$4,$5,$6,$7,$8JSVAR{wantsParallel?',true':''}JSVAR{wantsPaper?',$9':''})",
         "VALUES($1,$2,$3,$4,$5,$6,$7,$8JSVAR{wantsParallel&&!miniPaper?',true':''}JSVAR{wantsPaper?',$9':''})"),
        ("record(slug === term1PaperSlug ? 'term1_paper_legacy_resumed' : 'term2_paper_legacy_resumed',",
         "record(slug === miniPaperSlug ? 'mini_paper_legacy_resumed' : slug === term1PaperSlug ? 'term1_paper_legacy_resumed' : 'term2_paper_legacy_resumed',"),
    ])


def core(source):
    changes=[
        ('import {isBlank}',IMPORT+'\nimport {isBlank}'),
        (" const miniCbtParallel = profile.tablePrefix==='mini_k56' && miniCbtParallelMode()!=='off';", """ const miniCbtParallel = mini && miniCbtParallelMode()!=='off';
 const miniPaperParallel = mini && miniPaperParallelMode()!=='off';
 const isParallelPaper = a => miniPaperParallel && isMiniPaper(a);
 const findOfficial = (client,a) => isParallelPaper(a) ? findMiniPaperOfficial(client,a)
   : miniCbtParallel ? findMiniCbtOfficial(client,a) : null;"""),
        ('  if(miniCbtParallel)await lockMiniCbtCandidate(client,body.attemptToken);','''  if(miniCbtParallel)await lockMiniCbtCandidate(client,body.attemptToken);
  if(miniPaperParallel)await lockMiniPaperCandidate(client,body.attemptToken);'''),
        ('   const current = miniCbtParallel ? await findMiniCbtOfficial(client,a) : null;','   const current = await findOfficial(client,a);'),
        ('   if(crossDevice && !a.mini_cbt_parallel_entry)','   if(crossDevice && !a.mini_cbt_parallel_entry && !isParallelPaper(a))'),
        ("  const a=await prepare(SLUG,{...body,attemptMode},false);", """  const a=await prepare(SLUG,{...body,attemptMode},false);
  if (paper && a?.mini_paper_profile_id && a.mini_paper_profile_id !== body.ownerId)
    throw fail('OFFLINE_SCOPE_CONFLICT','Hồ sơ không khớp lượt phiếu.',403);"""),
    ]
    for client in ('pool','client'):
        changes.append((
            f'const progress = miniCbtParallel && a.mini_cbt_parallel_entry ? officialProgress(await findMiniCbtOfficial({client},a)) : null;',
            f'const progress = isParallelPaper(a) || (miniCbtParallel && a.mini_cbt_parallel_entry) ? officialProgress(await findOfficial({client},a)) : null;'
        ))
    return apply(source,changes)


if __name__ == '__main__':
    order_path, core_path, output = map(Path,sys.argv[1:])
    release = Path(__file__).resolve().parent
    output.mkdir(parents=True,exist_ok=True)
    SQL=(release/'migration.sql').read_bytes()
    manifest={'baseBuild':'04b111e4a2d92cc70dbbaa0f1249456e8d2f3c05','files':{},'migrationSha256':sha256(SQL).hexdigest()}
    files={'mini-paper-parallel-entry.mjs':(release/'mini-paper-parallel-entry.mjs').read_bytes()}
    for path, transform in [(order_path,order),(core_path,core)]:
        data=path.read_bytes()
        if sha256(data).hexdigest()!=PREIMAGES[path.name]:
            raise ValueError(f'Wrong source revision: {path.name}')
        files[path.name]=transform(data.decode().replace('\r\n','\n')).encode()
    for name,data in sorted(files.items()):
        manifest['files'][name]={'preimage':PREIMAGES.get(name),'sha256':sha256(data).hexdigest()}
        (output/name).write_bytes(data)
    manifest['build']=sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()[:40]
    (output/'migration.sql').write_bytes(SQL)
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps(manifest))
