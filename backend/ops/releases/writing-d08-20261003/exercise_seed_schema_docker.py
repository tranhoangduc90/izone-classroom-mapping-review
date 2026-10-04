"""Thử SQL seed API/UI nguyên văn với CHECK thật trong PostgreSQL owned.
Nhận SQL đã trích từ producer base/head; giữ database production nguyên trạng.
Kết quả phân biệt SQL bị CHECK chặn và seed đúng, kèm readback/cleanup.
"""
import json
import subprocess
import time
import uuid
import canary_remote as c
import release_remote as r
from real_attempt_schema import real_attempt_ddl

def run(packet):
    owner=uuid.uuid4().hex;owned_name='izone-d08-seed-'+owner[:12]
    labels={'codex.task':'writing-d08-seed-regression','codex.fixture':owner}
    identifier=r.api('POST','/containers/create?name='+owned_name,{
        'Image':'sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28',
        'Env':['POSTGRES_DB=mapping_db','POSTGRES_HOST_AUTH_METHOD=trust'],'Labels':labels,
        'HostConfig':{'NetworkMode':'none','Memory':268435456,'PidsLimit':128,'Tmpfs':{'/var/lib/postgresql/data':'rw,nosuid,size=192m'}}})['Id']
    def sql(database,text):
        return subprocess.run(['docker','exec','-i',identifier,'psql','-h','127.0.0.1','-At','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],input=text,text=True,encoding='utf-8',capture_output=True,timeout=60)
    rows=[]
    try:
        r.api('POST','/containers/'+identifier+'/start')
        for _ in range(30):
            ready=subprocess.run(['docker','exec',identifier,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True,timeout=10)
            if ready.returncode==0:break
            time.sleep(1)
        else:raise RuntimeError('seed_pg_not_ready')
        created=subprocess.run(['docker','exec',identifier,'createdb','-h','127.0.0.1','-U','postgres','izone_mapping_demo'],capture_output=True,timeout=30)
        if created.returncode:raise RuntimeError('seed_demo_db_not_created')
        for name in c.NAMES:
            item={'name':name};schema,_,database=c.destination(item)
            ddl=f"CREATE SCHEMA {schema}; CREATE TABLE {schema}.test_definition(slug text PRIMARY KEY,title text,version int); INSERT INTO {schema}.test_definition VALUES('term-test-1','Synthetic',1),('term-test-1-k56','Synthetic',1);"
            ddl+=real_attempt_ddl(packet['contract'],item)
            ddl+="CREATE SCHEMA IF NOT EXISTS mapping; CREATE TABLE IF NOT EXISTS mapping.classroom_course_mapping(erp_course_class_id bigint PRIMARY KEY, erp_class_name_snapshot text); INSERT INTO mapping.classroom_course_mapping VALUES(-560001,'CODEXDEMO56') ON CONFLICT DO NOTHING;"
            value=sql(database,ddl)
            if value.returncode:raise RuntimeError('seed_real_ddl_failed:'+value.stderr[:250])
        for entry in packet['seeds']:
            item=entry['identity'];schema,_,database=c.destination(item)
            value=sql(database,'\\set VERBOSITY verbose\n'+entry['sql'])
            accepted=value.returncode==0
            expected=entry['epoch']=='head' or item['name']==c.NAMES[0]
            if accepted!=expected or (not accepted and '23514' not in value.stderr):
                raise RuntimeError('seed_regression_unexpected:'+entry['case_id']+':'+value.stderr[:250])
            read=sql(database,f"SELECT jsonb_build_object('count',count(*),'valid',COALESCE(bool_and(listening_submitted_at IS NOT NULL AND reading_submitted_at IS NOT NULL AND completed_at IS NOT NULL AND listening_result IS NOT NULL AND reading_result IS NOT NULL AND combined_result IS NOT NULL AND writing_submitted_at IS NULL AND exam_session_id IS NULL AND writing_draft_revision=0),false))::text FROM {schema}.term_test_attempt WHERE id='{item['attempt_id']}'::uuid;")
            parsed=[json.loads(line) for line in read.stdout.splitlines() if line.startswith('{')]
            expected_valid=accepted and entry['epoch']=='head'
            if read.returncode or parsed!=[{'count':int(accepted),'valid':expected_valid}]:raise RuntimeError('seed_readback_failed:'+entry['case_id'])
            cleanup=sql(database,c.cleanup_sql(item))
            clean=[json.loads(line) for line in cleanup.stdout.splitlines() if line.startswith('{')]
            if cleanup.returncode or clean!=[{'removed':int(accepted)},{'attempt_remaining':0,'marker_remaining':0,'children_remaining':0}]:raise RuntimeError('seed_cleanup_failed')
            rows.append({'case_id':entry['case_id'],'epoch':entry['epoch'],'target':item['name'],'producer':entry['producer'],'accepted':accepted,'sqlstate':None if accepted else '23514','readback':parsed[0],'cleanup':clean,'seed_sql_sha256':entry['sql_sha256']})
        return {'status':'passed_regression','base_status':'RED','head_status':'GREEN','cases':rows,'production_database_used':False,'production_environment_used':False,'audit_trigger_in_fixture':False}
    finally:
        owned=r.inspect(identifier)
        if owned['Name']!='/'+owned_name or owned['Config'].get('Labels',{}).get('codex.fixture')!=owner:raise RuntimeError('seed_cleanup_identity_failed')
        if owned['State']['Running']:r.api('POST','/containers/'+identifier+'/stop?t=30')
        r.api('DELETE','/containers/'+identifier+'?v=true')
        if any(i.get('Labels',{}).get('codex.fixture')==owner for i in r.api('GET','/containers/json?all=true')):raise RuntimeError('seed_container_cleanup_failed')
