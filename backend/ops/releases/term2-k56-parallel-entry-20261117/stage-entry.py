"""Stage the Term 2 CBT admission changes on a K56 runtime source snapshot."""
from pathlib import Path
import sys


def replace_once(source, previous, next_source):
    if source.count(previous) != 1:
        raise ValueError(f"Expected one anchor: {previous[:100]}")
    return source.replace(previous, next_source, 1)


def stage_entry(source):
    source = replace_once(source, "import { z } from 'zod';",
        "import { z } from 'zod';\n"
        "import {findTerm2Official, officialProgress, term2ParallelMode} from './term2-parallel-entry.mjs';")
    source = replace_once(source,
        "studentRef: z.string().uuid(), mode: modeSchema, publicAudioVersion: z.literal(1).optional(),",
        "studentRef: z.string().uuid(), mode: modeSchema, publicAudioVersion: z.literal(1).optional(),\n"
        "  term2ContinuationVersion: z.literal(1).optional(),")
    source = replace_once(source,
        "onlineRecoveryCapability(a),\n    attemptToken:",
        "onlineRecoveryCapability(a),\n    ...(a.term2_parallel_entry ? {term2ParallelEntry:true, officialProgress:a.term2_official_progress ?? null} : {}),\n    attemptToken:")
    source = replace_once(source,
        "  const router = Router();\n",
        "  const router = Router();\n"
        "  const term2Mode = term2ParallelMode();\n"
        "  const withOfficialProgress = async (client, a) => a.term2_parallel_entry\n"
        "    ? {...a, term2_official_progress:officialProgress(await findTerm2Official(client,a))} : a;\n")
    source = replace_once(source,
        "      const latest = await client.query(`${loadSql} AND a.test_slug=$1 AND (a.definition_version=$2 OR a.test_slug IN ('mini-test-k56','term-test-1-k56','term-test-2-k56')) AND a.erp_course_class_id=$3 AND a.erp_student_contact_id=$4 ORDER BY a.created_at DESC LIMIT 1 FOR UPDATE OF a`, [slug, student.definition_version, student.class_id, student.student_id]);",
        """      const term2Cbt = slug==='term-test-2-k56' && body.attemptMode==='cbt' && term2Mode!=='off';
      const wantsParallel = term2Cbt && body.term2ContinuationVersion===1;
      const key = [slug, student.definition_version, student.class_id, student.student_id];
      let latest;
      if (term2Cbt && (body.attemptToken || body.examSessionToken)) {
        const exact = await load(client, slug, body.attemptToken || body.examSessionToken, !body.attemptToken, true);
        if (String(exact.class_id)!==String(student.class_id) || String(exact.student_id)!==String(student.student_id)
            || (body.examSessionToken && exact.exam_session_token!==body.examSessionToken)
            || (body.generation!==undefined && Number(exact.generation)!==body.generation)) {
          throw failure('STUDENT_MISMATCH','Danh tính không khớp lượt thi.',403);
        }
        latest = {rows:[exact]};
      } else if (wantsParallel) {
        latest = {rows:[]};
      } else {
        latest = await client.query(`${loadSql} AND a.test_slug=$1
          AND (a.definition_version=$2 OR a.test_slug IN ('mini-test-k56','term-test-1-k56','term-test-2-k56'))
          AND a.erp_course_class_id=$3 AND a.erp_student_contact_id=$4
          ${term2Cbt ? `AND (a.listening_submitted_at IS NOT NULL OR a.listening_interrupted_at IS NOT NULL
            OR a.reading_submitted_at IS NOT NULL OR a.writing_submitted_at IS NOT NULL
            ${wantsParallel ? '' : 'OR NOT a.term2_parallel_entry'})` : ''}
          ORDER BY ${term2Cbt ? `a.term2_official_submission DESC, least(a.listening_submitted_at,a.listening_interrupted_at,
            a.reading_submitted_at,a.writing_submitted_at) ASC NULLS LAST, ` : ''}
          a.created_at DESC LIMIT 1 FOR UPDATE OF a`, key);
      }""")
    source = replace_once(source, "      if (['mini-test-k56', 'term-test-1-k56', 'term-test-2-k56'].includes(slug)) {\n        const existing",
        "      if (!wantsParallel && ['mini-test-k56', 'term-test-1-k56', 'term-test-2-k56'].includes(slug)) {\n        const existing")
    source = replace_once(source, "      if (!create) return null;\n",
        "      if (!create) return null;\n"
        "      if (wantsParallel && term2Mode==='drain') throw failure('OFFLINE_NEW_DISABLED','Chưa mở được phiên thi mới.',503);\n")
    source = replace_once(source, "AND superseded_at IS NULL ORDER BY prepared_at DESC LIMIT 1 FOR UPDATE`, [slug, student.definition_version, student.class_id, student.student_id]);",
        "AND superseded_at IS NULL ${term2Cbt ? 'AND NOT term2_parallel_entry' : ''} ORDER BY prepared_at DESC LIMIT 1 FOR UPDATE`, [slug, student.definition_version, student.class_id, student.student_id]);")
    source = replace_once(source, "      let s = sessions.rows[0];", "      let s = wantsParallel ? null : sessions.rows[0];")
    source = replace_once(source, "      const mode = s?.listening_started_at ? 'lis_first' : body.mode;",
        """      const mode = s?.listening_started_at ? 'lis_first' : body.mode;
      const officialIdentity = wantsParallel ? await findTerm2Official(client,{
        test_slug:slug,attempt_mode:'cbt',class_id:student.class_id,student_id:student.student_id
      }) : null;
      const pinnedOfficial = officialIdentity ? await load(client,slug,officialIdentity.attempt_token) : null;
      const definitionVersion = pinnedOfficial?.definition_version ?? student.definition_version;""")
    source = replace_once(source,
        """      if (!s) s = (await client.query(`INSERT INTO assessment.term_test_exam_session(test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot,attempt_mode) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [slug, student.definition_version, student.class_id, student.class_name, student.student_id, student.student_name,body.attemptMode])).rows[0];""",
        """      if (!s) s = (await client.query(`INSERT INTO assessment.term_test_exam_session
        (test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,
         student_name_snapshot,attempt_mode,generation${wantsParallel?',term2_parallel_entry':''})
        VALUES($1,$2,$3,$4,$5,$6,$7,$8${wantsParallel?',true':''}) RETURNING *`,
        [slug,definitionVersion,student.class_id,student.class_name,student.student_id,
          student.student_name,body.attemptMode,Number(pinnedOfficial?.generation)||0])).rows[0];""")
    source = replace_once(source,
        "crypto.randomUUID(),slug,student.definition_version,student.class_id",
        "crypto.randomUUID(),slug,definitionVersion,student.class_id")
    source = replace_once(source, "        const snapshot = {\n          version:",
        "        const snapshot = pinnedOfficial?.mini_definition_snapshot || {\n          version:")
    source = replace_once(source,
        "      return load(client, slug, inserted.rows[0].id);",
        "      return withOfficialProgress(client,await load(client, slug, inserted.rows[0].id));")
    source = replace_once(source,
        "        return a;\n      }\n      if (!wantsParallel",
        "        return withOfficialProgress(client,a);\n      }\n      if (!wantsParallel")
    source = replace_once(source,
        "    const found = await pool.query(`${loadSql} AND a.id=$1::uuid`,[token]); const a=found.rows[0];\n"
        "    if (!a || !slugs.has(a.test_slug) || a.completed_at) return next();",
        """    const found = await pool.query(`${loadSql} AND a.id=$1::uuid`,[token]);
    const owner=found.rows[0];
    if (!owner || !slugs.has(owner.test_slug)) return next();
    const ownRun=term2Mode!=='off' && owner.term2_parallel_entry;
    const chosen=ownRun ? await findTerm2Official(pool,owner) : null;
    const linked=chosen && chosen.attempt_token!==owner.attempt_token;
    const a=linked ? await load(pool,owner.test_slug,chosen.attempt_token) : owner;
    if (a.completed_at && !linked) return next();
    const view=linked ? {...serialize(a),attemptToken:owner.attempt_token,examSessionToken:owner.exam_session_token} : serialize(a);""")
    return replace_once(source,
        "    res.json({ ...serialize(a), className:a.class_name_snapshot, result,\n"
        "      portalSyncStatus:await readPortalSyncStatus(a,result), exam:{...serialize(a)}, writing });",
        "    res.json({ ...view, className:a.class_name_snapshot, result,\n"
        "      portalSyncStatus:await readPortalSyncStatus(a,result), exam:view, writing });")


def stage_offline(source):
    source = replace_once(source, "import {z} from 'zod';",
        "import {z} from 'zod';\n"
        "import {findTerm2Official, finishedSkill, lockTerm2Candidate, officialProgress,\n"
        "  term2ParallelMode, writeTerm2OfficialDraft} from './term2-parallel-entry.mjs';")
    source = replace_once(source, " const recovery=createSubmissionRecovery({",
        " const term2Parallel = profile.tablePrefix==='term2' && term2ParallelMode()!=='off';\n"
        " const recovery=createSubmissionRecovery({")
    source = replace_once(source, "  const a=await load(client,SLUG,body.attemptToken,false,true);",
        "  if(term2Parallel)await lockTerm2Candidate(client,body.attemptToken);\n"
        "  const a=await load(client,SLUG,body.attemptToken,false,true);")
    source = replace_once(source, "  res.json({...serialize(a),...(paper?{}:{content,timing}),",
        "  const progress = term2Parallel && a.term2_parallel_entry ? officialProgress(await findTerm2Official(pool,a)) : null;\n"
        "  res.json({...serialize(a),...(progress?{officialProgress:progress}:{}),...(paper?{}:{content,timing}),")
    source = replace_once(source, "   return {receipt,held:await recovery.read(client,req,a,run,b,receipt)};",
        "   const progress = term2Parallel && a.term2_parallel_entry ? officialProgress(await findTerm2Official(client,a)) : null;\n"
        "   return {receipt,progress,held:await recovery.read(client,req,a,run,b,receipt)};")
    source = replace_once(source, "receipt:result.receipt||null,...(result.held",
        "receipt:result.receipt||null,...(result.progress?{officialProgress:result.progress}:{}),...(result.held")
    source = replace_once(source,
        "   const index=order.indexOf(b.section),prior=index?state[order[index-1]]:null;\n"
        "   if(index&&(!(prior?.sealed||prior?.interrupted)||prior.operationId!==b.dependency))throw fail('OFFLINE_DEPENDENCY','Kỹ năng trước chưa được xác nhận; bài đang chờ gửi.');",
        """   const current = term2Parallel ? await findTerm2Official(client,a) : null;
   const crossDevice = current && current.attempt_token!==a.attempt_token;
   if(crossDevice && !a.term2_parallel_entry)
    throw fail('OFFLINE_NATIVE_CONFLICT','Máy chủ đã lưu bài chính thức từ lượt khác. Bản trên máy vẫn được giữ.',409);
   if(crossDevice && Number(current.definition_version)!==Number(a.definition_version))
    throw fail('DEFINITION_CHANGED','Lượt chính thức đang dùng đề đã ghim khác. Bản trên máy vẫn được giữ.',409);
   if(crossDevice && finishedSkill(current,b.section))
    return {a,officialProgress:officialProgress(current)};
   const index=order.indexOf(b.section),priorSkill=index?order[index-1]:null,prior=state[priorSkill];
   const validLocalPrior=(prior?.sealed||prior?.interrupted)&&prior.operationId===b.dependency;
   const validOfficialPrior=crossDevice&&finishedSkill(current,priorSkill);
   if(index&&!validLocalPrior&&!validOfficialPrior)
    throw fail('OFFLINE_DEPENDENCY','Kỹ năng trước chưa được xác nhận; bài đang chờ gửi.');""")
    source = replace_once(source, "   const receipt={...(writingBlank?",
        "   const acceptsSkill = !review && (b.kind==='seal'||interruption);\n"
        "   let official = crossDevice && acceptsSkill ? await load(client, SLUG, current.attempt_token, false, true) : a;\n"
        "   const receipt={...(crossDevice&&acceptsSkill?{officialAttemptToken:official.attempt_token}:{}),...(writingBlank?")
    source = replace_once(source, "    if(interruption)await client.query(`UPDATE assessment.term_test_attempt",
        "    if(crossDevice&&acceptsSkill)await writeTerm2OfficialDraft(client,a,official,b.section,p,b.revision);\n"
        "    if(interruption)await client.query(`UPDATE assessment.term_test_attempt")
    source = replace_once(source, "WHERE id=$1`,[a.attempt_token,b.occurredAt]);\n    else if(b.section==='listening')",
        "WHERE id=$1`,[official.attempt_token,b.occurredAt]);\n    else if(b.section==='listening')")
    source = replace_once(source, "    else await client.query(`UPDATE assessment.term_test_attempt SET writing_started_at",
        "    else if(!crossDevice)await client.query(`UPDATE assessment.term_test_attempt SET writing_started_at")
    start = source.index("    if(b.kind==='seal'){\n")
    end = source.index("    state[b.section]", start)
    seal = source[start:end].replace('a.attempt_token', 'official.attempt_token').replace('a.exam_session_token', 'official.exam_session_token')
    seal = seal.replace('parseStoredTest(a)', 'parseStoredTest(official)')
    seal = seal.replace('a=await load(', 'official=await load(').replace('resultFor(a)', 'resultFor(official)')
    seal = seal.replace('a.listening_submitted_at&&a.reading_submitted_at', 'official.listening_submitted_at&&official.reading_submitted_at')
    seal = seal.replace('buildErpGradePayload(a,', 'buildErpGradePayload(official,')
    source = source[:start] + seal + source[end:]
    source = replace_once(source, "if(previous)return {receipt:previous,a,replayed:true};",
        "if(previous)return {receipt:previous,a:previous.officialAttemptToken?"
        "await load(client,SLUG,previous.officialAttemptToken):a,replayed:true};")
    source = replace_once(source, "   return {receipt,a:await load(client,SLUG,a.attempt_token)};",
        "   return {receipt,a:await load(client,SLUG,official.attempt_token)};")
    source = replace_once(source, "  recovery.note('offline_operation_committed'",
        "  if(out.officialProgress) return res.json({ok:true,persisted:false,receipt:null,officialProgress:out.officialProgress});\n"
        "  recovery.note('offline_operation_committed'")
    source = replace_once(source, "SELECT DISTINCT o.attempt_id FROM assessment.term2_offline_operation o\n    JOIN assessment.term_test_attempt a ON a.id=o.attempt_id",
        "SELECT DISTINCT a.id AS attempt_id FROM assessment.term2_offline_operation o\n"
        "    JOIN assessment.term_test_attempt a ON a.id=coalesce((o.receipt->>'officialAttemptToken')::uuid,o.attempt_id)")
    return source


if __name__ == "__main__":
    source_path, target_path = map(Path, sys.argv[1:])
    if source_path.resolve() == target_path.resolve():
        raise ValueError("Stage this runtime in a separate file.")
    stage = stage_offline if source_path.name == "k56-offline-core.mjs" else stage_entry
    result = stage(source_path.read_text(encoding="utf-8"))
    target_path.write_text(result, encoding="utf-8", newline="\n")
