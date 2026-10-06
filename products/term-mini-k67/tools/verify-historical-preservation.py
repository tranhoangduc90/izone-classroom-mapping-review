"""Đối soát dữ liệu lịch sử sau mô phỏng, không đọc/in bài hay token.

Loại đúng ba học viên/attempt giả mới và các run/job con của chúng khỏi hash.
Phần còn lại phải khớp từng bảng với snapshot cuối; nguồn phải còn nguyên.
"""
from pathlib import Path
import importlib.util
import json
import sys

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/historical-preservation')
def load(name,file,base='tools'):
    s=importlib.util.spec_from_file_location(name,ROOT/base/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def verify(u,db,s,f,final,client):
    state=json.loads(final.STATE.read_bytes());m=final.migration_module();doc,stream=final.document(state,m)
    fake=json.loads((PRIVATE.parent/'production-journeys/state.json').read_bytes())
    if fake['stage']!='verified':raise RuntimeError('K67_HISTORY_SIMULATION_NOT_VERIFIED')
    attempts=','.join("'"+x+"'::uuid" for x in fake['attempts'].values())
    students=','.join(str(x['id']) for x in fake['students'].values())
    f.verify(s.query(u,client,f.inspect_query()),m.TABLES,state['intent'])
    if s.query(u,client,m.row_query())!=doc['rows']:raise RuntimeError('K67_HISTORY_SOURCE_CHANGED')
    query=m.row_query()
    for table in m.TABLES:
        condition=None
        if table in ['term_test_roster','term_test_attempt','term_test_exam_session']:condition='erp_student_contact_id NOT IN ('+students+')'
        elif table in ['term_test_writing_grading_run','term_test_writing_grading_final','term_test_writing_planning']:condition='attempt_id NOT IN ('+attempts+')'
        elif table in ['term_test_writing_grading_job','term_test_writing_grading_component','term_test_writing_grading_criterion']:
            condition='run_id NOT IN (SELECT id FROM assessment.term_test_writing_grading_run WHERE attempt_id IN ('+attempts+'))'
        if condition:
            before=' FROM assessment.'+table+' t)'
            if query.count(before)!=1:raise RuntimeError('K67_HISTORY_QUERY_SCOPE_CHANGED')
            query=query.replace(before,' FROM assessment.'+table+' t WHERE '+condition+')')
    observed=m.query(u,client,db.PG,db.DATABASE,query)
    if observed!=doc['rows']:raise RuntimeError('K67_HISTORY_TARGET_OLD_ROWS_CHANGED')
    # Kiểm mọi FK sau khi đã có dữ liệu mới; kiểm không có trigger bị tắt.
    foreign=m.foreign_keys(u,client,db,db.DATABASE,doc)
    violations=[]
    for row in foreign:
        violations.append("'"+row['name']+"',(SELECT count(*) FROM assessment."+row['table']+' a WHERE a.'+row['column']+' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assessment.'+row['target']+' b WHERE b.'+row['target_column']+'=a.'+row['column']+'))')
    if any(m.query(u,client,db.PG,db.DATABASE,'SELECT jsonb_build_object('+','.join(violations)+')').values()):
        raise RuntimeError('K67_HISTORY_NEW_FOREIGN_KEY_VIOLATION')
    disabled=db.query(u,client,"SELECT to_jsonb(count(*)) FROM pg_trigger WHERE tgenabled<>'O' AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='assessment'::regnamespace)")
    if disabled:raise RuntimeError('K67_HISTORY_TRIGGER_DISABLED')
    return {'outcome':'success','historical_tables_equal':13,'source_equal':True,'new_foreign_keys_valid':len(foreign),'disabled_triggers':0,'learner_cutover':True}

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py');db=load('production_db','prepare-production-database.py')
    s=load('guard','prepare-context-source.py');f=load('source_fence','source-fence.py','ops');final=load('final_migration','production-migration.py');client=u.connect()
    try:return s.run_guarded(u,h,client,lambda:verify(u,db,s,f,final,client),PRIVATE,caller_path=Path(__file__))
    finally:client.close()

if __name__=='__main__':sys.exit(main())
