"""Stage Term 1 K56 fallback recovery on the verified local runtime candidate."""

from hashlib import sha256
from pathlib import Path
import argparse
import json
import shutil


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
   return {receipt,held:pending?.held,section:pending?.section};''', '''   if(receipt?.status==='accepted'||!isHoldRun(run))return {receipt};
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
    source = replace(source, '''   }catch(error){
    if(error.status)throw error;
    note('offline_hold_unconfirmed',SLUG,req.term1FallbackAttemptId??b.attemptToken,''', '''   }catch(error){
    if(!required&&['OFFLINE_HOLD_FULL','OFFLINE_HOLD_EXPIRED'].includes(error.code)){
     note('offline_hold_unconfirmed',SLUG,req.term1FallbackAttemptId??b.attemptToken,{...baseMeta,phase:'hold',reason:error.code});
     return;
    }
    if(error.status)throw error;
    note('offline_hold_unconfirmed',SLUG,req.term1FallbackAttemptId??b.attemptToken,''')
    source = replace(source, '   if(isHoldRun(run))await assertTerm1HoldIdentity(client,a.attempt_token,b,hash);',
                     '   const recoveryEnabled=isHoldRun(run);\n'
                     '   if(recoveryEnabled)await assertTerm1HoldIdentity(client,a.attempt_token,b,hash);')
    source = replace(source, '''   if(!interruption)validateContent(a,b);
   const receipt=''', '''   if(!interruption)validateContent(a,b);
   // An opted-in fallback seal under review gets no official receipt or grade.
   if(grant&&recoveryEnabled&&b.kind==='seal'&&review)throw fail(review,'Bản đã chốt cần đối soát trước khi nhận chính thức.');
   const receipt=''')
    source = replace(source, 'b.section,b.kind,JSON.stringify(b),JSON.stringify(receipt)]);',
                     'b.section,b.kind,JSON.stringify(review&&recoveryEnabled?{}:b),JSON.stringify(receipt)]);')
    source = replace(source, '   if(hold)await clearTerm1Hold(client,a.attempt_token,b);',
                     '   if(!review&&hold)await clearTerm1Hold(client,a.attempt_token,b);')
    return replace(source, '  res.json({ok:true,persisted:true,receipt:out.receipt});',
                   '  res.json({ok:true,persisted:true,receipt:out.receipt,'
                   '...(hold&&out.receipt.status===\'review_required\'?{held:hold.held}:{})});')


def journal_overlay(source, journal_source):
    runtime = source / 'src' / 'exam-journal-runtime'
    old_adapter = (runtime / 'adapters/term.mjs').read_text(encoding='utf-8')
    adapter = (journal_source / 'adapters/term.mjs').read_text(encoding='utf-8')

    def resolver(text):
        return text[text.index('export function termOwnerResolver('):text.index('export function mountTermJournal(')]

    old_adapter = replace(old_adapter, resolver(old_adapter), resolver(adapter))
    old_adapter = replace(old_adapter, '  const resolver = termOwnerResolver({query,schema});',
                          '  const allowSkillFallback = productId === \'term-mini-k56\';\n'
                          '  const resolver = termOwnerResolver({query,schema,allowSkillFallback});')
    mount = '  mountExpressJournal(app,{journal});'
    scoped_mount = adapter[adapter.index(mount):adapter.index('  let pending = 0')].rstrip()
    old_adapter = replace(old_adapter, mount, scoped_mount)

    old_product = (runtime / 'src/product.mjs').read_text(encoding='utf-8')
    product = (journal_source / 'src/product.mjs').read_text(encoding='utf-8')
    old_product = replace(old_product, "{ origin, ip = 'unknown', testSlug } = {}",
                          "{ origin, ip = 'unknown', testSlug, credential } = {}")
    old_product = replace(old_product, 'resolveOwner(proof, { testSlug })',
                          'resolveOwner(proof, { testSlug, credential })')
    anchor = 'export function mountExpressJournal('
    old_product = old_product[:old_product.index(anchor)] + product[product.index(anchor):]
    outputs = {'adapters/term.mjs': old_adapter.encode('utf-8'), 'src/product.mjs': old_product.encode('utf-8')}
    inventory = json.loads((runtime / 'SOURCE.json').read_text(encoding='utf-8'))
    for row in inventory['files']:
        if row['file'] in outputs:
            value = outputs[row['file']]
            row.update(sha256=sha256(value).hexdigest(), bytes=len(value))
    outputs['SOURCE.json'] = (json.dumps(inventory, indent=2) + '\n').encode('utf-8')
    return outputs


def main(source, destination, journal_source):
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
    journal_output = journal_overlay(source, journal_source)
    shutil.copytree(source, destination)
    for name, data in output.items():
        (destination / 'src' / name).write_text(data, encoding='utf-8', newline='\n')
    for name, data in journal_output.items():
        (destination / 'src' / 'exam-journal-runtime' / name).write_bytes(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--journal-source', required=True, type=Path)
    args = parser.parse_args()
    main(args.source.resolve(), args.destination.resolve(), args.journal_source.resolve())
