"""Build the Mini overlay against verified K56 runtime source. No in-place edits."""
from pathlib import Path
import argparse
import hashlib
import json

HERE = Path(__file__).resolve().parent
RELEASES = HERE.parent


def build(src, out):
    out.mkdir(parents=True, exist_ok=False)

    def change(name, replacements):
        text = (src / name).read_text(encoding='utf-8')
        for old, new in replacements:
            if text.count(old) != 1:
                raise ValueError(f'Expected one anchor in {name}: {old}')
            text = text.replace(old, new)
        (out / name).write_text(text, encoding='utf-8', newline='\n')

    change('k56-offline-core.mjs', [
        ("import {z} from 'zod';", "import {z} from 'zod';\nimport {isBlank} from './term1-blank.mjs';"),
        ("if(!['term1','term2'].includes(profile.tablePrefix)||profile.slug!=='term-test-'+profile.tablePrefix.slice(4)+'-k56')throw Error('Unknown offline profile');",
         "const slugByPrefix={term1:'term-test-1-k56',term2:'term-test-2-k56',mini_k56:'mini-test-k56'};\nif(!Object.hasOwn(slugByPrefix,profile.tablePrefix)||profile.slug!==slugByPrefix[profile.tablePrefix])throw Error('Unknown offline profile');\nconst mini=profile.tablePrefix==='mini_k56';"),
        ("const seconds=op.section==='reading'?", "if(mini&&a.attempt_mode==='answer_sheet'&&(p.deadlineAt!==null||(op.kind==='seal'&&p.reason!=='manual')))return 'PAPER_MANUAL_ONLY';\n const seconds=mini&&a.attempt_mode==='answer_sheet'?null:op.section==='reading'?"),
        ("a.attempt_mode!=='cbt'\n    ||!equal", "!(a.attempt_mode==='cbt'||(mini&&a.attempt_mode==='answer_sheet'))\n    ||(mini&&a.session_attempt_mode&&a.session_attempt_mode!==a.attempt_mode)\n    ||!equal"),
        ("audioTransport:z.literal('r2-direct-v1').optional()", "audioTransport:z.literal('r2-direct-v1').optional(),...(mini?{attemptMode:z.enum(['cbt','answer_sheet']).default('cbt'),identityConfirmed:z.literal(true).optional()}:{})"),
        ("const a=await prepare(SLUG,{...body,attemptMode:'cbt'},false);", "const attemptMode=mini?body.attemptMode:'cbt';\n  const paper=attemptMode==='answer_sheet';\n  const a=await prepare(SLUG,{...body,attemptMode},false);"),
        ("if(!allowNew())throw", "if(!allowNew(attemptMode,body.classCode))throw"),
        ("if(row.session_id!==body.examSessionToken", "if(mini&&(current.superseded_at||current.session_superseded_at||current.attempt_mode!==attemptMode||current.exam_mode!==body.mode||Number(current.generation)!==body.generation||Number(current.session_generation)!==body.generation))throw fail('OFFLINE_SCOPE_CONFLICT','Lượt thi chưa khớp.',403);\n   if(row.session_id!==body.examSessionToken"),
        ("res.json({...serialize(a),content,timing,...(audioDownload?{audioDownload}:{}),offline:", "res.json({...serialize(a),...(paper?{}:{content,timing}),...(audioDownload?{audioDownload}:{}),offline:"),
        ("audioKey:assets.getSessionAudioKey(SLUG,a.exam_session_token).toString('base64'),audioEnvelope:{magic:'IZTT1',ivBytes:12,tagBytes:16}});",
         "...(paper?{}:{audioKey:assets.getSessionAudioKey(SLUG,a.exam_session_token).toString('base64'),audioEnvelope:{magic:'IZTT1',ivBytes:12,tagBytes:16}})});"),
        ("const index=order.indexOf(b.section),prior=", "if(mini&&a.attempt_mode==='answer_sheet'&&b.section==='writing')throw fail('MODE_CONFLICT','Phiếu giấy chỉ nhận Listening và Reading.',403);\n   const index=order.indexOf(b.section),prior="),
        ("if(item.sealed)throw", "if(mini&&(a.superseded_at||a.session_superseded_at||a[b.section+'_submitted_at']||(!item.startedAt&&a[b.section+'_started_at'])))throw fail('OFFLINE_NATIVE_CONFLICT','Lượt này đã thay đổi trên máy chủ; bản trên máy vẫn được giữ.',409);\n   if(item.sealed)throw"),
        ("const receipt={version:1", "const writingBlank=mini&&b.section==='writing'&&b.kind==='seal'&&isBlank(p[profile.taskId]);\n   const receipt={...(writingBlank?{writingBlank:true}:{}),version:1"),
        ("operationId:b.kind==='seal'?b.operationId:null};", "operationId:b.kind==='seal'?b.operationId:null,...(writingBlank?{blank:true}:{})};"),
        ("&&out.receipt.status==='accepted')try", "&&out.receipt.status==='accepted'&&!out.receipt.writingBlank)try"),
    ])
    core = out / 'k56-offline-core.mjs'
    text = core.read_text(encoding='utf-8')
    needle = "AND a.superseded_at IS NULL\n    AND NOT EXISTS"
    assert text.count(needle) == 1
    core.write_text(text.replace(needle, "AND a.superseded_at IS NULL\n    ${mini?\"AND o.receipt->>'writingBlank' IS DISTINCT FROM 'true'\":''}\n    AND NOT EXISTS"), encoding='utf-8', newline='\n')
    change('k56-exam-order.js', [
        ("import {registerTerm1Offline} from './term1-offline.mjs';", "import {registerTerm1Offline} from './term1-offline.mjs';\nimport {hasMiniOfflineRun,registerMiniOffline} from './mini-offline.mjs';"),
        ("  registerTerm1Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});",
         "  registerTerm1Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});\n  registerMiniOffline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});\n  async function assertLegacyWrite(client,slug,attemptId){\n    if(await hasMiniOfflineRun(client,slug,attemptId))throw failure('MINI_OFFLINE_ALREADY_PREPARED','Lượt này đã được chuẩn bị offline. Hãy tiếp tục trên thiết bị đã mở bài.');\n  }"),
        ("    if (a.listening_submitted_at) throw failure('LISTENING_LOCKED','Listening đã được nộp.');\n    assertSection(a,'listening');",
         "    await assertLegacyWrite(pool,a.test_slug,a.attempt_token);\n    if (a.listening_submitted_at) throw failure('LISTENING_LOCKED','Listening đã được nộp.');\n    assertSection(a,'listening');"),
        ("        if(row.listening_submitted_at) throw", "        await assertLegacyWrite(client,row.test_slug,row.attempt_token);\n        if(row.listening_submitted_at) throw"),
        ("      if (row.reading_submitted_at) throw", "      await assertLegacyWrite(client,row.test_slug,row.attempt_token);\n      if (row.reading_submitted_at) throw"),
        ("      if (!a.reading_started_at || a.reading_submitted_at", "      await assertLegacyWrite(client,a.test_slug,a.attempt_token);\n      if (!a.reading_started_at || a.reading_submitted_at"),
        ("    if(current.attempt_mode!=='answer_sheet') return next();", "    await assertLegacyWrite(pool,current.test_slug,current.attempt_token);\n    if(current.attempt_mode!=='answer_sheet') return next();"),
        ("      if(!a.listening_started_at||a.listening_submitted_at) throw", "      await assertLegacyWrite(client,a.test_slug,a.attempt_token);\n      if(!a.listening_started_at||a.listening_submitted_at) throw"),
        ("      if (a[`${skill}_submitted_at`]) return", "      await assertLegacyWrite(client,a.test_slug,a.attempt_token);\n      if (a[`${skill}_submitted_at`]) return"),
        ("    if(result.rows[0]?.test_slug==='mini-test-k56'&&result.rows[0].attempt_mode==='answer_sheet')",
         "    await assertLegacyWrite(pool,result.rows[0]?.test_slug,token.data);\n    if(result.rows[0]?.test_slug==='mini-test-k56'&&result.rows[0].attempt_mode==='answer_sheet')"),
    ])
    change('term-test-writing-grading.js', [
        ("import {storeTerm1Blank,canonicalTerm1Submission} from './term1-blank.mjs';",
         "import {storeTerm1Blank,canonicalTerm1Submission} from './term1-blank.mjs';\nimport {canonicalMiniWriting} from './mini-offline.mjs';"),
        ("      const essays = {", "      const miniWriting=await canonicalMiniWriting(client,attemptResult.rows[0]);\n      if(miniWriting?.blank)return {status:'blank',ready:true,mode:'blank',taskStates:{task2:'blank'}};\n      if(miniWriting){task1='';task2=miniWriting.task2;}\n      const essays = {"),
    ])
    catalog = json.loads((src / 'r2-audio-catalog.json').read_text(encoding='utf-8'))
    assets = json.loads((RELEASES / 'audio-cloudflare-20261023/catalog.mjs').read_text(encoding='utf-8').split('export const ASSETS = ', 1)[1].strip().removesuffix(';'))
    mini = assets['mini-test-k56']
    native = json.loads((src / 'k56-public-audio-catalog.json').read_text(encoding='utf-8'))[mini['id']]
    assert native['envelopeVersion'] == 'MP3' and all(native[k] == mini[k] for k in ('url', 'byteLength', 'sha256'))
    catalog[mini['sha256']] = mini
    (out / 'r2-audio-catalog.json').write_text(json.dumps(catalog, indent=2) + '\n', encoding='utf-8', newline='\n')
    (out / 'mini-offline.mjs').write_text((HERE / 'mini-offline.mjs').read_text(encoding='utf-8'), encoding='utf-8', newline='\n')
    print(json.dumps({file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in out.iterdir()}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('src', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    build(args.src, args.out)
