"""Sửa diễn tập K67 theo ba bước có journal: chuẩn bị, gateway giả, writer riêng.
Chỉ thay một Code readback và file gateway mount; không sửa writer nguồn hoặc bài thi.
Lỗi giữ nguyên ý định để đọc lại, không tự chạy lại AI hoặc ghi đè trạng thái khác.
"""
from pathlib import Path
import argparse
import json
import re
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import importlib.util

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / file)
    obj = importlib.util.module_from_spec(spec); spec.loader.exec_module(obj); return obj

def check(value, code):
    if not value: raise RuntimeError(code)

def immutable(h, path, value):
    if path.exists(): check(json.loads(path.read_text(encoding='utf-8')) == value, 'REPAIR_ARTIFACT_CHANGED')
    else: h.atomic(path, value)

def replace_owned_file(h, client, path, before_sha256, data):
    # Chỉ thay hai file của fixture đã nhận diện, bằng rename nguyên vẹn sau kiểm hash.
    # Giữ upload tạo mới của provision nguyên trạng; mất ACK đọc lại old/new, không ghi đè file lạ.
    check(path in [h.REMOTE+'/source/ops/fixture-gateway.mjs',h.REMOTE+'/intent.json'], 'REPLACE_PATH_OUTSIDE_FIXTURE')
    sftp = client.open_sftp()
    try:
        with sftp.open(path,'rb') as f: actual=f.read()
        if h.sha(actual)==h.sha(data): return
        check(h.sha(actual)==before_sha256,'OWN_FILE_CHANGED_NO_OVERWRITE')
        temporary=path+'.k67-repair-'+uuid.uuid4().hex
        with sftp.open(temporary,'wx') as f: f.write(data)
        sftp.chmod(temporary,0o644 if path.endswith('/fixture-gateway.mjs') else 0o600)
        with sftp.open(temporary,'rb') as f: check(h.sha(f.read())==h.sha(data),'STAGED_FILE_READBACK_FAILED')
        with sftp.open(path,'rb') as f: check(h.sha(f.read())==before_sha256,'OWN_FILE_CHANGED_NO_OVERWRITE')
        sftp.posix_rename(temporary,path)
        with sftp.open(path,'rb') as f: check(h.sha(f.read())==h.sha(data),'OWN_FILE_REPLACE_OUTCOME_UNKNOWN')
    finally: sftp.close()

def prepare(h, g, p, state, folder):
    # Lưu candidate mới riêng, giữ nguyên candidate cũ và baseline khôi phục.
    old_path = g.PRIVATE / 'writer.candidate.private.json'
    check(h.sha(old_path.read_bytes()) == '26639c562d3c14dd0e62e199137cdebd7973762d857b03272afe6eb7467a4a38', 'OLD_WRITER_PIN_CHANGED')
    old = json.loads(old_path.read_text(encoding='utf-8'))
    live = g.sdk(p, {'operation':'inspect', 'profile':'izone-ai', 'role':'writer', 'candidate':old,
        'expectedVersion':state['workflows']['writer']['versionId']}, 'repair-inspect')
    check(live['active'] is False, 'WRITER_MUST_BE_INACTIVE')
    candidate = g.sdk(p, {'operation':'repair-writer-readback', 'profile':'izone-ai', 'workflow':old}, 'repair-candidate')
    path = folder / 'writer.candidate.private.json'; immutable(h, path, candidate); p.validate(path)
    scripts = Path('E:/wt/k67-fixture-writer-20261006/n8n-root/n8n-workflows/scripts')
    trigger = g.call(p, [p.NODE, str(scripts/'kiem-tra-thay-doi-trigger.mjs'), '--before', str(old_path), '--after', str(path), '--json'], 'repair-trigger')
    check(not trigger.get('headless_deploy_blocked'), 'TRIGGER_DEPLOY_BLOCKED')
    lineage = g.call(p, [p.NODE, str(scripts/'check-item-lineage-risk.mjs'), '--json', str(path)], 'repair-lineage', accepted_exit_codes=(0,1))
    immutable(h, folder/'lineage.private.json', lineage)
    hashed = g.sdk(p, {'operation':'hash-body', 'workflow':candidate}, 'repair-hash')
    repair = {'status':'prepared', 'before_sha256':h.sha(old_path.read_bytes()), 'candidate_path':str(path),
        'candidate_sha256':h.sha(path.read_bytes()), 'body_sha256':hashed['body_sha256'], 'before_version':live['versionId']}
    if state.get('writer_repair'): check(state['writer_repair'] == repair, 'REPAIR_ALREADY_CHANGED')
    else: state['writer_repair'] = repair; h.atomic(g.STATE, state)

def reviewed(h, state, folder):
    report = json.loads((folder/'review.private.json').read_text(encoding='utf-8'))
    check(report.get('tree_revision') == h.fingerprint() and report.get('spec_compliance') == 'passed'
        and report.get('code_quality') == 'passed' and report.get('candidate_sha256') == state['writer_repair']['candidate_sha256'],
        'REPAIR_REVIEW_REQUIRED')
    return report

def recover_gateway_permissions(h,g,u,client,state,folder,fixture):
    # Khôi phục lỗi EACCES đã quan sát: chỉ source thuần của gateway own, không mở env/marker.
    # Phải khớp intent đang dở, cả hash mới và backup cũ; không sửa nội dung hoặc Portal state.
    check(state.get('pending',{}).get('operation')=='gateway_fault_upgrade','RECOVERY_INTENT_MISSING')
    path=h.REMOTE+'/source/ops/fixture-gateway.mjs'
    expected=h.sha((ROOT/'ops/fixture-gateway.mjs').read_bytes())
    check(h.sha((folder/'gateway.before.mjs').read_bytes())==fixture['source_hashes']['ops/fixture-gateway.mjs'],'RECOVERY_BACKUP_CHANGED')
    sftp=client.open_sftp()
    try:
        with sftp.open(path,'rb') as f: check(h.sha(f.read())==expected,'RECOVERY_SOURCE_CHANGED')
        with sftp.open(h.REMOTE+'/portal-state/portal.json','rb') as f: portal_before=json.loads(f.read())
        mode=sftp.stat(path).st_mode & 0o777
        check(mode in [0o600,0o644],'RECOVERY_MODE_CHANGED')
        if mode==0o600: sftp.chmod(path,0o644)
        check(sftp.stat(path).st_mode & 0o777 == 0o644,'RECOVERY_PERMISSION_READBACK_FAILED')
    finally:sftp.close()
    verifier=load('recovery_native','verify-grading-fixture.py');server,base=verifier.tunnel(client)
    try:
        import requests
        def ready():
            try:
                r=requests.get(base+'/fixture/ready',timeout=2)
                return r.status_code==200 and r.json().get('identity')==h.IDENTITY
            except requests.RequestException: return False
        # Lượt trước đã restart nhưng HTTP chưa kịp lắng nghe: chỉ đọc lại, không restart lần nữa.
        if not ready(): u.remote(client,['docker','restart',h.GATE],timeout=40)
        deadline=time.monotonic()+25
        while not ready() and time.monotonic()<deadline: time.sleep(0.5)
        check(ready(),'RECOVERY_NOT_READY')
        check(u.remote(client,['docker','exec',h.GATE,'sha256sum','/fixture-gateway.mjs']).decode().split()[0]==expected,'RECOVERY_MOUNT_CHANGED')
    finally:server.shutdown();server.server_close()
    h.check_container(json.loads(u.remote(client,['docker','inspect',h.GATE]))[0],fixture,h.GATE)
    sftp=client.open_sftp()
    try:
        with sftp.open(h.REMOTE+'/portal-state/portal.json','rb') as f: check(json.loads(f.read())==portal_before,'RECOVERY_PORTAL_STATE_CHANGED')
    finally:sftp.close()

def writer(h, g, p, state, folder):
    # Backup exact live trước PUT; sau mất ACK chỉ nhận toàn body đúng candidate.
    reviewed(h, state, folder)
    repair = state['writer_repair']; path = Path(repair['candidate_path'])
    native_path = h.PRIVATE/'grading-native/state.json'
    native = json.loads(native_path.read_text(encoding='utf-8'))
    check(not native.get('pending_execution') and native['intent'] == state['intent'], 'NATIVE_STATE_NOT_READY')
    check(h.sha(path.read_bytes()) == repair['candidate_sha256'], 'REPAIR_CANDIDATE_CHANGED')
    old = json.loads((g.PRIVATE/'writer.candidate.private.json').read_text(encoding='utf-8'))
    old['versionId'] = repair['before_version']; new = json.loads(path.read_text(encoding='utf-8'))
    if repair['status'] == 'prepared' and not state.get('pending'):
        live = g.call(p, [p.NODE,p.CLI,'--profile','izone-ai','--json','workflow','get',g.ROLES['writer'][1]], 'repair-exact-before')
        check(live['id'] == old['id'] and live['active'] is False and live['versionId'] == old['versionId'], 'WRITER_BASELINE_CHANGED')
        check(g.sdk(p, {'operation':'hash-body','workflow':live},'repair-before-hash')['body_sha256'] == state['workflows']['writer']['body_sha256'], 'WRITER_BODY_CHANGED')
        immutable(h, folder/'writer.before.private.json', live)
        g.begin(h,state,'writer_readback_repair',role='writer')
    check(not state.get('pending') or state['pending']['operation'] == 'writer_readback_repair', 'PENDING_MUTATION_RECONCILE_FIRST')
    request = {'operation':'workflow','profile':'izone-ai','role':'writer','before':old,'candidate':new}
    observed = g.sdk(p,{**request,'update':False},'repair-read')
    if observed['classification'] == 'before':
        check(state.get('pending'), 'REPAIR_INTENT_MISSING')
        observed = g.sdk(p,{**request,'update':True},'repair-update',state['pending']['attempt'])
    check(observed['classification'] == 'candidate' and observed['body_sha256'] == repair['body_sha256'], 'REPAIR_READBACK_UNKNOWN')
    state['workflows']['writer'] = {'versionId':observed['versionId'],'body_sha256':observed['body_sha256'],'stage':'overlay_inactive'}
    repair['status'] = 'applied'; repair['review_sha256'] = h.sha((folder/'review.private.json').read_bytes()); g.complete(h,state)
    native['writer_version'] = observed['versionId']; h.atomic(native_path,native)

def gateway(h, g, p, u, client, state, folder, fixture):
    # Nâng đúng mount của gateway giả; image/APP/DB và các ô đã có giữ nguyên.
    reviewed(h,state,folder)
    current = h.current_source(); previous = fixture['source_hashes']; relative = 'ops/fixture-gateway.mjs'
    check({k:v for k,v in current.items() if k != relative} == {k:v for k,v in previous.items() if k != relative}, 'BACKEND_SOURCE_CHANGED')
    remote_file = h.REMOTE+'/source/'+relative; marker_path = h.REMOTE+'/intent.json'
    sftp = client.open_sftp()
    try:
        with sftp.open(remote_file,'rb') as f: observed = f.read()
        with sftp.open(marker_path,'rb') as f: marker_bytes=f.read(); marker = json.loads(marker_bytes)
        with sftp.open(h.REMOTE+'/portal-state/portal.json','rb') as f: portal_before = json.loads(f.read())
    finally: sftp.close()
    expected = {'identity':h.IDENTITY,'intent_id':fixture['intent_id'],'source_hashes':previous}
    updated_marker = {'identity':h.IDENTITY,'intent_id':fixture['intent_id'],'source_hashes':current}
    check(marker == expected or (state.get('pending',{}).get('operation')=='gateway_fault_upgrade' and marker==updated_marker), 'GATEWAY_MARKER_CHANGED')
    if fixture.get('gateway_upgrade'):
        check(marker==updated_marker and current==previous and h.sha(observed)==current[relative], 'GATEWAY_UPGRADE_CHANGED')
        check(h.sha((folder/'gateway.before.mjs').read_bytes())==fixture['gateway_upgrade']['before_sha256'], 'GATEWAY_BACKUP_CHANGED')
        state['gateway_fault_upgrade']=fixture['gateway_upgrade']
        check(not state.get('pending') or state['pending']['operation']=='gateway_fault_upgrade','PENDING_MUTATION_RECONCILE_FIRST')
        g.complete(h,state); return
    check(h.sha(observed) in [previous[relative],current[relative]], 'GATEWAY_SOURCE_CHANGED')
    backup = folder/'gateway.before.mjs'
    if not backup.exists():
        check(h.sha(observed) == previous[relative], 'GATEWAY_BACKUP_MISSING')
        with backup.open('xb') as f: f.write(observed)
    check(h.sha(backup.read_bytes()) == previous[relative], 'GATEWAY_BACKUP_CHANGED')
    immutable(h,folder/'http-state.before.private.json',fixture)
    if not state.get('pending'): g.begin(h,state,'gateway_fault_upgrade')
    check(state['pending']['operation'] == 'gateway_fault_upgrade', 'PENDING_MUTATION_RECONCILE_FIRST')
    marker_backup=folder/'gateway-marker.before.json'
    if not marker_backup.exists():
        check(marker==expected,'GATEWAY_MARKER_BACKUP_MISSING')
        with marker_backup.open('xb') as f: f.write(marker_bytes)
    check(json.loads(marker_backup.read_bytes())==expected,'GATEWAY_MARKER_BACKUP_CHANGED')
    replace_owned_file(h,client,remote_file,previous[relative],(ROOT/relative).read_bytes())
    # Nếu restart mất ACK, journal vẫn còn và lượt sau chỉ tiếp trên đúng nguồn mới.
    u.remote(client,['docker','restart',h.GATE],timeout=40)
    mounted = u.remote(client,['docker','exec',h.GATE,'sha256sum','/fixture-gateway.mjs']).decode().split()[0]
    check(mounted == current[relative], 'GATEWAY_MOUNT_READBACK_FAILED')
    verifier = load('repair_native','verify-grading-fixture.py'); server,base = verifier.tunnel(client)
    try:
        import requests
        deadline = time.monotonic()+25; ready = False
        while time.monotonic()<deadline:
            try:
                r = requests.get(base+'/fixture/ready',timeout=2)
                ready = r.status_code==200 and r.json().get('identity')==h.IDENTITY
            except requests.RequestException: ready = False
            if ready: break
            time.sleep(0.5)
        check(ready,'GATEWAY_RESTART_NOT_READY')
    finally: server.shutdown(); server.server_close()
    h.check_container(json.loads(u.remote(client,['docker','inspect',h.GATE]))[0],fixture,h.GATE)
    sftp = client.open_sftp()
    try:
        with sftp.open(h.REMOTE+'/portal-state/portal.json','rb') as f: portal_after = json.loads(f.read())
        with sftp.open(remote_file,'rb') as f: check(h.sha(f.read())==current[relative],'GATEWAY_SOURCE_READBACK_FAILED')
    finally: sftp.close()
    check(portal_before==portal_after,'PORTAL_STATE_CHANGED_DURING_UPGRADE')
    fixture.setdefault('image_source_hashes',previous)
    fixture['source_hashes']=current
    fixture['gateway_upgrade']={'before_sha256':previous[relative],'after_sha256':current[relative],'intent':state['intent']}
    replace_owned_file(h,client,marker_path,h.sha(marker_bytes),json.dumps(updated_marker).encode('utf-8'))
    sftp = client.open_sftp()
    try:
        with sftp.open(marker_path,'rb') as f: check(json.loads(f.read())==updated_marker,'GATEWAY_MARKER_READBACK_FAILED')
    finally: sftp.close()
    h.atomic(h.STATE,fixture); state['gateway_fault_upgrade']=fixture['gateway_upgrade']; g.complete(h,state)

def main():
    sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(); parser.add_argument('--phase',choices=['prepare','gateway','writer','recover-gateway-permissions'],required=True); args=parser.parse_args()
    h=load('repair_http','prepare-http-fixture.py'); g=load('repair_grading','prepare-grading-fixture.py'); p=load('repair_provision','provision-grading-bundle.py'); u=h.utilities()
    folder=g.PRIVATE/'writer-repair'; folder.mkdir(exist_ok=True)
    with g.single_owner(g.PRIVATE/'operation.lock'):
        state=json.loads(g.STATE.read_text(encoding='utf-8')); fixture=json.loads(h.STATE.read_text(encoding='utf-8')); h.validate_state(fixture)
        check(state['intent']==fixture['intent_id'] and state['product_id']=='PRODUCT-TERM-MINI-K67','REPAIR_IDENTITY_MISMATCH')
        native=json.loads((h.PRIVATE/'grading-native/state.json').read_text(encoding='utf-8'))
        check(not native.get('pending_execution') and native['intent']==state['intent'],'NATIVE_STATE_NOT_READY')
        revision=h.fingerprint(); source_before=g.source_versions(p); client=u.connect(); protected_before=u.protected(client)
        error=guard_error=None
        try:
            for name in [h.APP,h.GATE]: h.check_container(json.loads(u.remote(client,['docker','inspect',name]))[0],fixture,name,
                allow_stopped=(name==h.GATE and args.phase=='recover-gateway-permissions'))
            for role in g.ROLES:
                if role=='writer' and args.phase=='writer' and state.get('pending',{}).get('operation')=='writer_readback_repair': continue
                candidate=json.loads(g.candidate_path(state,role).read_text(encoding='utf-8'))
                live=g.sdk(p,{'operation':'inspect','role':role,'profile':g.ROLES[role][0],'candidate':candidate,
                    'expectedVersion':state['workflows'][role]['versionId']},'repair-own-'+role)
                check(live['active'] is False,'OWN_WORKFLOW_MUST_BE_INACTIVE')
            check(h.sql(u,client,fixture['database'],"SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity")=='PRODUCT-TERM-MINI-K67:'+state['intent'],'FIXTURE_DB_MARKER_CHANGED')
            if args.phase=='prepare': prepare(h,g,p,state,folder)
            elif args.phase=='gateway': gateway(h,g,p,u,client,state,folder,fixture)
            elif args.phase=='recover-gateway-permissions': recover_gateway_permissions(h,g,u,client,state,folder,fixture)
            else: writer(h,g,p,state,folder)
        except Exception as exc: error=str(exc) if re.fullmatch('[A-Z_0-9]+',str(exc)) else type(exc).__name__
        finally:
            try:
                source_after=g.source_versions(p); protected_after=u.protected(client)
                check(source_before==source_after and protected_before==protected_after,'PROTECTED_STATE_CHANGED')
            except Exception as exc: source_after=protected_after=None; guard_error=type(exc).__name__
            client.close()
        run_id='k67-fixture-repair-'+uuid.uuid4().hex
        receipt={'run_id':run_id,'phase':args.phase,'tree_revision':revision,'observed_after_revision':h.fingerprint(),
            'outcome':'passed' if not error and not guard_error and revision==h.fingerprint() else 'unknown',
            'operation_error':error,'guard_error':guard_error,'source_before':source_before,'source_after':source_after,
            'protected_before':protected_before,'protected_after':protected_after,'pending':state.get('pending')}
        h.atomic(folder/(run_id+'.json'),receipt)
        print(json.dumps({k:receipt[k] for k in ['run_id','phase','outcome','operation_error','guard_error']}))
        return 0 if receipt['outcome']=='passed' else 1

if __name__=='__main__': sys.exit(main())
