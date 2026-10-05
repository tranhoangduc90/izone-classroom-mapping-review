"""Fixture Docker thật, chỉ dùng container và mạng riêng của lần chạy.
Nhận manifest image qua stdin; không dùng Env/port/mount hay DB production.
Chạy chương trình Node giả, gây mất phản hồi rồi phục hồi đúng ID và cấu hình.
Kết quả chỉ chứng minh Docker transition; activity SQL cần fixture riêng.
"""
import copy
import json
import tempfile
import uuid
from pathlib import Path
import release_remote as r


def exercise(manifest):
    owner = uuid.uuid4().hex
    prefix = 'izone-d08-qa-'+owner[:12]
    labels = {'codex.task':'writing-d08-release-fixture','codex.fixture':owner}
    network = r.api('POST','/networks/create',{'Name':prefix,'Driver':'bridge','Internal':True,'Labels':labels})['Id']
    original_api = r.api
    original_activity = r.active_writing
    original_stopped_activity = r.stopped_activity
    original_verify_backup = r.verify_backup
    original_wait = r.wait_healthy
    original_root = r.RELEASE_ROOT
    receipts = []
    try:
        with tempfile.TemporaryDirectory(prefix=prefix) as directory:
            r.RELEASE_ROOT = Path(directory)
            # Fixture không có database, sự thật này ghi rõ trong output receipt.
            r.active_writing = lambda _: [{'active':0}]
            r.stopped_activity = lambda *args: {'active':0}
            r.verify_backup = lambda _: {}
            phases = ['stop','rename','disconnect','create','start','health','partial_second_start','pages_failure']
            for phase_index,phase in enumerate(phases):
                fixture_manifest = {'targets':[]}
                created_ids = []
                run_id = uuid.uuid4().hex
                target_prefix = prefix+'-'+str(phase_index)
                try:
                    for index,target in enumerate(manifest['targets']):
                        name = target_prefix+'-'+str(index)
                        body = {
                            'Image':target['base_image'],'Entrypoint':['node'],
                            'Cmd':['-e',"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);"],
                            'Env':['D08_FIXTURE_ONLY=1'],'Labels':labels,
                            'Healthcheck':{'Test':['CMD','node','-e','process.exit(0)'],'Interval':1000000000,'Timeout':1000000000,'Retries':3},
                            'HostConfig':{'NetworkMode':prefix,'Memory':134217728,'PidsLimit':64,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges']},
                            'NetworkingConfig':{'EndpointsConfig':{prefix:{'Aliases':[name]}}}
                        }
                        identifier = original_api('POST','/containers/create?name='+name,body)['Id']
                        created_ids.append(identifier)
                        original_api('POST','/containers/'+identifier+'/start')
                        original_wait(identifier)
                        item = copy.deepcopy(target)
                        item['name'] = name
                        fixture_manifest['targets'].append(item)
                    before = r.probe(fixture_manifest)
                    did_fail = [False]
                    trigger_target = 1 if phase=='partial_second_start' else 0
                    trigger_phase = 'start' if phase=='partial_second_start' else phase

                    def fail_after(method,url,body=None):
                        result = original_api(method,url,body)
                        operation = url.split('?')[0].split('/')[-1]
                        if operation=='create' and url.startswith('/containers/'):
                            operation='create'
                            name = body.get('Labels',{})
                            current = r.inspect(result['Id']) if name.get('codex.fixture')==owner else None
                        elif url.startswith('/containers/') and operation in ('stop','rename','start'):
                            current = r.inspect(url.split('/')[2])
                        elif url.startswith('/networks/') and operation=='disconnect':
                            current = r.inspect(body['Container'])
                        else:
                            current = None
                        if current and current['Name'].startswith('/'+target_prefix+'-'+str(trigger_target)) and operation==trigger_phase and not did_fail[0]:
                            did_fail[0]=True
                            raise RuntimeError('fixture_response_lost_after_'+operation)
                        return result

                    def fail_health(identifier):
                        original_wait(identifier)
                        if phase=='health' and not did_fail[0] and r.inspect(identifier)['Name']=='/'+target_prefix+'-0':
                            did_fail[0]=True
                            raise RuntimeError('fixture_response_lost_after_health')

                    r.api = fail_after
                    r.wait_healthy = fail_health
                    request = {'manifest':fixture_manifest,'expected':before,'run_id':run_id}
                    try:
                        result = r.switch(request)
                        if phase!='pages_failure':
                            raise AssertionError('Expected injected failure')
                        if result['status']!='deployed_awaiting_validation':
                            raise AssertionError('Unexpected switch state')
                    except RuntimeError as error:
                        if not str(error).startswith('fixture_response_lost'):
                            raise
                    if phase!='pages_failure' and not did_fail[0]:
                        raise AssertionError('Fault injection not reached')
                    try:
                        r.switch(request)
                    except RuntimeError as error:
                        if not str(error).startswith('release_already_started'):
                            raise
                    else:
                        raise AssertionError('Switch replay accepted')
                    first_recovery = 'original_verified'
                    try:
                        result = r.recover(request)
                    except RuntimeError as error:
                        if str(error)!='recovery_graceful_drain_failed_no_downgrade':
                            raise
                        # Start-response loss có thể tới trước handler SIGTERM của Node.
                        # Guard phải chặn downgrade, giữ/resume image hiện tại rồi báo lỗi.
                        journal=json.loads((r.RELEASE_ROOT/(run_id+'.json')).read_text(encoding='utf-8'))
                        if journal['status']!='recovery_blocked_current_images_resumed':
                            raise AssertionError('Unsafe recovery state')
                        for target in fixture_manifest['targets']:
                            current=r.optional_inspect(target['name'])
                            if current and current['State']['Running']:
                                original_wait(current['Id'])
                        first_recovery='blocked_graceful_drain_current_images_resumed'
                        # Fixture không có user/DB; lần recover có kiểm mới sau healthy.
                        result=r.recover(request)
                    after = r.probe(fixture_manifest)
                    keys = ('name','image','config_hash','source_hash','container_id','running','healthy')
                    if [{key:row[key] for key in keys} for row in before] != [{key:row[key] for key in keys} for row in after]:
                        raise AssertionError('Actual Docker recovery mismatch')
                    receipts.append({'phase':phase,'status':'passed','original_ids_images_config_network_verified':True,'switch_replay_blocked':True,'recovery_status':result['status'],'first_recovery':first_recovery})
                finally:
                    r.api = original_api
                    r.wait_healthy = original_wait
                    # Chỉ dọn object có nhãn UUID riêng, không chọn theo tên rộng.
                    rows = original_api('GET','/containers/json?all=true')
                    for row in rows:
                        if row.get('Labels',{}).get('codex.fixture')!=owner:
                            continue
                        item = r.inspect(row['Id'])
                        if item['Config']['Labels'].get('codex.fixture')!=owner:
                            raise RuntimeError('fixture_cleanup_identity_changed')
                        if item['State']['Running']:
                            original_api('POST','/containers/'+row['Id']+'/stop?t=15')
                        original_api('DELETE','/containers/'+row['Id']+'?v=false')
        remaining = [row for row in original_api('GET','/containers/json?all=true') if row.get('Labels',{}).get('codex.fixture')==owner]
        if remaining:
            raise RuntimeError('fixture_cleanup_incomplete')
        return {'status':'passed','tests':len(receipts),'receipts':receipts,'owned_containers_remaining':0,'activity_guard_scope':'stubbed_no_database_fixture','production_env_used':False,'production_containers_stopped':False}
    finally:
        r.api = original_api
        r.active_writing = original_activity
        r.stopped_activity = original_stopped_activity
        r.verify_backup = original_verify_backup
        r.wait_healthy = original_wait
        r.RELEASE_ROOT = original_root
        item = original_api('GET','/networks/'+network)
        if item.get('Labels',{}).get('codex.fixture')!=owner or item.get('Containers'):
            raise RuntimeError('fixture_network_cleanup_guard_failed')
        original_api('DELETE','/networks/'+network)


if __name__ == '__main__':
    import sys
    print(json.dumps(exercise(json.load(sys.stdin)),ensure_ascii=False))
