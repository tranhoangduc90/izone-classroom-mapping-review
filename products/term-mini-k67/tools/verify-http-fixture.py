"""Chạy native HTTP/asset test trên đúng backend fixture, giữ log/receipt thật.
Chỉ làm mới context của DB giả đã xác minh; không động roster/quyền/bài thật.
"""
from datetime import datetime,timezone
from pathlib import Path
import importlib.util
import hashlib
import json
import re
import shlex
import sys
import uuid
ROOT=Path(__file__).resolve().parents[1]
def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True);sys.stderr.reconfigure(encoding='utf-8',line_buffering=True)
    spec=importlib.util.spec_from_file_location('http_fixture',ROOT/'tools/prepare-http-fixture.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    state=json.loads(helper.STATE.read_text(encoding='utf-8'))
    helper.validate_state(state)
    if state['identity']!=helper.IDENTITY or state['source_hashes']!=helper.current_source():raise RuntimeError('FIXTURE_SOURCE_MISMATCH')
    run_id='k67-live-http-verify-'+uuid.uuid4().hex
    u=helper.utilities();client=u.connect();before=u.protected(client);revision=helper.fingerprint()
    stdout=b'';stderr=b'';code=None;error=None;guard_error=None;env_path=None;argv=None
    try:
        for name in [helper.APP,helper.GATE]:
            helper.check_container(json.loads(u.remote(client,['docker','inspect',name]))[0],state,name)
        marker=helper.sql(u,client,state['database'],"SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity")
        if marker!='PRODUCT-TERM-MINI-K67:'+state['intent_id']:raise RuntimeError('FIXTURE_DB_MARKER_MISMATCH')
        expected={slug:state['student_refs'][slug] for slug in helper.SLUGS}
        actual=json.loads(helper.sql(u,client,state['database'],"SELECT jsonb_object_agg(test_slug,student_ref)::text FROM assessment.term_test_roster"))
        if actual!=expected:raise RuntimeError('FIXTURE_ROSTER_CHANGED')
        # Chỉ cập nhật row ngữ cảnh giả đã nhận diện; không thêm người/quyền để làm test xanh.
        helper.sql(u,client,state['database'],"UPDATE mapping.k67_context_state SET captured_at=now() WHERE product_id='PRODUCT-TERM-MINI-K67'")
        pins=json.loads((helper.PRIVATE/'ASSETS_AND_PAGES_INVENTORY_FINAL.json').read_text(encoding='utf-8'))['assets']['rows']
        remote_script=helper.REMOTE+'/'+run_id+'.test.js'
        helper.upload(client,remote_script,(ROOT/'test/live-http-fixture.test.js').read_bytes(),0o644)
        env={'K67_LIVE_FIXTURE_CONFIRMATION':'synthetic-live-http-v1','K67_LIVE_FIXTURE_REFS':json.dumps(expected,separators=(',',':')),
            'K67_LIVE_ASSET_PINS':json.dumps(pins,separators=(',',':'))}
        env_path=helper.REMOTE+'/'+run_id+'.env'
        helper.upload(client,env_path,'\n'.join(k+'='+v for k,v in env.items())+'\n',0o600)
        argv=['docker','run','--rm','--name',run_id,'--network','n8n-net','--cpus','0.5','--memory','256m','--pids-limit','100',
            '--read-only','--tmpfs','/tmp:rw,size=16m,mode=1777','--env-file',env_path,
            '-v',remote_script+':/fixture.test.js:ro','-v',helper.REMOTE+'/assets:/private-assets:ro',state['image'],
            'node','--test','--test-reporter=tap','--test-concurrency=1','/fixture.test.js']
        incoming,out,err=client.exec_command(' '.join(shlex.quote(x) for x in argv),timeout=240)
        stdout=out.read();stderr=err.read();code=out.channel.recv_exit_status()
    except Exception as exc:error=type(exc).__name__+':'+str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
    finally:
        if env_path:
            try:
                sftp=client.open_sftp();sftp.remove(env_path);sftp.close()
            except Exception as exc:error=error or 'ENV_CLEANUP_'+type(exc).__name__
        try:after=u.protected(client)
        except Exception as exc:after=None;guard_error=type(exc).__name__
        client.close()
    after_revision=helper.fingerprint();parsed=stdout.decode('utf-8').replace('\r\n','\n')
    def count(name):
        values=re.findall(r'^# '+name+r' (\d+)$',parsed,re.MULTILINE)
        return int(values[-1]) if values else None
    outcome='passed' if error is None and guard_error is None and code==0 and count('pass')==4 and count('fail')==0 \
        and count('skipped')==0 and revision==after_revision and before==after else 'failed'
    evidence=ROOT/'.codex/product-evidence';stdout_path=evidence/(run_id+'.tap');stderr_path=evidence/(run_id+'.stderr.log')
    stdout_path.write_bytes(stdout);stderr_path.write_bytes(stderr)
    receipt={'run_id':run_id,'command':argv,'native_runner':['node','--test','--test-reporter=tap','--test-concurrency=1','/fixture.test.js'],
        'tree_revision':revision,'observed_after_revision':after_revision,'exit_code':code,'outcome':outcome,
        'passed':count('pass'),'failed':count('fail'),'skipped':count('skipped'),'operation_error':error,'guard_error':guard_error,
        'executed_test_ids':re.findall(r'^# Subtest: (.+)$',parsed,re.MULTILINE),
        'stdout':{'path':str(stdout_path),'sha256':hashlib.sha256(stdout).hexdigest()},
        'stderr':{'path':str(stderr_path),'sha256':hashlib.sha256(stderr).hexdigest()},
        'protected_before':before,'protected_after':after,'fixture_id':state['intent_id'],'database':state['database'],
        'candidate_image':state['image'],'observed_at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z')}
    helper.atomic(evidence/(run_id+'.json'),receipt)
    sys.stdout.write(parsed);sys.stderr.write(stderr.decode('utf-8'))
    print(json.dumps({k:receipt[k] for k in ['run_id','outcome','operation_error','guard_error']}))
    return 0 if outcome=='passed' else (code or 1)
if __name__=='__main__':sys.exit(main())
