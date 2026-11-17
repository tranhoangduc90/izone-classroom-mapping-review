"""Ghép Mini CBT trên byte phục vụ; giữ nguyên mọi overlay Term và phiếu giấy."""
from pathlib import Path
from hashlib import sha256
import shutil,sys,json

def once(source,before,after):
    assert source.count(before)==1,before[:120]
    return source.replace(before,after,1)

def order(source):
    source=once(source,"import {findTerm1Official, term1ParallelMode} from './term1-parallel-entry.mjs';",
        "import {findTerm1Official, term1ParallelMode} from './term1-parallel-entry.mjs';\n"
        "import {findMiniCbtOfficial, miniCbtParallelMode} from './mini-cbt-parallel-entry.mjs';")
    source=once(source,'  term1ContinuationVersion: z.literal(1).optional(),',
        '  term1ContinuationVersion: z.literal(1).optional(),\n  miniCbtContinuationVersion: z.literal(1).optional(),')
    source=once(source,'    ...(a.term1_parallel_entry ? {term1ParallelEntry:true, officialProgress:a.term1_official_progress ?? null} : {}),',
        '    ...(a.term1_parallel_entry ? {term1ParallelEntry:true, officialProgress:a.term1_official_progress ?? null} : {}),\n'
        '    ...(a.mini_cbt_parallel_entry ? {miniCbtParallelEntry:true, officialProgress:a.mini_cbt_official_progress ?? null} : {}),')
    source=once(source,'  const term1Mode = term1ParallelMode();',
        '  const term1Mode = term1ParallelMode();\n  const miniCbtMode = miniCbtParallelMode();')
    source=once(source,'  const withOfficialProgress = async (client, a) => a.term1_parallel_entry',
        '  const withOfficialProgress = async (client, a) => a.mini_cbt_parallel_entry\n'
        '    ? {...a, mini_cbt_official_progress:officialProgress(await findMiniCbtOfficial(client,a))} : a.term1_parallel_entry')
    source=once(source,'      const parallelCbt = term1Cbt || term2Cbt;',
        "      const miniCbt = slug==='mini-test-k56' && body.attemptMode==='cbt' && miniCbtMode!=='off';\n"
        '      const parallelCbt = term1Cbt || term2Cbt || miniCbt;')
    source=once(source,"      const parallelFlag = term1Cbt ? 'term1_parallel_entry' : 'term2_parallel_entry';",
        "      const parallelFlag = miniCbt ? 'mini_cbt_parallel_entry' : term1Cbt ? 'term1_parallel_entry' : 'term2_parallel_entry';")
    source=once(source,"      const officialFlag = term1Cbt ? 'term1_official_submission' : 'term2_official_submission';",
        "      const officialFlag = miniCbt ? 'mini_cbt_official_submission' : term1Cbt ? 'term1_official_submission' : 'term2_official_submission';")
    source=once(source,'      const parallelMode = term1Cbt ? term1Mode : term2Mode;',
        '      const parallelMode = miniCbt ? miniCbtMode : term1Cbt ? term1Mode : term2Mode;')
    source=once(source,'      const findOfficial = term1Cbt ? findTerm1Official : findTerm2Official;',
        '      const findOfficial = miniCbt ? findMiniCbtOfficial : term1Cbt ? findTerm1Official : findTerm2Official;')
    source=once(source,'      const wantsParallel = parallelCbt && (term1Cbt ? body.term1ContinuationVersion===1 : body.term2ContinuationVersion===1);',
        '      const wantsParallel = parallelCbt && (miniCbt ? body.miniCbtContinuationVersion===1 : term1Cbt ? body.term1ContinuationVersion===1 : body.term2ContinuationVersion===1);')
    source=once(source,"    const ownRun=ownTerm1 || (term2Mode!=='off' && owner.term2_parallel_entry);\n    const chosen=ownRun ? await (ownTerm1 ? findTerm1Official : findTerm2Official)(pool,owner) : null;",
        "    const ownMiniCbt=miniCbtMode!=='off' && owner.mini_cbt_parallel_entry;\n"
        "    const ownRun=ownMiniCbt || ownTerm1 || (term2Mode!=='off' && owner.term2_parallel_entry);\n"
        "    const chosen=ownRun ? await (ownMiniCbt ? findMiniCbtOfficial : ownTerm1 ? findTerm1Official : findTerm2Official)(pool,owner) : null;")
    return source

def offline(source):
    # The enhanced core already supports Mini/Paper profiles and Mini blank handling.
    # Only this private Mini copy selects the new helper; shared Term bytes do not change.
    for before,after in [('findTerm2Official','findMiniCbtOfficial'),('lockTerm2Candidate','lockMiniCbtCandidate'),
      ('term2ParallelMode','miniCbtParallelMode'),('writeTerm2OfficialDraft','writeMiniCbtOfficialDraft'),
      ("'./term2-parallel-entry.mjs'","'./mini-cbt-parallel-entry.mjs'"),
      ("profile.tablePrefix==='term2'","profile.tablePrefix==='mini_k56'"),
      ('term2_parallel_entry','mini_cbt_parallel_entry'),('term2Parallel','miniCbtParallel')]:
        assert before in source,before
        source=source.replace(before,after)
    return source

def mini(source):
    source=once(source," if(!row?.state?.writing?.sealed)return null;", """ if(!row?.state?.writing?.sealed){
  // A later profile can seal Writing into the first official attempt. Read its
  // exact committed operation, never an unrelated run or a stale local draft.
  const accepted=(await client.query(`SELECT o.payload, o.receipt, r.state FROM assessment.mini_k56_offline_operation o
    JOIN assessment.mini_k56_offline_run r ON r.attempt_id=o.attempt_id
    JOIN assessment.term_test_attempt source ON source.id=o.attempt_id
    JOIN assessment.term_test_attempt target ON target.id=$1
    JOIN assessment.term_test_exam_session session ON session.id=r.session_id
    WHERE o.section='writing' AND o.kind='seal' AND o.receipt->>'status'='accepted'
      AND o.receipt->>'officialAttemptToken'=target.id::text
      AND source.test_slug='mini-test-k56' AND source.attempt_mode='cbt' AND target.test_slug=source.test_slug
      AND target.attempt_mode=source.attempt_mode AND source.generation=target.generation
      AND source.definition_version=target.definition_version
      AND source.erp_course_class_id=target.erp_course_class_id AND source.erp_student_contact_id=target.erp_student_contact_id
      AND r.generation=source.generation AND r.session_id=source.exam_session_id
      AND session.generation=source.generation AND session.test_slug=source.test_slug
      AND session.erp_course_class_id=source.erp_course_class_id AND session.erp_student_contact_id=source.erp_student_contact_id
      AND session.superseded_at IS NULL
      AND r.policy='mini-k56-offline-v1'
      AND o.receipt->>'attemptToken'=source.id::text
      AND o.receipt->>'examSessionToken'=source.exam_session_id::text
      AND (o.receipt->>'generation')::bigint=source.generation
      AND o.receipt->>'operationId'=o.operation_id::text
      AND o.receipt->>'section'='writing' AND o.receipt->>'kind'='seal'
      AND r.state->'writing'->>'operationId'=o.operation_id::text
      AND r.state->'writing'->>'sealed'='true'
      AND source.superseded_at IS NULL AND target.superseded_at IS NULL
    ORDER BY o.committed_at,o.operation_id LIMIT 1`,[attempt.id])).rows[0];
  if(!accepted){
   if(attempt.mini_cbt_parallel_entry)
    throw Object.assign(Error('Thiếu bài Writing đã khóa; cần đối soát.'),{code:'WRITING_CANONICAL_MISSING'});
   return null;
  }
  const text=accepted.payload?.payload?.task2;
  if(typeof text!=='string'||text!==attempt.writing_task_2
    ||Boolean(accepted.receipt.writingBlank)!==isBlank(text)
    ||Boolean(accepted.state?.writing?.blank)!==isBlank(text))
   throw Object.assign(Error('Bài Writing đã khóa chưa khớp; cần đối soát.'),{code:'WRITING_CANONICAL_MISSING'});
  return {task2:text,blank:isBlank(text)};
 }""")
    return source

def journal(source):
    start=source.index("  if (profile.prefix !== 'mini_k56') {",source.index("  if (profile.prefix !== 'mini_k56') {")+1)
    end=source.index('  try {',source.index('// Keep the existing behavior on deployments missing the native tables.',start))
    block=source[start:end]
    block=once(block,"  if (profile.prefix !== 'mini_k56') {",'  {')
    block=once(block,"      return UUID.test(receipt?.submission_receipt_id||'') ? receipt : {};",
        "      if (UUID.test(receipt?.submission_receipt_id||'')) return receipt;\n"
        "      if (profile.prefix !== 'mini_k56') return {};")
    block=once(block,'      return {};',"      if (profile.prefix !== 'mini_k56') return {};")
    return source[:start]+block+source[end:]

if __name__=='__main__':
    captured,target=map(Path,sys.argv[1:]);assert not target.exists()
    hashes=json.loads((captured/'capture.json').read_text())['files']
    for name in ['src/k56-exam-order.js','src/k56-offline-core.mjs','src/mini-k56-recovery-core.mjs','src/mini-offline.mjs']:
        assert sha256((captured/name).read_bytes()).hexdigest()==hashes[name]['sha256'],name
    nested=json.loads((captured/'nested-capture.json').read_text())
    receipt='src/exam-journal-runtime/adapters/term-k56-offline.mjs'
    assert sha256((captured/receipt).read_bytes()).hexdigest()==nested[receipt]
    files={'k56-exam-order.js':order((captured/'src/k56-exam-order.js').read_text()),
      'mini-k56-recovery-core.mjs':offline((captured/'src/k56-offline-core.mjs').read_text()),
      'mini-offline.mjs':mini((captured/'src/mini-offline.mjs').read_text()),
      'mini-cbt-parallel-entry.mjs':Path(__file__).with_name('mini-cbt-parallel-entry.mjs').read_text(),
      'exam-journal-runtime/adapters/term-k56-offline.mjs':journal((captured/'src/exam-journal-runtime/adapters/term-k56-offline.mjs').read_text())}
    target.mkdir();shutil.copytree(captured/'src',target/'src');shutil.copyfile(captured/'package.json',target/'package.json')
    for name,source in files.items():(target/'src'/name).write_text(source,encoding='utf-8',newline='\n')
    print(json.dumps({name:sha256((target/'src'/name).read_bytes()).hexdigest() for name in files}))
