"""Giữ đúng danh tính/đích và journal của cầu nối UI, không đọc secret.
Mỗi bước nhận ledger đã pin, chỉ seed/read/start/draft/cleanup đúng UUID.
Lỗi gửi hoặc chưa rõ response giữ khóa và ca mở, không tự replay/cleanup.
"""
import hashlib,json,os,re,uuid
from pathlib import Path
from browser_receipt import ENTRIES,DESTINATIONS
from canary_remote import child_tables,uses_existing_demo_course

def check(value,code):
    if not value:raise ValueError(code)

def validate_ledger(ledger,manifest):
    check(ledger.get('schema')=='d08-ui-production-ledger/v1','ui_ledger_schema')
    check(re.fullmatch('[a-f0-9]{32}',ledger.get('run_id','')),'ui_run_invalid')
    check(re.fullmatch('[a-f0-9]{64}',ledger.get('bundle_revision','')),'ui_ledger_bundle_invalid')
    entries=ledger.get('entries',[])
    check(len(entries)==7 and {e.get('case_id') for e in entries}==set(ENTRIES),'ui_case_set')
    ids=set();numbers=set();markers=set()
    images={t['name']:t['candidate_image'] for t in manifest['targets']}
    for e in entries:
        client,target=ENTRIES[e['case_id']]
        check(e.get('client')==client,'ui_client_wrong')
        identity=e.get('identity',{});dest=e.get('destination',{})
        check(set(identity)=={'attempt_id','student_ref','marker','class_code','course_id','student_id'},'ui_identity_fields')
        for key in ('attempt_id','student_ref'):
            value=identity[key]
            try:valid=str(uuid.UUID(value))==value and uuid.UUID(value).version==4
            except (ValueError,TypeError,AttributeError):valid=False
            check(valid and value not in ids,'ui_uuid_invalid');ids.add(value)
        check(re.fullmatch('CODEX_D08_'+ledger['run_id']+r'_\d+',identity['marker']) and identity['marker'] not in markers,'ui_marker_invalid')
        markers.add(identity['marker'])
        check(identity['class_code']==('CODEXDEMO56' if target.endswith('demo-api-1') else 'IC2264' if target=='izone-k56-ic2264-api' else 'IC2146'),'ui_class_route_wrong')
        for key in ('course_id','student_id'):
            if key=='course_id' and uses_existing_demo_course({'name':target,**identity}):continue
            value=identity[key];check(type(value) is int and -2147483647<=value<=-1000000 and value not in numbers,'ui_negative_identity_invalid');numbers.add(value)
        api,database=DESTINATIONS[target]
        check(dest=={'container':target,'image':images[target],'public_api_base':api,'database':database},'ui_destination_wrong')
    return entries

def validate_payload(payload,identity):
    check(isinstance(payload,dict),'ui_payload_object')
    check(set(payload)<= {'attemptToken','action','task1','task2','outline','baseRevision','revision'},'ui_payload_extra')
    check(payload.get('attemptToken')==identity['attempt_id'],'ui_payload_wrong_uuid')
    check(payload.get('action') in ('start','draft'),'ui_payload_forbidden_action')
    for key in ('task1','task2'):
        check(isinstance(payload.get(key),str) and len(payload[key])<=100000,'ui_payload_task_invalid')
    if 'outline' in payload:
        check(isinstance(payload['outline'],str) and len(payload['outline'])<=100000,'ui_outline_invalid')
    if payload['action']=='draft':
        value=payload.get('baseRevision');check(type(value) is int and 0<=value<=9007199254740991,'ui_base_invalid')
    return payload

def validate_read(value,entry):
    identity=entry['identity']
    check(value.get('destination')==entry['destination'],'ui_read_wrong_destination')
    check(value.get('ownership_checked') is True,'ui_read_ownership_unknown')
    for key in ('attempt_id','marker','course_id','student_id'):check(value.get(key)==identity[key],'ui_read_identity_wrong')
    check(value.get('child_tables')==list(child_tables({'name':entry['destination']['container']})) and value.get('children')==[0]*len(child_tables({'name':entry['destination']['container']})),'ui_child_guard')
    writing=value.get('writing',{})
    check(writing.get('submitted') is False,'ui_attempt_submitted')
    check(type(writing.get('revision')) is int and writing['revision']>=0,'ui_read_revision_invalid')
    check(all(isinstance(writing.get(key),str) for key in ('task1','task2')),'ui_read_tasks_missing')
    return value

def validate_cleanup(value,entry):
    identity=entry['identity']
    check(value.get('status')=='passed' and value.get('destination')==entry['destination'],'ui_cleanup_unknown')
    check(value.get('attempt_id')==identity['attempt_id'] and value.get('marker')==identity['marker'],'ui_cleanup_identity_wrong')
    check(value.get('child_tables')==list(child_tables({'name':entry['destination']['container']})) and value.get('remaining')=={'attempt':0,'marker':0,'children':[0]*len(child_tables({'name':entry['destination']['container']}))},'ui_cleanup_not_zero')
    return value

def canonical_hash(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def sync_directory(folder):
    if os.name!='nt':
        descriptor=os.open(folder,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)

BINDING_FIELDS=('case_id','bundle_revision','ledger_canonical_sha256','ledger_sha256')

def request_binding(request):
    value = {key:request[key] for key in BINDING_FIELDS}
    # Production phải khóa thêm topology; fixture cũ không dùng database thật vẫn đọc được.
    if 'database_bindings_sha256' in request:
        value['database_bindings_sha256'] = request['database_bindings_sha256']
    return value

class Journal:
    """Khóa độc quyền không tự hết hạn; request tồn tại phải đối soát thủ công."""
    def __init__(self,folder):
        self.folder=Path(folder);self.folder.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.lock=self.folder/'executor.lock';self.state=self.folder/'state.json'
    def acquire(self,request):
        check(not (self.folder/'unknown.json').exists(),'ui_sender_unknown_blocks_all')
        with self.lock.open('x',encoding='utf-8') as stream:
            json.dump({'pid':os.getpid(),'request_sha256':canonical_hash(request)},stream);stream.flush();os.fsync(stream.fileno())
        sync_directory(self.folder)
        state=json.loads(self.state.read_text(encoding='utf-8')) if self.state.exists() else {'sequence':0,'phase':'unseeded'}
        check(request.get('sequence')==state['sequence']+1,'ui_sequence_conflict')
        # Khóa cùng danh tính/gói và cả bytes sổ từ request đầu; không đổi giữa lượt.
        if state['sequence']:
            check(state.get('binding')==request_binding(request),'ui_journal_binding_changed')
        self.save_new(str(request['sequence'])+'.request.json',request)
        return state
    def save_new(self,name,value):
        with (self.folder/name).open('x',encoding='utf-8') as stream:
            json.dump(value,stream,ensure_ascii=False,indent=2);stream.flush();os.fsync(stream.fileno())
        sync_directory(self.folder)
    def complete(self,request,phase,value):
        self.save_new(str(request['sequence'])+'.response.json',value)
        temporary=self.folder/'state.pending.json'
        with temporary.open('x',encoding='utf-8') as stream:
            json.dump({'sequence':request['sequence'],'phase':phase,'binding':request_binding(request)},stream);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,self.state);sync_directory(self.folder)
        self.lock.unlink();sync_directory(self.folder)
    def unknown(self,request,error):
        self.save_new('unknown.json',{'sequence':request['sequence'],'request_sha256':canonical_hash(request),'error':type(error).__name__})
        # Giữ lock: chỉ đối soát executor cũ đã dừng rồi recovery CAS riêng mới mở.

def execute(request,ledger,manifest,backend,journal):
    entries=validate_ledger(ledger,manifest)
    entry=next((e for e in entries if e['case_id']==request.get('case_id')),None)
    check(entry is not None,'ui_case_invalid')
    check(request.get('ledger_canonical_sha256')==canonical_hash(ledger),'ui_ledger_binding_wrong')
    check(request.get('bundle_revision')==ledger['bundle_revision'],'ui_bundle_binding_wrong')
    check(re.fullmatch('[a-f0-9]{64}',request.get('ledger_sha256','')),'ui_raw_ledger_binding_invalid')
    action=request.get('action')
    check(action in ('seed','read','post','cleanup'),'ui_action_invalid')
    if action=='post':validate_payload(request.get('payload'),entry['identity'])
    state=journal.acquire(request)
    try:
        backend.guard(entry)
        if action=='seed':
            check(state['phase']=='unseeded','ui_seed_replay_blocked')
            value=validate_read(backend.seed(entry),entry)
            check(value['writing']['revision']==0 and not value['writing']['started'] and value['writing']['task1']==value['writing']['task2']=='','ui_seed_not_empty')
            phase='seeded'
        else:
            check(state['phase']=='seeded','ui_not_seeded_or_already_cleaned')
            before=validate_read(backend.read(entry),entry)
            if action=='read':value=before;phase='seeded'
            elif action=='post':
                value=backend.post(entry,request['payload'])
                check(type(value.get('status')) is int and value['status']==200 and isinstance(value.get('body'),dict),'ui_http_response_unknown')
                check(value['body'].get('ok') is True and isinstance(value['body'].get('writing'),dict),'ui_http_body_unknown')
                # HTTP response phải giữ nguyên; SQL lần sau và harness kiểm semantic ACK riêng.
                phase='seeded'
            else:value=validate_cleanup(backend.cleanup(entry),entry);phase='cleaned'
        backend.guard(entry)
        journal.complete(request,phase,value)
        return value
    except Exception as error:
        journal.unknown(request,error)
        raise
