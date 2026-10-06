"""Chụp nhất quán 13 bảng K67 và diễn tập phục hồi sang DB mới riêng.

Nguồn chỉ SELECT/pg_dump trong cùng snapshot đọc. Bản dump riêng tư giữ nguyên
ID, token, nháp, hạn, điểm và lịch sử chấm. Phục hồi chỉ DB diễn tập mới, một
transaction; đối soát từng bảng và mọi khóa ngoại trước COMMIT. Không chuyển
route, chấm lại bài, sửa nguồn hoặc xóa DB khi lỗi.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import re
import shlex
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/migration-rehearsal')
STATE=PRIVATE/'state.json'
SOURCE='mapping-postgres'
TABLES=['mini_test_result','term_test_attempt','term_test_exam_session','term_test_portal_sync_job',
    'term_test_roster','term_test_temporary_student','term_test_writing_grading_component',
    'term_test_writing_grading_criterion','term_test_writing_grading_final','term_test_writing_grading_job',
    'term_test_writing_grading_run','term_test_writing_planning','test_definition']


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def sha(raw):return hashlib.sha256(raw).hexdigest()


def schema_query():
    scope=','.join("'"+name+"'" for name in TABLES)
    return """SELECT jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,
        'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'position',a.attnum,
        'identity',a.attidentity,'default',pg_get_expr(v.adbin,v.adrelid))
        ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        LEFT JOIN pg_attrdef v ON v.adrelid=a.attrelid AND v.adnum=a.attnum
        WHERE c.relnamespace='assessment'::regnamespace AND c.relname IN ("""+scope+""")
          AND a.attnum>0 AND NOT a.attisdropped),
      'sequences',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',s.relname,'table',t.relname,
        'column',a.attname,'type',format_type(q.seqtypid,NULL),'start',q.seqstart,'increment',q.seqincrement,
        'min',q.seqmin,'max',q.seqmax,'cache',q.seqcache,'cycle',q.seqcycle) ORDER BY s.relname),'[]'::jsonb)
        FROM pg_class s JOIN pg_sequence q ON q.seqrelid=s.oid
        JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.deptype IN ('a','i')
        JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
        WHERE s.relnamespace='assessment'::regnamespace AND t.relnamespace='assessment'::regnamespace
          AND t.relname IN ("""+scope+""")),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,
        'type',k.contype,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated)
        ORDER BY c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        WHERE c.relnamespace='assessment'::regnamespace AND c.relname IN ("""+scope+""")))"""


def row_query():
    parts=[]
    for table in TABLES:
        parts.append("'"+table+"',(SELECT jsonb_build_object('count',count(*),'sha256',"
            "encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex'))"
            ' FROM assessment.'+table+' t)')
    return 'SELECT jsonb_build_object('+','.join(parts)+')'


def sql(u,client,container,database,source):
    role='mapping_admin' if container==SOURCE else 'k67_owner'
    if container!=SOURCE and not re.fullmatch('term_mini_k67_test_migration_[0-9a-f]{12}',database):
        raise RuntimeError('MIGRATION_TARGET_OUTSIDE_SCOPE')
    return u.remote(client,['docker','exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
        '-U',role,'-d',database],source.encode(),timeout=120).decode().strip()


def query(u,client,container,database,text,snapshot=None):
    begin='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'
    if snapshot:
        if not re.fullmatch('[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+',snapshot):raise RuntimeError('MIGRATION_SNAPSHOT_INVALID')
        begin+="SET TRANSACTION SNAPSHOT '"+snapshot+"';"
    begin+="SET LOCAL statement_timeout='15s'; SET LOCAL TIME ZONE 'UTC';"
    return json.loads(sql(u,client,container,database,begin+text+'; ROLLBACK;'))


def snapshot(u,h,client,refresh=False):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    if STATE.exists():
        state=json.loads(STATE.read_text(encoding='utf-8'))
        if refresh:
            if state['stage']!='snapshot_ready':raise RuntimeError('MIGRATION_REFRESH_OUTSIDE_SNAPSHOT_STAGE')
            with (PRIVATE/('state-before-refresh-'+uuid.uuid4().hex+'.json')).open('xb') as stream:stream.write(STATE.read_bytes())
            state['stage']='snapshot_intent';h.atomic(STATE,state)
        if state['stage'] not in ['snapshot_intent','snapshot_capturing']:
            directory=Path(state['snapshot'])
            if directory.parent!=PRIVATE or not re.fullmatch('snapshot-[0-9a-f]{32}',directory.name):
                raise RuntimeError('MIGRATION_SNAPSHOT_PATH_INVALID')
            raw=(directory/'snapshot.json').read_bytes()
            if sha(raw)!=state['snapshot_json_sha256']:raise RuntimeError('MIGRATION_SNAPSHOT_RECORD_CHANGED')
            if sha((directory/'assessment-data.private.sql').read_bytes())!=json.loads(raw)['dump_sha256']:
                raise RuntimeError('MIGRATION_DUMP_CHANGED')
            return {'outcome':'success','stage':state['stage'],'snapshot_reused':True,'learner_cutover':False}
    else:
        state={'intent':uuid.uuid4().hex,'target':'term_mini_k67_test_migration_'+uuid.uuid4().hex[:12],
            'stage':'snapshot_intent'};h.atomic(STATE,state)
    capture=PRIVATE/('snapshot-'+uuid.uuid4().hex);capture.mkdir()
    state['stage']='snapshot_capturing';h.atomic(STATE,state)
    # Kết nối giữ transaction nguồn mở; các lần đọc và dump nhập cùng snapshot.
    argv=['docker','exec','-i',SOURCE,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','mapping_admin','-d','mapping_db']
    incoming,out,error=client.exec_command(shlex.join(argv),timeout=180)
    try:
        incoming.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL idle_in_transaction_session_timeout='180s'; SELECT pg_export_snapshot();\n")
        incoming.flush();identity=out.readline().strip()
        if not re.fullmatch('[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+',identity):raise RuntimeError('MIGRATION_SNAPSHOT_EXPORT_FAILED')
        structure=query(u,client,SOURCE,'mapping_db',schema_query(),identity)
        rows=query(u,client,SOURCE,'mapping_db',row_query(),identity)
        dump_command=['docker','exec',SOURCE,'pg_dump','-U','mapping_admin','-d','mapping_db',
            '--data-only','--no-owner','--no-privileges','--lock-wait-timeout=5s','--snapshot='+identity]
        for table in TABLES:dump_command+=['--table=assessment.'+table]
        dump=u.remote(client,dump_command,timeout=120)
        stream_proof=restore_stream(dump,structure)
        with (capture/'assessment-data.private.sql').open('xb') as stream:stream.write(dump)
        document={'structure':structure,'rows':rows,'dump_sha256':sha(dump),'dump_bytes':len(dump),
            'sequence_values':stream_proof['sequences'],'restore_stream_sha256':sha(stream_proof['bytes']),
            'restore_timeout_headers':stream_proof['headers']}
        with (capture/'snapshot.json').open('x',encoding='utf-8') as stream:json.dump(document,stream,ensure_ascii=False,indent=2)
        state['snapshot']=str(capture);state['snapshot_json_sha256']=sha((capture/'snapshot.json').read_bytes())
        state['stage']='snapshot_ready';h.atomic(STATE,state)
        return {'outcome':'success','stage':state['stage'],'counts':{k:v['count'] for k,v in rows.items()},
            'dump_bytes':len(dump),'snapshot':str(capture),'learner_cutover':False}
    finally:
        incoming.write('ROLLBACK;\n');incoming.channel.shutdown_write()
        unused=out.read();stderr=error.read();code=out.channel.recv_exit_status()
        if code:raise RuntimeError('MIGRATION_EXPORT_SESSION_EXIT_'+str(code)+'_STDERR_BYTES_'+str(len(stderr)))


def foreign_keys_query():
    scope=','.join("'"+name+"'" for name in TABLES)
    return """SELECT coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'table',c.relname,
      'target',r.relname,'target_schema',n.nspname,'column',a.attname,'target_column',b.attname,
      'columns',cardinality(k.conkey)) ORDER BY c.relname,k.conname),'[]'::jsonb)
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class r ON r.oid=k.confrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
      JOIN pg_attribute b ON b.attrelid=k.confrelid AND b.attnum=k.confkey[1]
      WHERE k.contype='f' AND c.relnamespace='assessment'::regnamespace AND c.relname IN ("""+scope+')'


def restore_stream(raw,structure):
    # Bản sao gốc không đổi. Chỉ thay ba dòng SET0 của header bằng SET LOCAL có hạn;
    # giữ nguyên byte từng hàng COPY, không parse/serialize nháp, điểm hoặc Unicode.
    bounds={b'SET statement_timeout = 0;':b"SET LOCAL statement_timeout = '30s';",
        b'SET lock_timeout = 0;':b"SET LOCAL lock_timeout = '5s';",
        b'SET idle_in_transaction_session_timeout = 0;':b"SET LOCAL idle_in_transaction_session_timeout = '30s';"}
    headers=[];tables=[];sequences={};inside=False;result=[]
    for number,line in enumerate(raw.split(b'\n'),1):
        if inside:
            result.append(line)
            if line==b'\\.':inside=False
            continue
        match=re.fullmatch(rb'COPY assessment\.([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) FROM stdin;',line)
        if match:
            name=match[1].decode()
            if name not in TABLES or name in tables:raise RuntimeError('MIGRATION_COPY_SCOPE_INVALID')
            expected=[x['column'] for x in structure['columns'] if x['table']==name]
            if match[2].decode().split(', ')!=expected:raise RuntimeError('MIGRATION_COPY_COLUMNS_INVALID')
            tables.append(name);inside=True
        elif line in bounds:
            if tables or any(x['before']==line.decode() for x in headers):raise RuntimeError('MIGRATION_TIMEOUT_HEADER_INVALID')
            headers.append({'line':number,'before':line.decode(),'after':bounds[line].decode()});line=bounds[line]
        elif line.startswith(b'SELECT pg_catalog.setval('):
            match=re.fullmatch(rb"SELECT pg_catalog.setval\('assessment\.([a-z][a-z0-9_]*)', (-?[0-9]+), (true|false)\);",line)
            if not match or match[1].decode() in sequences:raise RuntimeError('MIGRATION_SEQUENCE_SETVAL_INVALID')
            sequences[match[1].decode()]={'last_value':int(match[2]),'is_called':match[3]==b'true'}
        result.append(line)
    if inside or sorted(tables)!=sorted(TABLES) or len(headers)!=3 \
        or set(sequences)!={x['name'] for x in structure['sequences']}:
        raise RuntimeError('MIGRATION_DUMP_SCOPE_INCOMPLETE')
    return {'bytes':b'\n'.join(result),'headers':headers,'sequences':sequences}


def foreign_keys(u,client,db,target,document):
    rows=query(u,client,db.PG,target,foreign_keys_query())
    expected=len([x for x in document['structure']['constraints'] if x['type']=='f'])
    if not expected or len(rows)!=expected \
        or any(x['columns']!=1 or x['target_schema']!='assessment' or x['target'] not in TABLES for x in rows):
        raise RuntimeError('MIGRATION_FOREIGN_KEY_SCOPE_CHANGED')
    for row in rows:
        if any(not re.fullmatch('[a-z][a-z0-9_]*',row[k]) for k in ['table','target','column','target_column']):
            raise RuntimeError('MIGRATION_FOREIGN_KEY_IDENTIFIER_INVALID')
    return rows


def readback_complete(u,client,db,target,document,foreign):
    # Cả restore mới và tiếp lại sau mất ACK đều qua cùng readback, không replay ghi.
    rows=query(u,client,db.PG,target,row_query())
    if rows!=document['rows']:raise RuntimeError('MIGRATION_ROW_READBACK_MISMATCH')
    triggers=query(u,client,db.PG,target,"SELECT jsonb_build_object('history',(SELECT count(*) FROM pg_trigger WHERE tgname IN ('collaboration_row_history','collaboration_truncate_history') AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='assessment'::regnamespace)),'disabled',(SELECT count(*) FROM pg_trigger WHERE tgenabled<>'O' AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='assessment'::regnamespace)))")
    if triggers!={'history':26,'disabled':0}:raise RuntimeError('MIGRATION_TRIGGER_READBACK_MISMATCH')
    violations=[]
    for row in foreign:
        violations.append("'"+row['name']+"',(SELECT count(*) FROM assessment."+row['table']+' a WHERE a.'+row['column']
            +' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assessment.'+row['target']+' b WHERE b.'+row['target_column']+'=a.'+row['column']+'))')
    counts=query(u,client,db.PG,target,'SELECT jsonb_build_object('+','.join(violations)+')')
    if any(counts.values()):raise RuntimeError('MIGRATION_FOREIGN_KEY_READBACK_MISMATCH')
    for name,expected in document['sequence_values'].items():
        if not re.fullmatch('[a-z][a-z0-9_]*',name):raise RuntimeError('MIGRATION_SEQUENCE_IDENTIFIER_INVALID')
        actual=query(u,client,db.PG,target,'SELECT jsonb_build_object(\'last_value\',last_value,\'is_called\',is_called) FROM assessment.'+name)
        if actual!=expected:raise RuntimeError('MIGRATION_SEQUENCE_READBACK_MISMATCH')
    return {'rows':rows,'triggers':triggers,'foreign_keys':len(foreign),'sequences':len(document['sequence_values'])}


def restore(u,h,db,client):
    state=json.loads(STATE.read_text(encoding='utf-8'));target=state['target']
    if not re.fullmatch('term_mini_k67_test_migration_[0-9a-f]{12}',target):raise RuntimeError('MIGRATION_TARGET_INVALID')
    capture=Path(state['snapshot'])
    if capture.parent!=PRIVATE or not re.fullmatch('snapshot-[0-9a-f]{32}',capture.name):raise RuntimeError('MIGRATION_SNAPSHOT_PATH_INVALID')
    raw=(capture/'snapshot.json').read_bytes()
    if sha(raw)!=state['snapshot_json_sha256']:raise RuntimeError('MIGRATION_SNAPSHOT_RECORD_CHANGED')
    document=json.loads(raw);dump=(capture/'assessment-data.private.sql').read_bytes()
    if sha(dump)!=document['dump_sha256']:raise RuntimeError('MIGRATION_DUMP_CHANGED')
    stream=restore_stream(dump,document['structure'])
    if sha(stream['bytes'])!=document['restore_stream_sha256'] or stream['headers']!=document['restore_timeout_headers'] \
        or stream['sequences']!=document['sequence_values']:raise RuntimeError('MIGRATION_RESTORE_STREAM_CHANGED')
    pg_state=json.loads(db.STATE.read_text(encoding='utf-8'))
    db.verify_container(u,client,pg_state);db.verify_schema(u,client,pg_state)
    marker='PRODUCT-TERM-MINI-K67:migration-rehearsal:'+state['intent']+':'+document['dump_sha256']
    present=json.loads(db.sql(u,client,"SELECT to_jsonb(EXISTS(SELECT 1 FROM pg_database WHERE datname='"+target+"'))"))
    if not present:
        state['stage']='database_create_intent';h.atomic(STATE,state)
        u.remote(client,['docker','exec',db.PG,'createdb','-U','k67_owner','--template=template0',target])
        state['stage']='database_created';h.atomic(STATE,state)
        sql(u,client,db.PG,target,"COMMENT ON DATABASE "+target+" IS '"+marker+"';")
    current_marker=query(u,client,db.PG,target,"SELECT to_jsonb(shobj_description(oid,'pg_database')) FROM pg_database WHERE datname=current_database()")
    if current_marker!=marker:raise RuntimeError('MIGRATION_DATABASE_MARKER_MISMATCH')
    has_schema=query(u,client,db.PG,target,"SELECT to_jsonb(EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='assessment'))")
    if not has_schema:
        # DB trống mới phải được lưu trong intent trước khi nhận cấu trúc.
        if state['stage'] not in ['database_create_intent','database_created','schema_create_intent']:
            raise RuntimeError('MIGRATION_EMPTY_DATABASE_OWNERSHIP_UNKNOWN')
        state['stage']='schema_create_intent';h.atomic(STATE,state)
        ddl=['BEGIN; SET LOCAL lock_timeout=\'5s\';']+[(ROOT/'db'/name).read_text(encoding='utf-8') for name in db.DDL]
        ddl+=["COMMENT ON DATABASE "+target+" IS '"+marker+"';",'COMMIT;']
        sql(u,client,db.PG,target,'\n'.join(ddl))
    current_marker=query(u,client,db.PG,target,"SELECT to_jsonb(shobj_description(oid,'pg_database')) FROM pg_database WHERE datname=current_database()")
    if current_marker!=marker:raise RuntimeError('MIGRATION_DATABASE_MARKER_MISMATCH')
    structure=query(u,client,db.PG,target,schema_query())
    if structure!=document['structure']:raise RuntimeError('MIGRATION_SCHEMA_CHANGED_BEFORE_COPY')
    rows=query(u,client,db.PG,target,row_query())
    foreign=foreign_keys(u,client,db,target,document)
    if rows==document['rows']:
        state['readback']=readback_complete(u,client,db,target,document,foreign)
        state['stage']='restored_verified';h.atomic(STATE,state)
        return {'outcome':'success','stage':state['stage'],'reconciled_existing_copy':True,'learner_cutover':False}
    if any(row['count'] for row in rows.values()):raise RuntimeError('MIGRATION_TARGET_NOT_EMPTY')
    transaction=["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SET LOCAL TIME ZONE 'UTC';",
        'LOCK TABLE '+','.join('assessment.'+table for table in TABLES)+' IN ACCESS EXCLUSIVE MODE;']
    for table in TABLES:
        transaction += ["DO $$ BEGIN IF EXISTS(SELECT 1 FROM assessment."+table+") THEN RAISE EXCEPTION 'MIGRATION_TARGET_NOT_EMPTY'; END IF; END $$;",
            'ALTER TABLE assessment.'+table+' DISABLE TRIGGER ALL;']
    # Dùng stream đã kiểm; artifact gốc và byte COPY được giữ nguyên.
    transaction.append(stream['bytes'].decode('utf-8'))
    for row in foreign:
        transaction.append('DO $$ BEGIN IF EXISTS(SELECT 1 FROM assessment.'+row['table']+' a WHERE a.'+row['column']
            +' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assessment.'+row['target']+' b WHERE b.'+row['target_column']
            +'=a.'+row['column']+")) THEN RAISE EXCEPTION 'MIGRATION_FOREIGN_KEY_VIOLATION'; END IF; END $$;")
    expected=json.dumps(document['rows'],sort_keys=True)
    transaction.append('DO $$ DECLARE actual jsonb; BEGIN '+row_query().replace('SELECT ','SELECT ',1)
        +' INTO actual; IF actual IS DISTINCT FROM '+"'"+expected+"'::jsonb THEN RAISE EXCEPTION 'MIGRATION_ROW_HASH_MISMATCH'; END IF; END $$;")
    transaction += ['ALTER TABLE assessment.'+table+' ENABLE TRIGGER ALL;' for table in TABLES]
    transaction.append('COMMIT;')
    state['stage']='copy_commit_intent';h.atomic(STATE,state)
    sql(u,client,db.PG,target,'\n'.join(transaction))
    readback=readback_complete(u,client,db,target,document,foreign)
    state['stage']='restored_verified';state['readback']=readback;h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'target':target,'tables':len(readback['rows']),'foreign_keys':len(foreign),
        'counts':{k:v['count'] for k,v in readback['rows'].items()},'triggers':readback['triggers'],
        'sequences':readback['sequences'],'learner_cutover':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);group=parser.add_mutually_exclusive_group()
    group.add_argument('--restore',action='store_true');group.add_argument('--refresh-snapshot',action='store_true');args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    context=load('context_guard','prepare-context-source.py');db=load('production_database','prepare-production-database.py');client=u.connect()
    try:
        operation=lambda:restore(u,h,db,client) if args.restore else snapshot(u,h,client,args.refresh_snapshot)
        return context.run_guarded(u,h,client,operation,PRIVATE,with_catalog=True,caller_path=Path(__file__))
    finally:client.close()


if __name__=='__main__':sys.exit(main())
