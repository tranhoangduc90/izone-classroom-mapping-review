"""Kiểm biên nhận Chrome với HTTP/SQL/ledger và asset thật, chỉ đọc bằng chứng.
Không nhận nhãn case hoặc cờ success thay các chuyển trạng thái hai Tasks.
Receipt offline bị chặn ở lớp production; ảnh/trace phải khớp hash và đúng child.
"""
import collections
import datetime
import hashlib
import json
import re
import uuid
import zipfile
from pathlib import Path
from canary_remote import uses_existing_demo_course

CASES = {'ui_start_preserves_canonical', 'two_writer_stale_preserves_both_tasks',
         'conflict_no_automatic_rebase', 'reload_preserves_local_and_canonical',
         'explicit_keep_local_rebases_after_choice', 'explicit_use_server_keeps_recovery_without_write',
         'visible_recovery_and_outline_preserved'}
READS = ('before','after_ui_start','winner_before_stale_dispatch','after_stale',
         'after_explicit_keep_local','after_explicit_use_server')
ARTIFACTS = {'conflict.png','recovery.png','trace-0.zip','trace-1.zip'}
DESTINATIONS = {
 'mapping-review-api': ('https://ducizone.ddns.net/mapping-api', 'mapping_db'),
 'izone-k56-ic2264-api': ('https://ducizone.ddns.net/mapping-api-k56', 'mapping_db'),
 'izone-k56-demo-k56-demo-api-1': ('https://ducizone.ddns.net/mapping-api-demo', 'izone_mapping_demo')}
ENTRIES = {'shared-mapping':('shared','mapping-review-api'),
           **{client+'-'+kind:(client,target) for client in ('k56-shared','k56-mini-shared','k56-test2-shared')
              for kind,target in (('k56','izone-k56-ic2264-api'),('demo','izone-k56-demo-k56-demo-api-1'))}}


def check(value, error):
    if not value: raise ValueError(error)


def at(value):
    check(isinstance(value,str) and re.search(r'(Z|[+-]\d\d:\d\d)$',value), 'browser_timestamp_offset')
    return datetime.datetime.fromisoformat(value.replace('Z','+00:00'))


def file_hash(root, filename, expected):
    check(isinstance(filename,str) and filename and not Path(filename).is_absolute()
          and '..' not in Path(filename).parts, 'browser_path_invalid')
    path = root/filename
    check(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root.resolve()), 'browser_file_missing')
    raw = path.read_bytes()
    check(hashlib.sha256(raw).hexdigest()==expected, 'browser_file_hash')
    return path,raw


def pair(writing):
    return writing.get('task1'),writing.get('task2'),writing.get('revision')


def expected_assets(client, public):
    paths={'app':'term-tests/'+client+'/app.js','css':'term-tests/'+client+'/styles.css',
           'config':'term-tests/'+client+'/config.js','examOrder':'term-tests/k56-exam-order.js'}
    table={row['path']:row['sha256'] for row in public['assets']}
    check(all(path in table for path in paths.values()), 'browser_public_asset_missing')
    return {key:table[path] for key,path in paths.items()}


def validate_events(child, identity, destination, strict=True):
    reads={}
    responses=[]
    dispatches=[]
    last=None
    for event in child['events']:
        clock=at(event['at'])
        check(last is None or clock>=last, 'browser_event_clock_order');last=clock
        kind=event['kind']
        if kind in ('browser_dispatch','api_response'):
            payload=event['payload']
            check(payload.get('attemptToken')==identity['attempt_id'] and payload.get('action') in ('start','draft'), 'browser_payload_identity_or_action')
            token=json.dumps({'label':event['label'],'payload':payload},sort_keys=True)
            if kind=='browser_dispatch':dispatches.append(token)
            else:
                responses.append(event)
                check(event['response']['status']==200 and event['response']['body'].get('ok') is True
                      and event['response']['body'].get('attemptToken')==identity['attempt_id'], 'browser_http_ack')
        elif kind=='database_read':
            row=event['value'];writing=row['writing']
            check(row.get('attempt_id')==identity['attempt_id'] and row.get('marker')==identity['marker'], 'browser_sql_identity')
            check(row.get('children')==[0]*5 and writing.get('submitted') is False, 'browser_sql_child_or_submit')
            if strict:
                check(row.get('ownership_checked') is True and row.get('destination')==destination
                      and row.get('course_id')==identity['course_id'] and row.get('student_id')==identity['student_id'], 'browser_sql_destination')
            check(type(writing.get('revision')) is int and writing['revision']>=0, 'browser_sql_revision')
            at(writing['serverNow'])
            if writing.get('started'):at(writing['deadlineAt'])
            if event['label'] in READS:
                check(event['label'] not in reads, 'browser_duplicate_read_label')
                reads[event['label']]=writing
        else:raise ValueError('browser_unknown_event')
    check(set(reads)==set(READS), 'browser_required_reads_missing')
    received=[json.dumps({'label':e['label'],'payload':e['payload']},sort_keys=True) for e in responses]
    check(collections.Counter(dispatches)==collections.Counter(received) and len(responses)==5, 'browser_dispatch_ack_count')
    before,start,winner,stale,local,server=(reads[k] for k in READS)
    check(pair(before)==('', '', 0) and before.get('started') is False, 'browser_initial_state')
    check(pair(start)==('', '', 0) and start.get('started') is True, 'browser_start_mutated_draft')
    check(pair(winner)==pair(stale) and winner['revision']==1 and winner['task1'] and winner['task2'], 'browser_stale_overwrite')
    check(pair(local)==pair(server) and local['revision']==2 and local['task1'] and local['task2']
          and pair(local)[:2]!=pair(winner)[:2] and pair(child['final'])==pair(local), 'browser_explicit_choice_transition')
    expected=[('A','start',0,True,'started',start),('B','draft',0,True,'saved',winner),
              ('A','draft',0,False,'revision_conflict',winner),('A','draft',1,True,'saved',local),
              ('B','draft',1,False,'revision_conflict',local)]
    for event,(label,action,base,accepted,reason,canonical) in zip(responses,expected):
        payload=event['payload'];ack=event['response']['body']['writing']
        check(event['label']==label and payload['action']==action and payload['baseRevision']==base,
              'browser_response_sequence')
        check(ack.get('accepted') is accepted and ack.get('reason')==reason and pair(ack)==pair(canonical), 'browser_ack_canonical')
        if action=='draft' and accepted:
            check((payload.get('task1'),payload.get('task2'))==pair(canonical)[:2], 'browser_saved_payload_differs')


def validate_traces(child, folder):
    # Mở ZIP trong bộ nhớ, không giải nén ra đĩa. So đúng POST và body ACK của mỗi tab.
    for index,label in enumerate(('A','B')):
        trace=folder/('trace-'+str(index)+'.zip')
        network=[]
        with zipfile.ZipFile(trace) as archive:
            check(len(archive.infolist())<=1000, 'browser_trace_entry_limit')
            for entry in archive.infolist():
                if not entry.filename.endswith('.network'):continue
                check(entry.file_size<=10_000_000, 'browser_trace_network_limit')
                for line in archive.read(entry).decode('utf-8').splitlines():
                    snapshot=json.loads(line).get('snapshot',{})
                    request=snapshot.get('request',{})
                    if not request.get('url','').split('?')[0].endswith('/api/term-tests/writing'):continue
                    check(request.get('method')=='POST', 'browser_trace_wrong_method')
                    post=request['postData'];text=post.get('text')
                    if not text:
                        reference='resources/'+post['_sha1']
                        check(archive.getinfo(reference).file_size<=1_000_000, 'browser_trace_post_limit')
                        text=archive.read(reference).decode('utf-8')
                    payload=json.loads(text)
                    response=snapshot['response']
                    content=response['content'];reference='resources/'+content['_sha1']
                    check(archive.getinfo(reference).file_size<=1_000_000, 'browser_trace_ack_limit')
                    body=json.loads(archive.read(reference))
                    network.append({'payload':payload,'response':{'status':response['status'],'body':body}})
        expected=[{'payload':e['payload'],'response':e['response']} for e in child['events']
                  if e['kind']=='api_response' and e['label']==label]
        check(network==expected and network, 'browser_trace_uuid_payload_ack_mismatch')


def validate(aggregate, ledger, ledger_hash, config, manifest, public, root):
    root=Path(root)
    check(aggregate.get('schema')=='d08-ui-production-outcome/v1' and aggregate.get('status')=='passed', 'browser_aggregate_schema')
    check(ledger.get('schema')=='d08-ui-production-ledger/v1'
          and re.fullmatch('[0-9a-f]{32}',ledger.get('run_id','')) is not None, 'browser_ledger_schema')
    entries=ledger.get('entries',[])
    check(len(entries)==7 and {e.get('case_id') for e in entries}==set(ENTRIES), 'browser_ledger_entries')
    refs=aggregate.get('children',[])
    check(len(refs)==7 and {e.get('case_id') for e in refs}==set(ENTRIES), 'browser_child_set')
    references={ref['case_id']:ref for ref in refs}
    images={t['name']:t['candidate_image'] for t in manifest['targets']}
    seen=set();erp=set()
    for entry in entries:
        client,target=ENTRIES[entry['case_id']]
        identity=entry['identity'];destination=entry['destination']
        check(identity['attempt_id']==str(uuid.UUID(identity['attempt_id'])) and identity['attempt_id'] not in seen, 'browser_uuid_duplicate')
        seen.add(identity['attempt_id'])
        check(identity['marker'].startswith('CODEX_D08_'+ledger['run_id']+'_'), 'browser_marker_run')
        for key in ('course_id','student_id'):
            if key=='course_id' and uses_existing_demo_course({'name':target,**identity}):
                check(identity.get('class_code')=='CODEXDEMO56','browser_demo_class_wrong');continue
            n=identity[key];check(type(n) is int and -2147483647<=n<=-1000000 and n not in erp, 'browser_erp_identity');erp.add(n)
        expected={'container':target,'image':images[target],'public_api_base':DESTINATIONS[target][0],'database':DESTINATIONS[target][1]}
        check(destination==expected, 'browser_ledger_destination')
        ref=references[entry['case_id']];path,raw=file_hash(root,ref['path'],ref['sha256']);child=json.loads(raw)
        check(child.get('schema')=='d08-ui-canary/v1' and child.get('scope')=='production_fixture'
              and child.get('status')=='passed' and child.get('client')==client, 'browser_offline_or_status')
        check(child.get('identity')==identity and child.get('binding')=={
            'schema':'d08-ui-bridge/v1','run_id':ledger['run_id'],'ledger_sha256':ledger_hash,
            'bundle_revision':config['product_revision'].removeprefix('d08-bundle:'),'destination':expected}, 'browser_binding_mismatch')
        assets=expected_assets(client,public)
        check(child.get('assetHashes')==assets and child.get('config_selected_api')==expected['public_api_base'], 'browser_wrong_assets_or_api')
        public_get=child.get('public_assets',{})
        check(public_get.get('status')=='passed' and set(public_get.get('assets',{}))==set(assets), 'browser_public_get_missing')
        for key,sha in assets.items():
            observation=public_get['assets'][key]
            check(observation.get('sha256')==sha and observation.get('status')==200, 'browser_public_get_mismatch')
        check(set(child.get('cases',[]))==CASES and child.get('pending_http')==0
              and type(child.get('pending_http')) is int and child.get('contexts_closed') is True and child.get('errors')==[], 'browser_cases_or_pending')
        check(child.get('producer_source_sha256')==config.get('ui_producer_sha256') and re.fullmatch('[0-9a-f]{64}',config.get('ui_producer_sha256','')), 'browser_producer_source')
        check(at(child['finished_at'])>=at(child['started_at']), 'browser_time_inverted')
        validate_events(child,identity,expected)
        cleanup=child.get('cleanup',{})
        check(cleanup.get('status')=='passed' and cleanup.get('attempt_id')==identity['attempt_id']
              and cleanup.get('marker')==identity['marker'] and cleanup.get('destination')==expected
              and cleanup.get('remaining')=={'attempt':0,'marker':0,'children':[0]*5}, 'browser_cleanup_guard')
        check(set(child.get('artifacts',{}))==ARTIFACTS, 'browser_artifacts_missing')
        for name,sha in child['artifacts'].items():file_hash(path.parent,name,sha)
        validate_traces(child,path.parent)
    return {'status':'passed','children_checked':7}
