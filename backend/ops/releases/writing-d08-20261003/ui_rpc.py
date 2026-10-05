"""CLI cầu nối UI: request+token sở hữu nằm ở kho C trước gửi.
Không tự resume/retry. Local/VPS cùng sequence; mất response khóa cả lượt.
"""
import argparse,hashlib,importlib.util,json,shlex,sys
from pathlib import Path
import release_adapter as adapter
from ui_rpc_guard import Journal,validate_ledger,validate_payload,validate_read,validate_cleanup,canonical_hash,check
HERE=Path(__file__).resolve().parent
FILES=('release_remote.py','canary_remote.py','browser_receipt.py','ui_rpc_guard.py','ui_rpc_remote.py','database_binding.py')

def capture_database_bindings(config):
    # Đọc API/DB/alias/network ID rồi ghi một snapshot bất biến trước seed đầu tiên.
    from canary_producer import save_new
    folder=Path(config['evidence_dir'])
    names=('release_remote.py','canary_remote.py','database_binding.py')
    packet={'files':{name:(HERE/name).read_text(encoding='utf-8') for name in names}}
    save_new(folder/'production-ui-database-binding.request.json',packet)
    bootstrap="""import json,sys,tempfile
from pathlib import Path
packet=json.load(sys.stdin)
if set(packet['files'])!={'release_remote.py','canary_remote.py','database_binding.py'}:raise RuntimeError('binding_sources_wrong')
with tempfile.TemporaryDirectory(prefix='codex-d08-db-binding-') as folder:
 for name,source in packet['files'].items():(Path(folder)/name).write_text(source,encoding='utf-8')
 sys.path.insert(0,folder)
 import canary_remote as c
 import database_binding as b
 print(json.dumps({name:b.resolve({'name':name},c.destination) for name in c.NAMES}))
"""
    spec=importlib.util.spec_from_file_location('ssh_credentials',HERE/'ssh_credentials.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    client,password=helper.connect('vps_1');password=''
    try:
        stdin,out,err=client.exec_command('python3 -c '+shlex.quote(bootstrap),timeout=90)
        stdin.write(json.dumps(packet));stdin.channel.shutdown_write()
        raw=out.read().decode('utf-8');err.read();code=out.channel.recv_exit_status()
        check(code==0 and raw,'ui_database_binding_capture_unknown')
        value=json.loads(raw)
        check(set(value)=={'mapping-review-api','izone-k56-ic2264-api','izone-k56-demo-k56-demo-api-1'},'ui_database_binding_capture_targets')
        save_new(folder/'production-ui-database-bindings.json',value)
        return value
    finally:client.close()

def call(config,case_id,action,payload=None):
    folder=Path(config['evidence_dir']).resolve()
    check(folder.drive.lower()=='c:','ui_evidence_must_be_c')
    ledger_path=folder/'production-ui-ledger.json'
    # Đọc bytes rồi decode giữ CRLF của sổ Windows; hash phải khớp file thật.
    ledger_source=ledger_path.read_bytes().decode('utf-8')
    ledger=json.loads(ledger_source)
    manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
    entries=validate_ledger(ledger,manifest)
    entry=next((e for e in entries if e['case_id']==case_id),None);check(entry is not None,'ui_case_wrong')
    adapter.checkpoint_inputs(config,manifest)
    check(config['bundle_revision']==ledger['bundle_revision'] and config.get('product_revision')=='d08-bundle:'+ledger['bundle_revision'],'ui_bundle_config_wrong')
    check(action in ('seed','read','post','cleanup'),'ui_action_wrong')
    if action=='post':validate_payload(payload,entry['identity'])
    bindings=json.loads((folder/'production-ui-database-bindings.json').read_text(encoding='utf-8'))
    journal=Journal(folder/'ui-rpc'/case_id)
    state=json.loads(journal.state.read_text(encoding='utf-8')) if journal.state.exists() else {'sequence':0,'phase':'unseeded'}
    request={'case_id':case_id,'action':action,'sequence':state['sequence']+1,'ledger_canonical_sha256':canonical_hash(ledger),'ledger_sha256':hashlib.sha256(ledger_source.encode('utf-8')).hexdigest(),'bundle_revision':ledger['bundle_revision']}
    request['database_bindings_sha256']=canonical_hash(bindings)
    if action=='post':request['payload']=payload
    journal.acquire(request)
    try:
        expected=json.loads((folder/'production-ui-snapshot.json').read_text(encoding='utf-8'))
        packet={'scope':'production_fixture','acceptance_binding':config.get('acceptance_binding'),'request':request,'ledger':ledger,'ledger_source':ledger_source,'manifest':manifest,'expected':expected,'database_bindings':bindings,
                'files':{name:(HERE/name).read_text(encoding='utf-8') for name in FILES}}
        journal.save_new(str(request['sequence'])+'.packet.json',packet)
        # Sender/frame cũ không tự bị lấy lại theo tuổi; replay cần đối soát riêng.
        bootstrap="""import json,sys,tempfile
from pathlib import Path
packet=json.load(sys.stdin)
allowed={'release_remote.py','canary_remote.py','browser_receipt.py','ui_rpc_guard.py','ui_rpc_remote.py','database_binding.py'}
if set(packet['files'])!=allowed:raise RuntimeError('ui_source_set')
with tempfile.TemporaryDirectory(prefix='codex-d08-ui-') as folder:
 for name,source in packet.pop('files').items():(Path(folder)/name).write_text(source,encoding='utf-8')
 sys.path.insert(0,folder)
 from ui_rpc_remote import perform
 print(json.dumps(perform(packet),ensure_ascii=False))
"""
        spec=importlib.util.spec_from_file_location('ssh_credentials',HERE/'ssh_credentials.py')
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        client,password=helper.connect('vps_1');password=''
        try:
            stdin,stdout,stderr=client.exec_command('python3 -c '+shlex.quote(bootstrap),timeout=90)
            stdin.write(json.dumps(packet,ensure_ascii=False));stdin.channel.shutdown_write()
            out=stdout.read().decode('utf-8');err=stderr.read();code=stdout.channel.recv_exit_status()
            check(code==0 and out,'ui_remote_response_unknown')
            value=json.loads(out)
        finally:client.close()
        if action in ('seed','read'):validate_read(value,entry)
        if action=='cleanup':validate_cleanup(value,entry)
        if action=='post':check(value.get('status')==200 and isinstance(value.get('body'),dict),'ui_post_unknown')
        journal.complete(request,'cleaned' if action=='cleanup' else 'seeded',value)
        return value
    except Exception as error:
        journal.unknown(request,error);raise

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True)
    parser.add_argument('--case',required=True);parser.add_argument('action',choices=['seed','read','post','cleanup'])
    args=parser.parse_args()
    try:
        payload=json.load(sys.stdin) if args.action=='post' else None
        value=call(json.loads(Path(args.config).read_text(encoding='utf-8')),args.case,args.action,payload)
        print(json.dumps(value,ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status':'unknown','error':type(error).__name__},ensure_ascii=False));sys.exit(1)
