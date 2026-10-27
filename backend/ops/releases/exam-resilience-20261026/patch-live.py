"""Build an offline overlay from a freshly captured runtime; never deploys."""
from pathlib import Path
import argparse,shutil,hashlib,json

def replace_once(source,old,new):
    if source.count(old)!=1:raise ValueError('Runtime anchor missing, duplicated or already patched: '+old[:70])
    return source.replace(old,new)

def build(baseline,output,kind,app_role,assessment_schema):
    if output.exists():raise ValueError('Candidate output must be new')
    expected=json.loads((baseline/'source-hashes.json').read_text(encoding='utf-8'))
    for name,want in expected.items():
        if hashlib.sha256((baseline/name).read_bytes()).hexdigest()!=want:raise ValueError('Baseline changed: '+name)
    output.mkdir(parents=True)
    shutil.copytree(baseline/'src',output/'src');shutil.copy2(baseline/'package.json',output/'package.json')
    app=output/'src/app.js';source=app.read_text(encoding='utf-8')
    source=replace_once(source,"import { mountSubmissionStatus } from './submission-status.mjs';","import { mountSubmissionStatus } from './submission-status.mjs';\nimport { mountExamClock } from './exam-clock.mjs';")
    source=replace_once(source,'  const testWriteLimiter = rateLimit({','  mountExamClock(app,{pool,limiter:testReadLimiter});\n  const testWriteLimiter = rateLimit({')
    shutil.copy2(Path(__file__).parent/'exam-clock.mjs',output/'src/exam-clock.mjs')
    canonical=Path(__file__).resolve().parents[4]/'products/term-mini-k67/src'
    shutil.copy2(canonical/'teacher-audio-recovery.js',output/'src/teacher-audio-recovery.js')
    source="import {mountTeacherAudioRecovery} from './teacher-audio-recovery.js';\n"+source
    saved_module='teacher-saved-progress.js' if kind=='k67' else 'k56-teacher-saved-progress.js'
    source=replace_once(source,"import {mountTeacherSavedProgress} from './"+saved_module+"';","import {mountTeacherSavedProgress,readTeacherSavedProgress} from './"+saved_module+"';")
    old_mount='  mountTeacherSavedProgress(app,{pool,authenticate,'+('requireContext,limiter:testReadLimiter,auth' if kind=='k67' else 'limiter:testReadLimiter')+'});'
    new_mount=old_mount+"\n  mountTeacherAudioRecovery(app,{pool,authenticate,limiter:testReadLimiter,"+('requireContext,' if kind=='k67' else "profile:'k56',")+"\n    readScope:(db,input,req)=>readTeacherSavedProgress(db,input,"+('req.reviewer.email,auth.readAuthorization(req)' if kind=='k67' else 'req')+")});"
    source=replace_once(source,old_mount,new_mount)
    if kind=='k67':
        shutil.copy2(canonical/'audio-owner.js',output/'src/audio-owner.js')
        # These two live modules match the task's original canonical revision.
        # Refuse copying if a later runtime has changed either one.
        frozen=json.loads((Path(__file__).parent/'k67-source-baseline.json').read_text(encoding='utf-8'))
        for name,want in frozen.items():
            if hashlib.sha256((baseline/'src'/name).read_bytes()).hexdigest()!=want:raise ValueError('K67 module drift: '+name)
            shutil.copy2(canonical/name,output/'src'/name)
        source=replace_once(source,"import {audioOwnerPool,audioOwnerContext,mountAudioOwner} from './audio-owner.js';","import {audioOwnerPool,audioOwnerContext,mountAudioOwner,claimAudioOwnerAtStart} from './audio-owner.js';")
        source=replace_once(source,'const examSessionStartSchema = z.object({ examSessionToken: z.string().uuid(),','const examSessionStartSchema = z.object({ examSessionToken: z.string().uuid(),\n  ownerStartVersion:z.literal(2).optional(),')
        source=replace_once(source,'    const beginSession=async db=>{','    let startedOwner=null;\n    const beginSession=async db=>{')
        source=replace_once(source,'        const auth=await authorizeAudioSession(db,parsed.data,slug.data);\n        if(config.audioOwnerEnabled&&!auth.row.listening_started_at&&Number(auth.row.audio_owner_protocol)!==1)',
            '        const deferred=parsed.data.ownerStartVersion===2;\n        const auth=await authorizeAudioSession(db,parsed.data,slug.data,deferred);\n        if(deferred&&(config.audioOwnerEnabled||Number(auth.row.audio_owner_protocol)===1))startedOwner=await claimAudioOwnerAtStart(db,auth.row,req.body);\n        if(!deferred&&config.audioOwnerEnabled&&!auth.row.listening_started_at&&Number(auth.row.audio_owner_protocol)!==1)')
        source=replace_once(source,'      generation: Number(session.generation)||0,\n      listeningStartedAt: session.listening_started_at,','      generation: Number(session.generation)||0,\n      ...(startedOwner?{audioOwner:startedOwner}:{}),\n      listeningStartedAt: session.listening_started_at,')
        source=replace_once(source,'enabled:config.audioOwnerEnabled});',"enabled:config.audioOwnerEnabled,\n    onRecovery:({testSlug,sessionId,ownerEpoch})=>logTermTestEvent('audio_preparation_recovered',testSlug,sessionId,{ownerEpoch})});")
    else:
        recovery=output/'src/k56-listening-audio-recovery.js';text=recovery.read_text(encoding='utf-8')
        anchor='    let id = recoveryId || row.listening_audio_interruption_id || row.listening_audio_legacy_recovery_id || crypto.randomUUID();'
        text=replace_once(text,anchor,"    // A teacher-cleared owner may adopt the existing acknowledged stop without resetting its anchor.\n    if(state === 'resume' && audioOwnerId && !row.listening_audio_owner_id && row.listening_audio_interruption_id) recoveryId = row.listening_audio_interruption_id;\n"+anchor)
        anchor="    if (state !== 'resume' && row.listening_audio_owner_id && row.listening_audio_owner_id !== audioOwnerId) {"
        text=replace_once(text,anchor,"    if(state === 'resume' && row.listening_audio_owner_id && row.listening_audio_owner_id !== audioOwnerId) {\n      throw new AudioRecoveryError('AUDIO_OWNER_CONFLICT', 'Listening đang thuộc tab hoặc thiết bị khác. Quay lại nơi đang thi hoặc nhờ giáo viên hỗ trợ chuyển thiết bị.');\n    }\n"+anchor)
        recovery.write_text(text,encoding='utf-8',newline='\n')
    app.write_text(source,encoding='utf-8',newline='\n')
    changed=[]
    for p in (output/'src').rglob('*'):
        if not p.is_file():continue
        relative=p.relative_to(output).as_posix();before=baseline/relative
        if not before.exists() or p.read_bytes().replace(b'\r\n',b'\n')!=before.read_bytes().replace(b'\r\n',b'\n'):changed.append(relative)
    allow={'src/app.js','src/exam-clock.mjs','src/teacher-audio-recovery.js'}|({'src/audio-owner.js','src/audio-access.js','src/exam-order.js'} if kind=='k67' else {'src/k56-listening-audio-recovery.js'})
    if set(changed)!=allow:raise ValueError('Unexpected overlay changes: '+repr(changed))
    import re
    if not re.fullmatch(r'[a-z_][a-z0-9_]*',app_role):raise ValueError('Invalid app role')
    if assessment_schema not in ['assessment','assessment_k56']:raise ValueError('Invalid assessment schema')
    migration=(canonical.parent/'db/013-audio-owner-recovery.sql').read_text(encoding='utf-8').replace('TO k67_app;',f'TO {app_role};').replace('assessment.',assessment_schema+'.')
    (output/'audio-owner-recovery.sql').write_text(migration,encoding='utf-8')
    if kind=='k67':
        shutil.copy2(canonical.parent/'db/014-audio-preparation-without-owner.sql',output/'audio-preparation-without-owner.sql')
    receipt={'kind':kind,'assessmentSchema':assessment_schema,'appRole':app_role,'migrationSha256':hashlib.sha256(migration.encode()).hexdigest(),'changed':changed,'baseline':expected,'candidate':{p.relative_to(output).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in (output/'src').rglob('*') if p.is_file()}}
    (output/'overlay-receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    return {'kind':kind,'changed':changed,'output':str(output)}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--baseline',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--kind',choices=['k56','k67'],required=True);parser.add_argument('--app-role',required=True);parser.add_argument('--assessment-schema',choices=['assessment','assessment_k56'],required=True)
    args=parser.parse_args();print(json.dumps(build(args.baseline,args.output,args.kind,args.app_role,args.assessment_schema)))
