"""Chuẩn bị bảy UUID riêng rồi chạy từng client sau phát hành đã qua cổng.
prepare chỉ ghi kho C; run kiểm public assets/image/source trước seed đầu tiên.
Một lỗi dừng lượt, giữ request/journal và fixture chưa rõ; không tự replay.
"""
import argparse,hashlib,json,os,re,secrets,subprocess,sys,uuid
from pathlib import Path
import release_adapter as adapter
from browser_receipt import ENTRIES,DESTINATIONS,expected_assets
from canary_producer import save_new
from canary_remote import DEMO_COURSE_ID,NAMES
from ui_rpc_guard import validate_ledger,check
from ui_rpc import call,capture_database_bindings
HERE=Path(__file__).resolve().parent

def prepare(config):
    folder=Path(config['evidence_dir']).resolve();check(folder.drive.lower()=='c:','ui_prepare_requires_c')
    folder.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
    template=json.loads(Path(config['ui_plan_template']).read_text(encoding='utf-8'))
    check(template.get('schema')=='d08-ui-production-plan/v1' and template.get('pages_checkpoint')==manifest['pages_candidate'],'ui_template_revision_wrong')
    check(re.fullmatch('[a-f0-9]{64}',config.get('bundle_revision','')) and config.get('product_revision')=='d08-bundle:'+config['bundle_revision'],'ui_bundle_missing')
    check(json.loads(Path(config['ui_rpc_config']).read_text(encoding='utf-8'))==config,'ui_rpc_config_changed')
    bycase={e['case_id']:e for e in template['entries']};check(set(bycase)==set(ENTRIES),'ui_template_case_set')
    run=uuid.uuid4().hex;used=set()
    def negative():
        while True:
            value=-1000000-secrets.randbelow(2000000000)
            if value not in used:used.add(value);return value
    for original in bycase.values():
        for key,path in original['assets'].items():check(hashlib.sha256(Path(path).read_bytes()).hexdigest()==original['asset_hashes'][key],'ui_local_asset_changed')
    entries=[]
    targets={t['name']:t for t in manifest['targets']}
    for index,(case_id,(client,target)) in enumerate(ENTRIES.items()):
        api,database=DESTINATIONS[target]
        identity={'attempt_id':str(uuid.uuid4()),'student_ref':str(uuid.uuid4()),'marker':'CODEX_D08_'+run+'_'+str(index),
          'class_code':'CODEXDEMO56' if target.endswith('demo-api-1') else 'IC2264' if target=='izone-k56-ic2264-api' else 'IC2146',
          'course_id':DEMO_COURSE_ID if target==NAMES[2] else negative(),'student_id':negative()}
        entries.append({'case_id':case_id,'client':client,'identity':identity,
          'destination':{'container':target,'image':targets[target]['candidate_image'],'public_api_base':api,'database':database}})
    ledger={'schema':'d08-ui-production-ledger/v1','run_id':run,'bundle_revision':config['bundle_revision'],'task_id':'01a0ffd0-778e-7723-99e3-a4bdee78fbb7','entries':entries}
    validate_ledger(ledger,manifest)
    save_new(folder/'production-ui-ledger.json',ledger)
    digest=hashlib.sha256((folder/'production-ui-ledger.json').read_bytes()).hexdigest()
    plan={'schema':'d08-ui-production-plan/v1','scope':'production_fixture','pages_checkpoint':manifest['pages_candidate'],'entries':[]}
    for entry in entries:
        original=bycase[entry['case_id']]
        for key,path in original['assets'].items():check(hashlib.sha256(Path(path).read_bytes()).hexdigest()==original['asset_hashes'][key],'ui_local_asset_changed')
        plan['entries'].append({**entry,'fixture_seeded':False,'assets':original['assets'],'asset_hashes':original['asset_hashes'],'public_asset_urls':original['public_asset_urls'],
          'binding':{'schema':'d08-ui-bridge/v1','run_id':run,'ledger_sha256':digest,'bundle_revision':config['bundle_revision'],'destination':entry['destination']},
          'rpc_config':config['ui_rpc_config']})
    save_new(folder/'production-ui-plan.json',plan)
    return {'status':'prepared','run_id':run,'entries':7,'production_mutated':False}

def validate_plan(plan,ledger,manifest,config,ledger_sha256):
    # Đối chiếu đủ bảy ca với sổ chuẩn trước khóa/HTTP/seed, chặn cả plan rỗng.
    check(plan.get('schema')=='d08-ui-production-plan/v1' and plan.get('scope')=='production_fixture'
          and plan.get('pages_checkpoint')==manifest['pages_candidate'],'ui_plan_scope_revision_wrong')
    entries=plan.get('entries')
    check(isinstance(entries,list) and len(entries)==7 and {e.get('case_id') for e in entries}==set(ENTRIES),'ui_plan_case_set')
    bycase={e['case_id']:e for e in ledger['entries']}
    keys={'app','config','css','examOrder'}
    for entry in entries:
        frozen=bycase[entry['case_id']]
        check(all(entry.get(key)==frozen[key] for key in ('case_id','client','identity','destination')),'ui_plan_identity_destination_changed')
        expected={'schema':'d08-ui-bridge/v1','run_id':ledger['run_id'],'ledger_sha256':ledger_sha256,
                  'bundle_revision':ledger['bundle_revision'],'destination':frozen['destination']}
        check(entry.get('binding')==expected,'ui_plan_binding_changed')
        check(entry.get('rpc_config')==config['ui_rpc_config'] and entry.get('fixture_seeded') is False,'ui_plan_rpc_or_seeded_changed')
        check(all(isinstance(entry.get(key),dict) and set(entry[key])==keys for key in ('assets','asset_hashes','public_asset_urls')),'ui_plan_asset_set')
        for key,path in entry['assets'].items():
            check(hashlib.sha256(Path(path).read_bytes()).hexdigest()==entry['asset_hashes'][key],'ui_plan_local_asset_changed')
    return entries

def run(config):
    folder=Path(config['evidence_dir']).resolve();check(folder.drive.lower()=='c:','ui_run_requires_c')
    manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
    adapter.checkpoint_inputs(config,manifest)
    ledger=json.loads((folder/'production-ui-ledger.json').read_text(encoding='utf-8'));validate_ledger(ledger,manifest)
    check(ledger['bundle_revision']==config['bundle_revision'],'ui_bundle_changed')
    plan=json.loads((folder/'production-ui-plan.json').read_text(encoding='utf-8'))
    validate_plan(plan,ledger,manifest,config,hashlib.sha256((folder/'production-ui-ledger.json').read_bytes()).hexdigest())
    save_new(folder/'ui-producer.executor.json',{'pid':os.getpid(),'run_id':ledger['run_id'],'bundle_revision':config['bundle_revision']})
    # Công khai/Git phải đúng trước seed; không tạo fixture khi Pages còn bản cũ.
    public=adapter.public_readback(config)
    for entry in plan['entries']:
        check(entry['asset_hashes']==expected_assets(entry['client'],public),'ui_plan_assets_wrong_bundle')
    rows=adapter.remote(config,'probe')
    check(len(rows)==3 and all(row['name']==target['name'] and row['image']==target['candidate_image'] and row['running'] and row['healthy']=='healthy' for row,target in zip(rows,manifest['targets'])),'ui_candidates_not_live')
    capture_database_bindings(config)
    save_new(folder/'production-ui-snapshot.json',rows)
    save_new(folder/'production-ui-public-preflight.json',public)
    aggregate={'schema':'d08-ui-production-outcome/v1','status':'in_progress','run_id':ledger['run_id'],'children':[]}
    for entry in plan['entries']:
        save_new(folder/('before-seed-'+entry['case_id']+'.json'),{'case_id':entry['case_id'],'identity':entry['identity'],'destination':entry['destination']})
        call(config,entry['case_id'],'seed')
        single={**plan,'entries':[{**entry,'fixture_seeded':True}]}
        packet=folder/('ui-plan-'+entry['case_id']+'.json');save_new(packet,single)
        output=folder/'browser';output.mkdir(exist_ok=True)
        command=['node',str(HERE/'run-bridge.mjs'),str(packet),str(HERE/'owned-ui-bridge.mjs'),str(output)]
        save_new(folder/('ui-run-'+entry['case_id']+'.request.json'),{'command':command,'source_sha256':hashlib.sha256((HERE/'ui-canary.cjs').read_bytes()).hexdigest()})
        result=subprocess.run(command,capture_output=True,text=True,encoding='utf-8',timeout=600,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
        (folder/('ui-run-'+entry['case_id']+'.log')).write_text(result.stdout+result.stderr,encoding='utf-8')
        receipt=output/entry['case_id']/'receipt.json'
        check(receipt.is_file(),'ui_child_response_unknown')
        value=json.loads(receipt.read_text(encoding='utf-8'))
        aggregate['children'].append({'case_id':entry['case_id'],'path':receipt.relative_to(folder).as_posix(),'sha256':hashlib.sha256(receipt.read_bytes()).hexdigest()})
        save_new(folder/('after-ui-'+entry['case_id']+'.json'),aggregate)
        check(result.returncode==0 and value['status']=='passed','ui_child_not_passed_reconcile_owned_fixture')
    check(len(aggregate['children'])==7 and {e['case_id'] for e in aggregate['children']}==set(ENTRIES),'ui_plan_children_incomplete')
    aggregate['status']='passed'
    save_new(folder/'production-ui-browser.json',aggregate)
    return {'status':'passed_browser_fixture','entries':7,'evidence':str(folder/'production-ui-browser.json')}

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('action',choices=['prepare','run']);args=parser.parse_args()
    try:print(json.dumps(globals()[args.action](json.loads(Path(args.config).read_text(encoding='utf-8'))),ensure_ascii=False))
    except Exception as error:print(json.dumps({'status':'unknown','error':type(error).__name__},ensure_ascii=False));sys.exit(1)
