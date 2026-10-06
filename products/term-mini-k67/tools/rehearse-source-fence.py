"""Diễn tập chặn ghi nguồn K67 trong transaction rồi rollback toàn bộ DDL/DML.

39 câu INSERT/UPDATE/DELETE rỗng và một TRUNCATE bị chặn đúng mã. UPDATE rỗng
ở bảng K56 và Writing vẫn chạy. Không ghi/xóa dữ liệu hay để fence tồn tại.
"""
from pathlib import Path
import importlib.util
import json
import shlex
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/source-fence-rehearsal')

def load(name,file,base='tools'):
    spec=importlib.util.spec_from_file_location(name,ROOT/base/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def rehearse(u,source,m,f,client):
    before=source.query(u,client,f.inspect_query())
    if before!={'namespace':False,'marker':None,'function':None,'triggers':[]}:raise RuntimeError('K67_FENCE_ALREADY_PRESENT')
    structure=source.query(u,client,m.schema_query())
    outside=source.query(u,client,"""SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'column',a.attname) ORDER BY n.nspname,c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN LATERAL (SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0
        AND NOT attisdropped AND attgenerated='' AND attidentity<>'a' ORDER BY attnum LIMIT 1) a ON true
      WHERE c.relkind='r' AND (n.nspname='assessment_k56' OR (n.nspname='assessment' AND c.relname NOT IN ("""
      +','.join("'"+t+"'" for t in m.TABLES)+')))')
    if not outside or len([x for x in outside if x['schema']=='assessment'])!=5 \
      or not any(x['schema']=='assessment_k56' for x in outside):raise RuntimeError('K67_FENCE_OUTSIDE_SCOPE_CHANGED')
    intent=uuid.uuid4().hex
    statements=["BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';",f.install(m.TABLES,intent)]
    for table in m.TABLES:
        column=next(x['column'] for x in structure['columns'] if x['table']==table and x['identity']!='a')
        full='assessment.'+table
        statements += [f.assert_block('INSERT INTO '+full+' ('+column+') SELECT '+column+' FROM '+full+' WHERE false'),
          f.assert_block('UPDATE '+full+' SET '+column+'='+column+' WHERE false'),f.assert_block('DELETE FROM '+full+' WHERE false')]
    statements.append(f.assert_block('TRUNCATE '+','.join('assessment.'+t for t in m.TABLES)))
    for row in outside:
        statements.append('UPDATE '+row['schema']+'.'+row['table']+' SET '+row['column']+'='+row['column']+' WHERE false;')
    statements += [f.inspect_query()+';','ROLLBACK;']
    incoming,out,error=client.exec_command(shlex.join(['docker','exec','-i',source.PG,'psql','-X','-qAt',
      '-v','ON_ERROR_STOP=1','-U','mapping_admin','-d','mapping_db']),timeout=60)
    incoming.write('\n'.join(statements).encode());incoming.flush();incoming.channel.shutdown_write()
    raw=out.read();stderr=error.read();code=out.channel.recv_exit_status()
    if code:
        PRIVATE.mkdir(parents=True,exist_ok=True)
        with (PRIVATE/('sql-error-'+uuid.uuid4().hex+'.txt')).open('xb') as stream:stream.write(stderr)
        # SQL diễn tập chỉ chứa tên bảng/cột; lấy đúng dòng ERROR, không in context.
        message=next((line for line in stderr.decode().splitlines() if line.startswith('ERROR:')),'SQL_ERROR_UNKNOWN')
        raise RuntimeError(message)
    result=json.loads(raw)
    f.verify(result,m.TABLES,intent)
    if source.query(u,client,f.inspect_query())!=before:raise RuntimeError('K67_FENCE_ROLLBACK_NOT_OBSERVED')
    return {'outcome':'success','blocked_statements':40,'outside_tables_allowed':len(outside),
      'writing_tables_allowed':5,'rollback_observed':True,'learner_cutover':False}

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    s=load('context_guard','prepare-context-source.py');m=load('migration','rehearse-migration.py')
    f=load('source_fence','source-fence.py','ops');client=u.connect()
    try:return s.run_guarded(u,h,client,lambda:rehearse(u,s,m,f,client),PRIVATE,with_catalog=True,caller_path=Path(__file__))
    finally:client.close()

if __name__=='__main__':sys.exit(main())
