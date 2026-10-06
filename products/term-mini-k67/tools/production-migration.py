"""Một chủ ghi: HOLD K67 → tắt parent nguồn → fence → snapshot → kho riêng.

Không ghi đè kho đích có bài; mất ACK chỉ đối soát, không chấm lại lịch sử.
Giữ dump gốc riêng tư và kiểm hash13 bảng/FK/trigger/sequence trước mở tuyến.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import re
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-migration')
STATE=PRIVATE/'state.json'
PARENTS=['DHUgPXJdCfVZWj56','SGtuBV91Yc9oxEVt']

def load(name,file,base='tools'):
    spec=importlib.util.spec_from_file_location(name,ROOT/base/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def sdk(p,payload,label):
    return json.loads(p.call([p.NODE,str(ROOT/'ops/cutover-workflows.mjs')],label,json.dumps(payload,ensure_ascii=False).encode()))

def stop_parents(p,h,state):
    state.setdefault('source_parents',{})
    for identity in PARENTS:
        payload={'lane':'source','profile':'default','sourceId':identity,'active':False}
        saved=state['source_parents'].get(identity)
        if saved is None:
            before=sdk(p,{**payload,'operation':'snapshot'},'source-stop-backup')['workflow']
            # Bản nguồn phải còn đúng revision đã khảo sát và export ở gói nguồn.
            pin=next(x for x in json.loads((ROOT/'ops/grading-source-lock.json').read_bytes())['workflows'] if x['id']==identity)
            if before['versionId']!=pin['versionId'] or before['active'] is not True:raise RuntimeError('K67_SOURCE_PARENT_REVISION_CHANGED')
            path=PRIVATE/('parent-before-'+identity+'.private.json')
            if path.exists():
                if json.loads(path.read_bytes())!=before:raise RuntimeError('K67_SOURCE_PARENT_BACKUP_CHANGED')
            else:
                with path.open('x',encoding='utf-8') as stream:json.dump(before,stream,ensure_ascii=False)
            saved={'before':str(path),'stage':'prepared'};state['source_parents'][identity]=saved;h.atomic(STATE,state)
        before=json.loads(Path(saved['before']).read_bytes())
        observed=sdk(p,{**payload,'operation':'inspect','before':before},'source-stop-inspect')['workflow']
        if observed['active']:
            if saved['stage']!='prepared':raise RuntimeError('K67_SOURCE_STOP_OUTCOME_UNKNOWN')
            saved['stage']='stop_intent';h.atomic(STATE,state)
            try:sdk(p,{**payload,'operation':'set_active','before':before},'source-stop-mutation')
            except Exception:
                # GET duy nhất để xác minh phản hồi bị mất; không lặp POST.
                observed=sdk(p,{**payload,'operation':'inspect','before':before},'source-stop-reconcile')['workflow']
                if observed['active']:raise RuntimeError('K67_SOURCE_STOP_OUTCOME_UNKNOWN')
        after=sdk(p,{**payload,'operation':'inspect','before':before},'source-stop-readback')['workflow']
        if after['active']:raise RuntimeError('K67_SOURCE_PARENT_STILL_ACTIVE')
        saved['stage']='stopped_verified';saved['after_version']=after['versionId'];h.atomic(STATE,state)

def drained(p,s,u,client):
    status=s.query(u,client,"""SELECT jsonb_build_object(
      'listening',(SELECT count(*) FROM assessment.term_test_exam_session WHERE superseded_at IS NULL AND listening_started_at IS NOT NULL AND listening_submitted_at IS NULL AND listening_deadline_at>now()),
      'reading',(SELECT count(*) FROM assessment.term_test_attempt WHERE superseded_at IS NULL AND reading_started_at IS NOT NULL AND reading_submitted_at IS NULL AND reading_deadline_at>now()),
      'writing',(SELECT count(*) FROM assessment.term_test_attempt WHERE superseded_at IS NULL AND writing_started_at IS NOT NULL AND writing_submitted_at IS NULL AND writing_deadline_at>now()),
      'grading',(SELECT count(*) FROM assessment.term_test_writing_grading_job WHERE status IN ('queued','retry_wait','processing')),
      'portal',(SELECT count(*) FROM assessment.term_test_portal_sync_job WHERE status IN ('pending','retry','processing')))""")
    if any(status.values()):raise RuntimeError('K67_SOURCE_NOT_DRAINED')
    for identity in PARENTS:
        for execution_status in ['running','waiting']:
            result=p.ctl('default','execution','list','--workflow',identity,'--status',execution_status,'--limit','20',label='source-drain')
            if not isinstance(result,list) or result:raise RuntimeError('K67_SOURCE_EXECUTION_NOT_DRAINED')
    return status

def production_sql(u,client,container,database,text):
    if (container,database)==('mapping-postgres','mapping_db'):role='mapping_admin'
    elif (container,database)==('term-mini-k67-postgres','term_mini_k67'):role='k67_owner'
    else:raise RuntimeError('K67_PRODUCTION_MIGRATION_TARGET_OUTSIDE_SCOPE')
    return u.remote(client,['docker','exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
      '-U',role,'-d',database],text.encode(),timeout=120).decode().strip()

def migration_module():
    m=load('final_migration_util','rehearse-migration.py')
    m.sql=production_sql;m.PRIVATE=PRIVATE;m.STATE=STATE
    return m

def document(state,m):
    if state['target']!='term_mini_k67' or state['container']!='term-mini-k67-postgres' or not re.fullmatch('[a-f0-9]{32}',state['intent']):
        raise RuntimeError('K67_FINAL_COPY_STATE_TARGET_CHANGED')
    capture=Path(state['snapshot'])
    if capture.parent!=PRIVATE or not re.fullmatch('snapshot-[a-f0-9]{32}',capture.name):raise RuntimeError('K67_FINAL_COPY_SNAPSHOT_PATH_CHANGED')
    raw=(capture/'snapshot.json').read_bytes()
    if m.sha(raw)!=state['snapshot_json_sha256']:raise RuntimeError('K67_FINAL_COPY_SNAPSHOT_CHANGED')
    doc=json.loads(raw);dump=(capture/'assessment-data.private.sql').read_bytes()
    if m.sha(dump)!=doc['dump_sha256']:raise RuntimeError('K67_FINAL_COPY_DUMP_CHANGED')
    stream=m.restore_stream(dump,doc['structure'])
    if m.sha(stream['bytes'])!=doc['restore_stream_sha256']:raise RuntimeError('K67_FINAL_COPY_STREAM_CHANGED')
    return doc,stream

def verify_copy(u,client,db,s,f):
    state=json.loads(STATE.read_bytes());m=migration_module()
    if state['stage']!='restored_verified':raise RuntimeError('K67_FINAL_COPY_NOT_VERIFIED')
    doc,stream=document(state,m)
    dbstate=json.loads(db.STATE.read_bytes());db.verify_container(u,client,dbstate);db.verify_schema(u,client,dbstate)
    f.verify(s.query(u,client,f.inspect_query()),m.TABLES,state['intent'])
    if s.query(u,client,m.row_query())!=doc['rows']:raise RuntimeError('K67_SOURCE_CHANGED_AFTER_SNAPSHOT')
    if m.query(u,client,db.PG,db.DATABASE,m.schema_query())!=doc['structure']:raise RuntimeError('K67_FINAL_COPY_SCHEMA_CHANGED')
    foreign=m.foreign_keys(u,client,db,db.DATABASE,doc)
    return m.readback_complete(u,client,db,db.DATABASE,doc,foreign)

def restore(u,h,client,db,m,state):
    doc,stream=document(state,m)
    dbstate=json.loads(db.STATE.read_bytes());db.verify_container(u,client,dbstate);db.verify_schema(u,client,dbstate)
    if m.query(u,client,db.PG,db.DATABASE,m.schema_query())!=doc['structure']:raise RuntimeError('K67_FINAL_COPY_SCHEMA_MISMATCH')
    rows=m.query(u,client,db.PG,db.DATABASE,m.row_query())
    foreign=m.foreign_keys(u,client,db,db.DATABASE,doc)
    if rows!=doc['rows']:
        if any(v['count'] for v in rows.values()):raise RuntimeError('K67_FINAL_COPY_TARGET_NOT_EMPTY')
        commands=["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SET LOCAL TIME ZONE 'UTC';",
          'LOCK TABLE '+','.join('assessment.'+t for t in m.TABLES)+' IN ACCESS EXCLUSIVE MODE;']
        for table in m.TABLES:
            commands += ["DO $$ BEGIN IF EXISTS(SELECT 1 FROM assessment."+table+") THEN RAISE EXCEPTION 'K67_FINAL_COPY_TARGET_NOT_EMPTY'; END IF; END $$;",
              'ALTER TABLE assessment.'+table+' DISABLE TRIGGER ALL;']
        commands.append(stream['bytes'].decode('utf-8'))
        for row in foreign:
            commands.append('DO $$ BEGIN IF EXISTS(SELECT 1 FROM assessment.'+row['table']+' a WHERE a.'+row['column']
              +' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assessment.'+row['target']+' b WHERE b.'+row['target_column']
              +'=a.'+row['column']+")) THEN RAISE EXCEPTION 'K67_FINAL_COPY_FOREIGN_KEY_VIOLATION'; END IF; END $$;")
        commands.append("DO $$ DECLARE actual jsonb; BEGIN "+m.row_query()+" INTO actual; IF actual IS DISTINCT FROM '"
          +json.dumps(doc['rows'],sort_keys=True)+"'::jsonb THEN RAISE EXCEPTION 'K67_FINAL_COPY_ROW_HASH_MISMATCH'; END IF; END $$;")
        commands += ['ALTER TABLE assessment.'+t+' ENABLE TRIGGER ALL;' for t in m.TABLES];commands.append('COMMIT;')
        state['stage']='copy_commit_intent';h.atomic(STATE,state)
        production_sql(u,client,db.PG,db.DATABASE,'\n'.join(commands))
    readback=m.readback_complete(u,client,db,db.DATABASE,doc,foreign)
    state['stage']='restored_verified';state['readback']=readback;h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'tables':13,'foreign_keys':len(foreign),
      'triggers':readback['triggers'],'counts':{k:v['count'] for k,v in readback['rows'].items()},'learner_cutover':False}

def perform(u,h,p,s,f,db,client):
    route=load('legacy_routing','apply-legacy-cutover.py')
    if json.loads(route.STATE.read_bytes())['stage']!='holding':raise RuntimeError('K67_FINAL_COPY_ROUTES_NOT_HOLDING')
    PRIVATE.mkdir(parents=True,exist_ok=True);m=migration_module()
    if STATE.exists():state=json.loads(STATE.read_bytes())
    else:
        state={'intent':uuid.uuid4().hex,'target':db.DATABASE,'container':db.PG,'stage':'parents_stop_intent'};h.atomic(STATE,state)
    if state['stage']=='restored_verified':
        proof=verify_copy(u,client,db,s,f)
        return {'outcome':'success','stage':state['stage'],'tables':len(proof['rows']),'reused':True,'learner_cutover':False}
    stop_parents(p,h,state);state=json.loads(STATE.read_bytes())
    if state['stage'] in ['parents_stop_intent','fence_commit_intent']:
        drained(p,s,u,client)
        present=s.query(u,client,f.inspect_query())
        if not present['namespace']:
            if present['triggers'] or present['function']:raise RuntimeError('K67_FENCE_FOREIGN_OBJECT')
            state['stage']='fence_commit_intent';h.atomic(STATE,state)
            # Khóa 13 bảng rồi kiểm lại drain ngay trong transaction chống request đang ghi.
            assert_drained="""DO $$ BEGIN IF
              EXISTS(SELECT 1 FROM assessment.term_test_writing_grading_job WHERE status IN ('queued','retry_wait','processing'))
              OR EXISTS(SELECT 1 FROM assessment.term_test_portal_sync_job WHERE status IN ('pending','retry','processing'))
              OR EXISTS(SELECT 1 FROM assessment.term_test_exam_session WHERE superseded_at IS NULL AND listening_started_at IS NOT NULL AND listening_submitted_at IS NULL AND listening_deadline_at>now())
              OR EXISTS(SELECT 1 FROM assessment.term_test_attempt WHERE superseded_at IS NULL AND reading_started_at IS NOT NULL AND reading_submitted_at IS NULL AND reading_deadline_at>now())
              OR EXISTS(SELECT 1 FROM assessment.term_test_attempt WHERE superseded_at IS NULL AND writing_started_at IS NOT NULL AND writing_submitted_at IS NULL AND writing_deadline_at>now())
              THEN RAISE EXCEPTION 'K67_SOURCE_NOT_DRAINED'; END IF; END $$;"""
            sql="BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'; LOCK TABLE "+','.join('assessment.'+t for t in m.TABLES)+' IN ACCESS EXCLUSIVE MODE;\n'+assert_drained+'\n'+f.install(m.TABLES,state['intent'])+'\nCOMMIT;'
            s.sql(u,client,sql)
        f.verify(s.query(u,client,f.inspect_query()),m.TABLES,state['intent'])
        state['stage']='snapshot_intent';h.atomic(STATE,state)
    f.verify(s.query(u,client,f.inspect_query()),m.TABLES,state['intent'])
    if state['stage'] in ['snapshot_intent','snapshot_capturing']:
        m.snapshot(u,h,client);state=json.loads(STATE.read_bytes())
    if state['stage'] not in ['snapshot_ready','copy_commit_intent']:raise RuntimeError('K67_FINAL_COPY_STAGE_UNKNOWN')
    result=restore(u,h,client,db,m,state);verify_copy(u,client,db,s,f)
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--verify-only',action='store_true');args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py');p=load('grading','provision-grading-bundle.py')
    s=load('guard','prepare-context-source.py');f=load('source_fence','source-fence.py','ops');db=load('production_db','prepare-production-database.py')
    lock=load('grading_lock','prepare-grading-fixture.py');PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:
            def operation():
                if args.verify_only:
                    proof=verify_copy(u,client,db,s,f)
                    return {'outcome':'success','stage':'restored_verified','tables':len(proof['rows']),'read_only':True,'learner_cutover':False}
                return perform(u,h,p,s,f,db,client)
            return s.run_guarded(u,h,client,operation,PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
