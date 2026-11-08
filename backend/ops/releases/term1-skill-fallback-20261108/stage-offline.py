"""Stage the Term 1-only skill admission overlay against a verified source image."""
import argparse
import hashlib
from pathlib import Path
import shutil

CORE_SHA = '9dc5ceef6f06f222326bd22c0b30c17651f135eb9891a388ee747acb497a3006'
WRAPPER_SHA = 'ea46a95bb4e82a09d13f9bdc62221aae930174059530aad4dfde125e231453bc'


def pinned(path, expected):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Unverified base source: ' + str(path))
    return raw.decode()


def edit(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Term 1 overlay anchor is not unique: ' + old)
    return source.replace(old, new)


def build(runtime):
    target = runtime.resolve(strict=True) / 'src'
    core = pinned(target / 'k56-offline-core.mjs', CORE_SHA)
    wrapper = pinned(target / 'term1-offline.mjs', WRAPPER_SHA)
    core = "import {readBoundSkillGrant, rejectMainSkillIfBound, resolveBoundSkillTarget, skillGrantSchema} from './term1-skill-grant.mjs';\n" + core
    core = edit(core, "const schema=tables(", "const schema=skillGrantSchema+tables(")
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
  if(!grant&&(run.owner_id!==body.ownerId||!equal(token,permitFor(secret,run))))
    throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi hoặc quyền đã thay đổi. Giữ bài và liên hệ giảng viên.',403);
  return {a,run,grant};""")
    core = edit(core, """await admitted(client,b,req.get('x-term2-permit'));
   return (await client.query(tables('SELECT receipt FROM assessment.term2_offline_operation WHERE operation_id=$1 AND attempt_id=$2'),[b.operationId,b.attemptToken]))""",
                """const {a,grant}=await admitted(client,b,req.get('x-term2-permit'),req.get('x-term1-skill-grant'));
   return (await client.query(tables('SELECT receipt FROM assessment.term2_offline_operation WHERE operation_id=$1 AND attempt_id=$2 AND ($3::text IS NULL OR section=$3)'),[b.operationId,a.attempt_token,grant?.section??null]))""")
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
    wrapper = edit(wrapper, "'./k56-offline-core.mjs'", "'./term1-skill-offline-core.mjs'")
    for name in ('term1-skill-grant.mjs', 'term1-skill-offline-core.mjs'):
        if (target / name).exists():
            raise ValueError('Overlay target already exists: ' + name)
    shutil.copyfile(Path(__file__).with_name('term1-skill-grant.mjs'), target / 'term1-skill-grant.mjs')
    (target / 'term1-skill-offline-core.mjs').write_text(core, encoding='utf-8', newline='\n')
    (target / 'term1-offline.mjs').write_text(wrapper, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('candidate', type=Path, help='Dedicated copy of the verified K56 source')
    build(parser.parse_args().candidate)
