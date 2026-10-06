"""Credential và phép kiểm n8n cho kho tiến độ K67 mới, chưa nhận bài thật.

Ghi ý định trước API, không tạo lại khi mất phản hồi. Workflow thủ công chỉ
ghi/đọc/xóa khóa giả có hạn; không gọi AI, Portal hoặc dùng credential chung.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import re
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-n8n')
STATE=PRIVATE/'state.json'
NAME='K67 · Kiểm kết nối kho tiến độ thật'
CREDENTIAL_NAME='K67 · Kho tiến độ chấm riêng'


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def candidate(state,credential,error):
    # Một item từ manual trigger đi qua đúng một chuỗi; mã kiểm soát chỉ nhận
    # nội dung giả. Lỗi đọc không có dữ liệu đúng sẽ làm execution báo thất bại.
    key='termmini:k67:synthetic:production-connection:'+state['intent']
    nodes=[]
    for index,(name,kind,version,parameters) in enumerate([
        ('Bắt đầu kiểm','manualTrigger',1,{}),
        ('Lưu tiến độ giả','redis',1,{'operation':'set','key':key,'value':'synthetic-progress','keyType':'string','expire':True,'ttl':60}),
        ('Đọc lại tiến độ','redis',1,{'operation':'get','propertyName':'checkpoint','key':key,'options':{}}),
        ('Kiểm nội dung đã lưu','code',2,{'jsCode':"// Nhận một kết quả đọc; chỉ chấp nhận đúng tiến độ giả, sai báo lỗi.\nconst items = $input.all();\nif (items.length !== 1 || items[0].json.checkpoint !== 'synthetic-progress') {\n  throw new Error('K67_PRODUCTION_REDIS_READBACK_MISMATCH');\n}\nreturn [{ json: { product_id: 'PRODUCT-TERM-MINI-K67', verified: true } }];"}),
        ('Xóa khóa thử','redis',1,{'operation':'delete','key':key})]):
        node={'id':str(uuid.uuid5(uuid.UUID(state['intent']),name)),'name':name,'type':'n8n-nodes-base.'+kind,
            'typeVersion':version,'position':[index*220,0],'parameters':parameters}
        if kind=='redis':node['credentials']={'redis':credential}
        nodes.append(node)
    return {'name':NAME,'active':False,'nodes':nodes,
        'connections':{nodes[i]['name']:{'main':[[{'node':nodes[i+1]['name'],'type':'main','index':0}]]} for i in range(len(nodes)-1)},
        'settings':{'errorWorkflow':error,'saveDataErrorExecution':'all','saveDataSuccessExecution':'all','saveManualExecutions':True}}


def journal(p,pending):return p.PRIVATE/(pending['label']+'-'+pending['attempt']+'.stdout.log')


def recovered(p,pending):
    path=journal(p,pending)
    if not path.exists():raise RuntimeError('K67_N8N_PENDING_OUTCOME_UNKNOWN')
    try:return json.loads(path.read_bytes())
    except (ValueError,UnicodeError):raise RuntimeError('K67_N8N_PENDING_OUTCOME_UNKNOWN') from None


def intent(h,state,kind,label):
    if state.get('pending'):raise RuntimeError('K67_N8N_PENDING_RECONCILE_REQUIRED')
    state['pending']={'kind':kind,'label':label,'attempt':uuid.uuid4().hex};h.atomic(STATE,state)
    return state['pending']


def prepare(u,h,guard,q,p,client):
    PRIVATE.mkdir(parents=True,exist_ok=True);queue=json.loads(q.STATE.read_text(encoding='utf-8'))
    if queue['stage']!='production_queue_verified':raise RuntimeError('K67_N8N_QUEUE_NOT_VERIFIED')
    q.verify(u,client,queue);p.resolve('default')
    state=json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {'intent':uuid.uuid4().hex}
    if not re.fullmatch('[0-9a-f]{32}',state['intent']):raise RuntimeError('K67_N8N_STATE_CHANGED')
    h.atomic(STATE,state)
    if 'redis_credential' not in state:
        if state.get('pending'):
            if state['pending']['kind']!='credential':raise RuntimeError('K67_N8N_PENDING_RECONCILE_REQUIRED')
            result=recovered(p,state['pending'])
        else:
            request={'name':CREDENTIAL_NAME,'type':'redis','data':{'host':q.APP,'port':6379,'database':0,
                'user':'k67_grading','password':q.keys()['password'],'ssl':False}}
            pending=intent(h,state,'credential','k67-production-redis-credential')
            result=p.ctl('default','credential','create','-',label=pending['label'],journal_id=pending['attempt'],input_bytes=json.dumps(request).encode())
        if result.get('name')!=CREDENTIAL_NAME or result.get('type')!='redis' or not re.fullmatch('[A-Za-z0-9_-]{8,128}',result.get('id','')):
            raise RuntimeError('K67_N8N_CREDENTIAL_READBACK_MISMATCH')
        state['redis_credential']={key:result[key] for key in ['id','name']};state.pop('pending',None);h.atomic(STATE,state)
    original=json.loads((p.PRIVATE.parent/'n8n-redis-fixture/state.json').read_text(encoding='utf-8'))
    definition=candidate(state,state['redis_credential'],original['error_workflow'])
    path=PRIVATE/'probe.candidate.private.json';raw=json.dumps(definition,ensure_ascii=False,indent=2).encode()
    if path.exists():
        if json.loads(path.read_bytes())!=definition:raise RuntimeError('K67_N8N_PROBE_CANDIDATE_CHANGED')
    else:
        with path.open('xb') as stream:stream.write(raw)
    p.validate(path)
    if 'probe_workflow' not in state:
        if state.get('pending'):
            if state['pending']['kind']!='workflow':raise RuntimeError('K67_N8N_PENDING_RECONCILE_REQUIRED')
            result=recovered(p,state['pending'])
        else:
            pending=intent(h,state,'workflow','k67-production-redis-probe')
            result=p.ctl('default','workflow','deploy',str(path),'--create-only','--no-normalize',label=pending['label'],journal_id=pending['attempt'])
        if not result.get('created') or result.get('activated') or not re.fullmatch('[A-Za-z0-9_-]{8,128}',result.get('workflowId','')):
            raise RuntimeError('K67_N8N_PROBE_CREATION_UNKNOWN')
        state['probe_workflow']=result['workflowId'];state.pop('pending',None);h.atomic(STATE,state)
    p.resolve('default',state['probe_workflow'],NAME);p.register('default',state['probe_workflow'],NAME)
    observed=p.ctl('default','workflow','get',state['probe_workflow'],label='k67-production-probe-readback')
    # n8n thêm hai mặc định an toàn khi tạo. Kiểm đúng hai giá trị này, không
    # bỏ qua settings hoặc sửa artifact trước tạo để khớp với kết quả live.
    expected=p.workflow_body(definition)
    expected['settings']={**expected['settings'],'callerPolicy':'workflowsFromSameOwner','availableInMCP':False}
    if observed.get('id')!=state['probe_workflow'] or observed.get('active') or p.workflow_body(observed)!=expected:
        raise RuntimeError('K67_N8N_PROBE_DEFINITION_MISMATCH')
    capture=PRIVATE/('probe-live-'+observed['versionId']+'.private.json')
    if capture.exists():
        if json.loads(capture.read_bytes())!=observed:raise RuntimeError('K67_N8N_PROBE_SNAPSHOT_CHANGED')
    else:
        with capture.open('x',encoding='utf-8') as stream:json.dump(observed,stream,ensure_ascii=False,indent=2)
    state['stage']='prepared_inactive';h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'workflow':state['probe_workflow'],'active':False,'learner_cutover':False}


def verify(u,h,q,p,client):
    state=json.loads(STATE.read_text(encoding='utf-8'));identity=state['probe_workflow']
    p.resolve('default',identity,NAME)
    q.verify(u,client,json.loads(q.STATE.read_text(encoding='utf-8')))
    live=p.ctl('default','workflow','get',identity,label='k67-production-probe-before-run')
    expected=p.workflow_body(json.loads((PRIVATE/'probe.candidate.private.json').read_bytes()))
    expected['settings']={**expected['settings'],'callerPolicy':'workflowsFromSameOwner','availableInMCP':False}
    if live.get('active') or p.workflow_body(live)!=expected:raise RuntimeError('K67_N8N_PROBE_CHANGED_BEFORE_RUN')
    key='termmini:k67:synthetic:production-connection:'+state['intent']
    if state.get('pending'):
        if state['pending']['kind']!='execution':raise RuntimeError('K67_N8N_PENDING_RECONCILE_REQUIRED')
        result=recovered(p,state['pending'])
    else:
        if q.cli(u,client,'GET '+key)!='':raise RuntimeError('K67_N8N_PROBE_KEY_NOT_EMPTY')
        pending=intent(h,state,'execution','k67-production-redis-run')
        result=p.ctl('default','workflow','run',identity,'--trigger','Bắt đầu kiểm','--wait','--timeout','60000',
            label=pending['label'],journal_id=pending['attempt'])
    if result.get('status')!='success' or result.get('workflowId')!=identity or not result.get('executionId'):
        raise RuntimeError('K67_N8N_NATIVE_EXECUTION_FAILED')
    observed=p.ctl('default','execution','get',str(result['executionId']),'--logs',label='k67-production-redis-execution')
    if observed.get('status')!='success' or observed.get('workflowId')!=identity:raise RuntimeError('K67_N8N_EXECUTION_READBACK_MISMATCH')
    runs=observed['data']['resultData']['runData']
    for name in ['Bắt đầu kiểm','Lưu tiến độ giả','Đọc lại tiến độ','Kiểm nội dung đã lưu','Xóa khóa thử']:
        if len(runs.get(name,[]))!=1 or runs[name][0].get('error'):raise RuntimeError('K67_N8N_NODE_READBACK_MISSING')
    if runs['Kiểm nội dung đã lưu'][0]['data']['main'][0][0]['json']!={'product_id':'PRODUCT-TERM-MINI-K67','verified':True} \
        or q.cli(u,client,'GET '+key)!='':raise RuntimeError('K67_N8N_BUSINESS_READBACK_MISMATCH')
    path=PRIVATE/('execution-'+str(result['executionId'])+'.private.json')
    if path.exists():
        if json.loads(path.read_bytes())!=observed:raise RuntimeError('K67_N8N_EXECUTION_SNAPSHOT_CHANGED')
    else:
        with path.open('x',encoding='utf-8') as stream:json.dump(observed,stream,ensure_ascii=False,indent=2)
    state['execution_id']=str(result['executionId']);state['stage']='connection_verified';state.pop('pending',None);h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'workflow':identity,'execution_id':str(result['executionId']),
        'redis_key_absent':True,'learner_cutover':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);modes=parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--prepare',action='store_true');modes.add_argument('--verify',action='store_true');args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    guard=load('context_guard','prepare-context-source.py');q=load('production_queue','prepare-production-queue.py')
    p=load('grading_provision','provision-grading-bundle.py');client=u.connect()
    try:
        operation=lambda:prepare(u,h,guard,q,p,client) if args.prepare else verify(u,h,q,p,client)
        return guard.run_guarded(u,h,client,operation,PRIVATE,caller_path=Path(__file__))
    finally:client.close()


if __name__=='__main__':sys.exit(main())
