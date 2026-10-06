"""Bật đúng ba workflow K67 đã ghim; giữ writer và workflow nguồn khác.

Nhận release đã đối soát, ghi intent trước POST và chỉ GET khi mất ACK.
Không sửa body/prompt hay chạy lại bài lịch sử; webhook/schedule dùng kho mới.
"""
from pathlib import Path
import importlib.util
import json
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-activation')
STATE=PRIVATE/'state.json'

def load(name,file,base='tools'):
    s=importlib.util.spec_from_file_location(name,ROOT/base/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def activate(u,h,p,m,s,f,client):
    route=json.loads((PRIVATE.parent/'legacy-routing/state.json').read_bytes())
    copy=json.loads(m.STATE.read_bytes())
    if route['stage']!='released' or copy['stage']!='restored_verified':raise RuntimeError('K67_ACTIVATION_RELEASE_NOT_VERIFIED')
    tables=load('snapshot','rehearse-migration.py').TABLES
    f.verify(s.query(u,client,f.inspect_query()),tables,copy['intent'])
    for identity in m.PARENTS:
        observed=p.ctl('default','workflow','get',identity,'--jq','{id,active}',label='activation-source-stop-readback')
        if observed['id']!=identity or observed['active']:raise RuntimeError('K67_ACTIVATION_SOURCE_STILL_ACTIVE')
    PRIVATE.mkdir(parents=True,exist_ok=True)
    state=json.loads(STATE.read_bytes()) if STATE.exists() else {'intent':uuid.uuid4().hex,'rows':{}}
    for profile,identity in [('izone-ai','NFgOTzvfzfjwqY9x'),('default','DHUgPXJdCfVZWj56'),('default','SGtuBV91Yc9oxEVt')]:
        payload={'lane':'target','profile':profile,'sourceId':identity,'active':True}
        saved=state['rows'].get(identity)
        if saved is None:
            before=m.sdk(p,{**payload,'operation':'snapshot'},'activation-backup')['workflow']
            if before['active']:raise RuntimeError('K67_TARGET_ALREADY_ACTIVE_WITHOUT_INTENT')
            path=PRIVATE/('before-'+identity+'.private.json')
            if path.exists():
                if json.loads(path.read_bytes())!=before:raise RuntimeError('K67_TARGET_ACTIVATION_BACKUP_CHANGED')
            else:
                with path.open('x',encoding='utf-8') as stream:json.dump(before,stream,ensure_ascii=False)
            saved={'before':str(path),'stage':'prepared'};state['rows'][identity]=saved;h.atomic(STATE,state)
        before=json.loads(Path(saved['before']).read_bytes())
        observed=m.sdk(p,{**payload,'operation':'inspect','before':before},'activation-inspect')['workflow']
        if not observed['active']:
            if saved['stage']!='prepared':raise RuntimeError('K67_ACTIVATION_OUTCOME_UNKNOWN')
            saved['stage']='activation_intent';h.atomic(STATE,state)
            try:m.sdk(p,{**payload,'operation':'set_active','before':before},'activation-mutation')
            except Exception:
                observed=m.sdk(p,{**payload,'operation':'inspect','before':before},'activation-reconcile')['workflow']
                if not observed['active']:raise RuntimeError('K67_ACTIVATION_OUTCOME_UNKNOWN')
        after=m.sdk(p,{**payload,'operation':'inspect','before':before},'activation-readback')['workflow']
        if not after['active']:raise RuntimeError('K67_TARGET_ACTIVATION_NOT_OBSERVED')
        saved['stage']='active_verified';saved['target_id']=after['id'];saved['after_version']=after['versionId'];h.atomic(STATE,state)
    state['stage']='active_verified';h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'active_workflows':3,'source_parents_stopped':2,'source_writer_retained':True,'learner_cutover':True}

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py');p=load('grading','provision-grading-bundle.py')
    m=load('migration','production-migration.py');s=load('guard','prepare-context-source.py');f=load('source_fence','source-fence.py','ops')
    lock=load('grading_lock','prepare-grading-fixture.py');PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:return s.run_guarded(u,h,client,lambda:activate(u,h,p,m,s,f,client),PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
