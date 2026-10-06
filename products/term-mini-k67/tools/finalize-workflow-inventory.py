"""Giữ workflow K67 đã chuyển và hai phép kiểm thủ công; không xóa/archieve.

Đổi đúng nhãn tạm của workflow task sở hữu sau backup/readback. Giữ nguyên
graph, prompt, credential, trạng thái bật; cập nhật sổ vòng đời riêng tư.
"""
from pathlib import Path
from datetime import datetime,timezone
import importlib.util
import json
import sys

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/workflow-retention')
STATE=PRIVATE/'state.json'
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def same(p,a,b):return p.workflow_body(a)==p.workflow_body(b) and a['active']==b['active'] and a['id']==b['id']
def perform(p,h):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    provision=json.loads(p.STATE.read_bytes());fixture=json.loads((PRIVATE.parent/'n8n-redis-fixture/state.json').read_bytes())
    prod=json.loads((PRIVATE.parent/'production-n8n/state.json').read_bytes())
    owned={r['id']:r['profile'] for r in provision['created'].values()}
    owned.update({fixture['error_workflow']:'default',fixture['probe_workflow']:'default',prod['probe_workflow']:'default'})
    probes={fixture['probe_workflow'],prod['probe_workflow']}
    ledger=json.loads(p.LIFECYCLE.read_bytes())
    if ledger['taskId']!='k67-grading-separation-20261006' or {r['id'] for r in ledger['workflows']}!=set(owned) or len(owned)!=53:
        raise RuntimeError('K67_RETENTION_INVENTORY_CHANGED')
    state=json.loads(STATE.read_bytes()) if STATE.exists() else {'rows':{}}
    for identity,profile in owned.items():
        observed=p.ctl(profile,'workflow','get',identity,label='retention-before')
        path=PRIVATE/('before-'+identity+'.private.json')
        if path.exists():
            before=json.loads(path.read_bytes())
            if not same(p,before,observed):raise RuntimeError('K67_RETENTION_WORKFLOW_CHANGED')
        else:
            before=observed
            with path.open('x',encoding='utf-8') as out:json.dump(before,out,ensure_ascii=False)
        label='K67 kiểm tra thủ công' if identity in probes else 'K67 đang sử dụng'
        tags=sorted({r['name'] for r in before.get('tags',[]) if r['name']!='Tạm thời'}|{label})
        current=sorted(r['name'] for r in observed.get('tags',[]))
        saved=state['rows'].setdefault(identity,{'stage':'planned','tags':tags})
        if saved['tags']!=tags:raise RuntimeError('K67_RETENTION_TAG_INTENT_CHANGED')
        if current!=tags:
            if saved['stage']!='planned':raise RuntimeError('K67_RETENTION_TAG_OUTCOME_UNKNOWN')
            saved['stage']='tag_intent';h.atomic(STATE,state)
            try:p.ctl(profile,'workflow','tag',identity,*tags,'--replace','--create',label='retention-tag')
            except Exception:
                reconciled=p.ctl(profile,'workflow','get',identity,label='retention-reconcile')
                if not same(p,before,reconciled) or sorted(r['name'] for r in reconciled.get('tags',[]))!=tags:raise
        after=p.ctl(profile,'workflow','get',identity,label='retention-after')
        if not same(p,before,after) or sorted(r['name'] for r in after.get('tags',[]))!=tags:
            raise RuntimeError('K67_RETENTION_READBACK_CHANGED')
        saved['stage']='retained_verified';h.atomic(STATE,state)
        if len([r for r in state['rows'].values() if r['stage']=='retained_verified'])%10==0:
            print(json.dumps({'outcome':'progress','retained':len(state['rows'])}),flush=True)
    timestamp=datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    if not (PRIVATE/'lifecycle-before.json').exists():
        with (PRIVATE/'lifecycle-before.json').open('x',encoding='utf-8') as out:json.dump(ledger,out,ensure_ascii=False,indent=2)
    for row in ledger['workflows']:
        row.update(kind='keep',status='keep',expiresAt=None,decisionAt=timestamp,
          note='Giữ inactive để kiểm thủ công; không chạy tự động.' if row['id'] in probes else 'K67 đang sử dụng sau chuyển, gồm child gọi nội bộ và workflow nhận lỗi; giữ nguyên active state.')
    ledger['updatedAt']=timestamp;h.atomic(p.LIFECYCLE,ledger)
    state['stage']='retained_verified';h.atomic(STATE,state)
    return {'outcome':'success','learner_cutover':True,'kept_production':51,'kept_inactive_probes':2,'deleted':0,'business_graphs_unchanged':True}
def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    p=load('grading','provision-grading-bundle.py');h=load('http','prepare-http-fixture.py');s=load('guard','prepare-context-source.py');u=load('util','prepare-redis-fixture.py')
    lock=load('lock','prepare-grading-fixture.py');PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:return s.run_guarded(u,h,client,lambda:perform(p,h),PRIVATE,caller_path=Path(__file__))
        finally:client.close()
if __name__=='__main__':sys.exit(main())
