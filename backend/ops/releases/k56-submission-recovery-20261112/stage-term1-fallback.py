"""Stage Term 1 K56 fallback recovery on the verified local runtime candidate."""

from hashlib import sha256
from pathlib import Path
import shutil
import sys


def replace(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f'Unexpected fallback runtime anchor: {before}')
    return source.replace(before, after)


def hold_store(source):
    source = replace(source, 'SELECT section, payload_hash, held_at, expires_at, payload IS NOT NULL AS has_payload,',
                     "SELECT section, payload_hash, held_at, expires_at, payload IS NOT NULL AS has_payload,\n      payload->>'attemptToken' AS client_attempt_token,")
    return replace(source, '''async function read(db, attemptId, operation) {
    const row = await findHold(db, attemptId, operation);
    const held''', '''async function read(db, attemptId, operation, { clientAttemptToken } = {}) {
    const row = await findHold(db, attemptId, operation);
    if (clientAttemptToken && row?.client_attempt_token !== clientAttemptToken) return;
    const held''')


def fallback_routes(source):
    source = replace(source, "const SLUG = 'term-test-1-k56';", """import { term1HoldPolicy, term1HoldEnabled } from './term1-submission-hold.mjs';

const SLUG = 'term-test-1-k56';""")
    source = replace(source, '  const mutation = async (event, work) => {',
                     '  const holdPolicy = term1HoldPolicy();\n  const mutation = async (event, work) => {')
    source = replace(source, '''      if (!run) {
        run = (await client.query(`
          INSERT INTO assessment.term1_offline_run
            (attempt_id, session_id, generation, owner_id, policy, prepared_at, state, main_owner_pending)
          VALUES ($1, $2, $3, $4, $5, least(now(), coalesce($6::timestamptz, now())), $7::jsonb, true)
          RETURNING *
        `, [attempt.attempt_token, attempt.exam_session_token, attempt.generation, randomUUID(), policy,
          startedAt ?? null, JSON.stringify(state)])).rows[0];''', '''      if (!run) {
        // Pin retention on creation. An old run and its grant keep their existing behavior.
        const enroll = holdPolicy.admits(attempt.class_name_snapshot || input.classCode);
        run = (await client.query(`
          INSERT INTO assessment.term1_offline_run
            (attempt_id, session_id, generation, owner_id, policy, prepared_at, state, main_owner_pending
             ${enroll ? ',submission_hold_hours,submission_hold_limit' : ''})
          VALUES ($1, $2, $3, $4, $5, least(now(), coalesce($6::timestamptz, now())), $7::jsonb, true
            ${enroll ? ',$8,$9' : ''})
          RETURNING *
        `, [attempt.attempt_token, attempt.exam_session_token, attempt.generation, randomUUID(), policy,
          startedAt ?? null, JSON.stringify(state), ...(enroll ? [holdPolicy.hours, holdPolicy.limit] : [])])).rows[0];''')
    return replace(source, '        serverNow: attempt.server_now, preparedAt: run.prepared_at, startedAt, deadlineAt, draft, revision } };',
                   '''        serverNow: attempt.server_now, preparedAt: run.prepared_at, startedAt, deadlineAt, draft, revision,
        ...(term1HoldEnabled(run) ? { submissionRecoveryVersion: 1 } : {}) } };''')


def fallback_core(source):
    source = replace(source, "  note('offline_request_failed',SLUG,req.body?.attemptToken,{section:req.body?.section,operationId:req.body?.operationId,",
                     "  note('offline_request_failed',SLUG,req.term1FallbackAttemptId??req.body?.attemptToken,{section:req.body?.section,operationId:req.body?.operationId,")
    source = replace(source, ' async function admitted(client,body,token,grantToken){',
                     ' async function admitted(client,body,token,grantToken,req){')
    source = replace(source, '  if(isHoldRun(run))cleanHolds=true;',
                     '  if(grant&&req)req.term1FallbackAttemptId=a.attempt_token;\n  if(isHoldRun(run))cleanHolds=true;')
    status = "admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));"
    if source.count(status) != 2:
        raise ValueError('Expected grant authorization in status and commit')
    source = source.replace(status, status[:-2] + ',req);')
    source = replace(source, '''   if(receipt||grant||!isHoldRun(run))return {receipt};
   const pending=await readTerm1Hold(client,a.attempt_token,b);
   if(pending)await rejectMainSkillIfBound(client,a,pending.section);
   return {receipt,held:pending?.held,section:pending?.section};''', '''   if(receipt||!isHoldRun(run))return {receipt};
   const pending=await readTerm1Hold(client,a.attempt_token,b,{clientAttemptToken:b.attemptToken});
   if(grant&&pending?.section!==grant.section)return {receipt};
   if(!grant&&pending)await rejectMainSkillIfBound(client,a,pending.section);
   return {receipt,held:pending?.held,section:pending?.section,attemptId:a.attempt_token};''')
    source = replace(source, "  if(result.held)note('offline_submission_hold_read',SLUG,b.attemptToken,{",
                     "  if(result.held)note('offline_submission_hold_read',SLUG,result.attemptId,{")
    source = replace(source, "   if(profile.tablePrefix!=='term1'||b.kind!=='seal'||req.get('x-term1-skill-grant')!==undefined){",
                     "   if(profile.tablePrefix!=='term1'||b.kind!=='seal'){")
    source = replace(source, "     const {a,run}=await admitted(client,b,req.get('x-term2-permit'));",
                     "     const {a,run,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'),req);")
    source = replace(source, '''     if(await previousReceipt(client,a,b,hash,null))return;
     await rejectMainSkillIfBound(client,a,b.section);''', '''     if(await previousReceipt(client,a,b,hash,grant))return;
     if(!grant)await rejectMainSkillIfBound(client,a,b.section);
     if(grant&&b.dependency!==null)throw fail('TERM1_SKILL_DEPENDENCY','Link dự phòng không nhận quyền của kỹ năng khác.',403);''')
    for event in ['offline_hold_unconfirmed', 'offline_submission_held', 'offline_submission_unconfirmed', 'offline_writing_start_failed']:
        source = replace(source, f"note('{event}',SLUG,b.attemptToken,",
                         f"note('{event}',SLUG,req.term1FallbackAttemptId??b.attemptToken,")
    return replace(source, '''   if(!interruption)validateContent(a,b);
   const receipt=''', '''   if(!interruption)validateContent(a,b);
   // A retained fallback seal under review stays in the expiring store. It has no official receipt or grade.
   if(grant&&hold&&review)throw fail(review,'Bản đã chốt cần đối soát trước khi nhận chính thức.');
   const receipt=''')


def main(source, destination):
    patches = {
        'term1-skill-offline-core.mjs': ('b1fa0ec4c396da6f2c8947c70b258fa998ad12bb80e7294d470b2ad7a78c3a9e', fallback_core),
        'term1-skill-routes.mjs': ('2b708398b07ddad0ffbf22e2b59acab745dadd94a1d2ff1e87a95a9fa265ffd5', fallback_routes),
        'term1-submission-hold.mjs': ('5b087350ce147a3f87493d571348f2db731bf102f494043b5d243d9ab47fe04b', hold_store),
    }
    output = {}
    for name, (expected, patch) in patches.items():
        original = (source / 'src' / name).read_bytes()
        if sha256(original).hexdigest() != expected:
            raise ValueError(f'Unexpected candidate fingerprint: {name}')
        output[name] = patch(original.decode('utf-8'))
    shutil.copytree(source, destination)
    for name, data in output.items():
        (destination / 'src' / name).write_text(data, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main(*(Path(value).resolve() for value in sys.argv[1:]))
