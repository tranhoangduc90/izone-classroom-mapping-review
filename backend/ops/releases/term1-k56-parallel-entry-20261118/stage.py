"""Add Term1 CBT parallel admission to an exact serving K56 overlay.

Inputs are captured production sources; output contains only the changed files.
Keep the Term1 skill-grant/hold core rather than replacing it with the Term2 core.
"""
from pathlib import Path
import sys


def once(source, before, after):
    assert source.count(before)==1, before[:160]
    return source.replace(before,after,1)


def entry(source):
    source=once(source,"import {findTerm2Official, officialProgress, term2ParallelMode} from './term2-parallel-entry.mjs';",
      "import {findTerm2Official, officialProgress, term2ParallelMode} from './term2-parallel-entry.mjs';\n"
      "import {findTerm1Official, term1ParallelMode} from './term1-parallel-entry.mjs';")
    source=once(source,'  term2ContinuationVersion: z.literal(1).optional(),',
      '  term2ContinuationVersion: z.literal(1).optional(),\n  term1ContinuationVersion: z.literal(1).optional(),')
    source=once(source,'    ...(a.term2_parallel_entry ?',
      '    ...(a.term1_parallel_entry ? {term1ParallelEntry:true, officialProgress:a.term1_official_progress ?? null} : {}),\n    ...(a.term2_parallel_entry ?')
    source=once(source,"  const term2Mode = term2ParallelMode();\n  const withOfficialProgress = async (client, a) => a.term2_parallel_entry",
      "  const term2Mode = term2ParallelMode();\n  const term1Mode = term1ParallelMode();\n"
      "  const withOfficialProgress = async (client, a) => a.term1_parallel_entry\n"
      "    ? {...a, term1_official_progress:officialProgress(await findTerm1Official(client,a))} : a.term2_parallel_entry")
    start=source.index("      const term2Cbt = ")
    end=source.index("      const inserted = ",start)
    block=source[start:end]
    block=once(block,"      const wantsParallel = term2Cbt && body.term2ContinuationVersion===1;", """      const term1Cbt = slug==='term-test-1-k56' && body.attemptMode==='cbt' && term1Mode!=='off';
      const parallelCbt = term1Cbt || term2Cbt;
      const parallelFlag = term1Cbt ? 'term1_parallel_entry' : 'term2_parallel_entry';
      const officialFlag = term1Cbt ? 'term1_official_submission' : 'term2_official_submission';
      const parallelMode = term1Cbt ? term1Mode : term2Mode;
      const findOfficial = term1Cbt ? findTerm1Official : findTerm2Official;
      const wantsParallel = parallelCbt && (term1Cbt ? body.term1ContinuationVersion===1 : body.term2ContinuationVersion===1);""")
    block=block.replace('if (term2Cbt && (body.attemptToken','if (parallelCbt && (body.attemptToken')
    block=block.replace('${term2Cbt ?', '${parallelCbt ?')
    block=block.replace("'OR NOT a.term2_parallel_entry'", "'OR NOT a.'+parallelFlag")
    block=block.replace('`a.term2_official_submission DESC,', '`a.${officialFlag} DESC,')
    block=block.replace("wantsParallel && term2Mode==='drain'", "wantsParallel && parallelMode==='drain'")
    block=block.replace("'AND NOT term2_parallel_entry'", "'AND NOT '+parallelFlag")
    block=block.replace('wantsParallel ? await findTerm2Official(', 'wantsParallel ? await findOfficial(')
    block=block.replace("wantsParallel?',term2_parallel_entry':''", "wantsParallel?','+parallelFlag:''")
    if '      let candidateGeneration=Number(pinnedOfficial?.generation)||0;' not in block:
      block=once(block,'      const definitionVersion = pinnedOfficial?.definition_version ?? student.definition_version;',
      """      const definitionVersion = pinnedOfficial?.definition_version ?? student.definition_version;
      let candidateGeneration=Number(pinnedOfficial?.generation)||0;
      if(wantsParallel&&!pinnedOfficial){
        const epoch=await client.query(`SELECT coalesce(max(generation),0)::text AS generation
          FROM assessment.term_test_attempt WHERE test_slug=$1 AND attempt_mode='cbt'
            AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND superseded_at IS NULL`,
          [slug,student.class_id,student.student_id]);
        candidateGeneration=Number(epoch.rows[0].generation);
      }""")
      block=once(block,'body.attemptMode,Number(pinnedOfficial?.generation)||0]', 'body.attemptMode,candidateGeneration]')
    else:
      assert block.count('body.attemptMode,candidateGeneration]')==1
    source=source[:start]+block+source[end:]
    source=once(source,"    const ownRun=term2Mode!=='off' && owner.term2_parallel_entry;\n    const chosen=ownRun ? await findTerm2Official(pool,owner) : null;", """    const ownTerm1=term1Mode!=='off' && owner.term1_parallel_entry;
    const ownRun=ownTerm1 || (term2Mode!=='off' && owner.term2_parallel_entry);
    const chosen=ownRun ? await (ownTerm1 ? findTerm1Official : findTerm2Official)(pool,owner) : null;""")
    return source


def offline(source):
    source=once(source,"import {z} from 'zod';", "import {z} from 'zod';\n"
      "import {findTerm1Official, finishedSkill, lockTerm1Candidate, officialProgress,\n"
      "  term1ParallelMode, writeTerm1OfficialDraft} from './term1-parallel-entry.mjs';")
    source=once(source,' const holdPolicy=term1HoldPolicy();',
      " const holdPolicy=term1HoldPolicy();\n const term1Parallel=profile.tablePrefix==='term1' && term1ParallelMode()!=='off';")
    source=once(source,'  const a=await load(client,SLUG,target.attempt_id,false,true);',
      '  if(term1Parallel)await lockTerm1Candidate(client,target.attempt_id);\n  const a=await load(client,SLUG,target.attempt_id,false,true);')
    source=once(source,'  res.json({...serialize(current),content,timing,...mainProgress(current,run),',
      '  const progress=term1Parallel&&current.term1_parallel_entry ? officialProgress(await findTerm1Official(pool,current)) : null;\n'
      '  res.json({...serialize(current),...(progress?{officialProgress:progress}:{}),content,timing,...mainProgress(current,run),')
    source=once(source,'   return mainProgress(a,run);',
      '   const progress=term1Parallel&&a.term1_parallel_entry ? officialProgress(await findTerm1Official(client,a)) : null;\n'
      '   return {...mainProgress(a,run),...(progress?{officialProgress:progress}:{})};')
    source=once(source,'if(previous)return {receipt:previous,a,replayed:true};',
      'if(previous)return {receipt:previous,a:previous.officialAttemptToken?await load(client,SLUG,previous.officialAttemptToken):a,replayed:true};')
    before="""   const index=order.indexOf(b.section),prior=index?state[order[index-1]]:null;
   if(!grant)await rejectMainSkillIfBound(client,a,b.section);
   if(grant&&b.dependency!==null)throw fail('TERM1_SKILL_DEPENDENCY','Link dự phòng không nhận quyền của kỹ năng khác.',403);
   if(!grant&&index&&(!(prior?.sealed||prior?.interrupted)||prior.operationId!==b.dependency))throw fail('OFFLINE_DEPENDENCY','Kỹ năng trước chưa được xác nhận; bài đang chờ gửi.');"""
    after="""   const current=term1Parallel ? await findTerm1Official(client,a) : null;
   const crossDevice=current && current.attempt_token!==a.attempt_token;
   if(crossDevice && (!a.term1_parallel_entry || grant))
    throw fail('OFFLINE_NATIVE_CONFLICT','Máy chủ đã lưu bài chính thức từ lượt khác. Bản trên máy vẫn được giữ.',409);
   if(crossDevice && Number(current.definition_version)!==Number(a.definition_version))
    throw fail('DEFINITION_CHANGED','Lượt chính thức đang dùng đề đã ghim khác. Bản trên máy vẫn được giữ.',409);
   if(crossDevice && finishedSkill(current,b.section))return {a,officialProgress:officialProgress(current)};
   const index=order.indexOf(b.section),priorSkill=index?order[index-1]:null,prior=state[priorSkill];
   if(!grant)await rejectMainSkillIfBound(client,a,b.section);
   if(grant&&b.dependency!==null)throw fail('TERM1_SKILL_DEPENDENCY','Link dự phòng không nhận quyền của kỹ năng khác.',403);
   const validLocalPrior=(prior?.sealed||prior?.interrupted)&&prior.operationId===b.dependency;
   if(!grant&&index&&!validLocalPrior&&!(crossDevice&&finishedSkill(current,priorSkill)))
    throw fail('OFFLINE_DEPENDENCY','Kỹ năng trước chưa được xác nhận; bài đang chờ gửi.');"""
    source=once(source,before,after)
    source=once(source,'   const receipt={version:1,receiptId:randomUUID(),',
      "   const acceptsSkill=!review && (b.kind==='seal'||interruption);\n"
      '   let official=crossDevice&&acceptsSkill ? await load(client,SLUG,current.attempt_token,false,true) : a;\n'
      '   const receipt={...(crossDevice&&acceptsSkill?{officialAttemptToken:official.attempt_token}:{}),version:1,receiptId:randomUUID(),')
    source=once(source,'    if(interruption)await client.query(`UPDATE assessment.term_test_attempt',
      '    if(crossDevice&&acceptsSkill)await writeTerm1OfficialDraft(client,a,official,b.section,p,b.revision);\n'
      '    if(interruption)await client.query(`UPDATE assessment.term_test_attempt')
    source=once(source,"WHERE id=$1`,[a.attempt_token,b.occurredAt]);\n    else if(b.section==='listening')",
      "WHERE id=$1`,[official.attempt_token,b.occurredAt]);\n    else if(b.section==='listening')")
    source=once(source,'    else await client.query(`UPDATE assessment.term_test_attempt SET writing_started_at',
      '    else if(!crossDevice)await client.query(`UPDATE assessment.term_test_attempt SET writing_started_at')
    start=source.index("    if(b.kind==='seal'){\n")
    end=source.index('    state[b.section]',start)
    block=source[start:end].replace('a.attempt_token','official.attempt_token').replace('a.exam_session_token','official.exam_session_token')
    block=block.replace('parseStoredTest(a)','parseStoredTest(official)').replace('a=await load(','official=await load(')
    block=block.replace('resultFor(a)','resultFor(official)').replace('a.listening_submitted_at&&a.reading_submitted_at','official.listening_submitted_at&&official.reading_submitted_at')
    block=block.replace('buildErpGradePayload(a,','buildErpGradePayload(official,')
    source=source[:start]+block+source[end:]
    source=once(source,'   return {receipt,a:await load(client,SLUG,a.attempt_token),replayed:false};',
      '   return {receipt,a:await load(client,SLUG,official.attempt_token),replayed:false};')
    source=once(source,"  note('offline_operation_committed',SLUG,out.a.attempt_token,{...baseMeta,receiptId:out.receipt.receiptId,",
      "  if(out.officialProgress)return res.json({ok:true,persisted:false,receipt:null,officialProgress:out.officialProgress});\n"
      "  note('offline_operation_committed',SLUG,req.term1FallbackAttemptId??b.attemptToken,{...baseMeta,generation:b.generation,receiptId:out.receipt.receiptId,")
    source=once(source,'SELECT DISTINCT o.attempt_id FROM assessment.term2_offline_operation o\n    JOIN assessment.term_test_attempt a ON a.id=o.attempt_id',
      "SELECT DISTINCT a.id AS attempt_id FROM assessment.term2_offline_operation o\n    JOIN assessment.term_test_attempt a ON a.id=coalesce((o.receipt->>'officialAttemptToken')::uuid,o.attempt_id)")
    return source


def main():
    captured,target=map(Path,sys.argv[1:])
    target.mkdir(parents=True,exist_ok=True)
    for name,transform in [('k56-exam-order.js',entry),('term1-skill-offline-core.mjs',offline)]:
        source=(captured/name).read_text(encoding='utf-8')
        (target/name).write_text(transform(source),encoding='utf-8',newline='\n')
    helper=(captured/'term2-parallel-entry.mjs').read_text(encoding='utf-8')
    helper=helper.replace('term2','term1').replace('Term2','Term1').replace('TERM2','TERM1').replace('Term 2','Term 1')
    helper=helper.replace('term-test-2-k56','term-test-1-k56')
    helper=helper.replace('writing_task_1','writing_task_2').replace('payload.task1','payload.task2')
    helper=helper.replace(' OR listening_interrupted_at IS NOT NULL','')
    helper=helper.replace('listening_submitted_at,listening_interrupted_at,','listening_submitted_at,')
    (target/'term1-parallel-entry.mjs').write_text(helper,encoding='utf-8',newline='\n')
    term2=(captured/'term2-parallel-entry.mjs').read_text(encoding='utf-8')
    term2=term2.replace(' OR listening_interrupted_at IS NOT NULL','')
    term2=term2.replace('listening_submitted_at,listening_interrupted_at,','listening_submitted_at,')
    (target/'term2-parallel-entry.mjs').write_text(term2,encoding='utf-8',newline='\n')
    print('Staged Term1 admission and scoped Term2 first-valid correction; skill grant modules unchanged')


if __name__=='__main__':main()
