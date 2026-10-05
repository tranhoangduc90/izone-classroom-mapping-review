"""Kiểm guard phiên thi bằng PostgreSQL thật và helper Docker thật.
Tạo mạng Internal/DB/Env giả riêng, không truy cập DB production hoặc bài thật.
Nhận manifest qua stdin; fixture đếm phiên ba môn, deadlineNULL và nộp bù.
Lỗi giữ exit nonzero; cleanup chỉ chọn object có UUID/label riêng.
"""
import copy
import json
import subprocess
import time
import uuid
import release_remote as r


def command(argv,stdin=None):
    result=subprocess.run(argv,input=stdin,text=True,encoding='utf-8',capture_output=True,timeout=60)
    if result.returncode:
        raise RuntimeError('fixture_command_failed:'+str(result.returncode)+':'+result.stderr.strip()[:500])
    return result.stdout


def exercise(manifest):
    owner=uuid.uuid4().hex
    name='izone-d08-activity-pg-'+owner[:12]
    labels={'codex.task':'writing-d08-activity-fixture','codex.fixture':owner}
    image='sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28'
    # Image đã có từ PG contention fixture, không pull hoặc cài package.
    if json.loads(command(['docker','image','inspect',image]))[0]['Id']!=image:
        raise RuntimeError('postgres_fixture_image_mismatch')
    network=r.api('POST','/networks/create',{'Name':name,'Driver':'bridge','Internal':True,'Labels':labels})['Id']
    identifier=None
    receipts=[]
    try:
        identifier=r.api('POST','/containers/create?name='+name,{
            'Image':image,'Env':['POSTGRES_DB=mapping_db','POSTGRES_HOST_AUTH_METHOD=trust'],
            'Labels':labels,'HostConfig':{'NetworkMode':name,'Memory':268435456,'PidsLimit':128,'Tmpfs':{'/var/lib/postgresql/data':'rw,nosuid,size=192m'}},
            'NetworkingConfig':{'EndpointsConfig':{name:{'Aliases':[name]}}}
        })['Id']
        r.api('POST','/containers/'+identifier+'/start')
        for _ in range(30):
            ready=subprocess.run(['docker','exec',identifier,'pg_isready','-h','127.0.0.1','-U','postgres','-d','mapping_db'],capture_output=True,timeout=10)
            if ready.returncode==0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('postgres_fixture_not_ready')
        command(['docker','exec',identifier,'createdb','-h','127.0.0.1','-U','postgres','izone_mapping_demo'])
        ddl="""CREATE SCHEMA __SCHEMA__;
        CREATE TABLE __SCHEMA__.term_test_exam_session(
         superseded_at timestamptz,listening_started_at timestamptz,
         listening_submitted_at timestamptz,listening_deadline_at timestamptz);
        CREATE TABLE __SCHEMA__.term_test_attempt(
         superseded_at timestamptz,reading_started_at timestamptz,
         reading_submitted_at timestamptz,reading_deadline_at timestamptz,
         writing_started_at timestamptz,writing_submitted_at timestamptz,writing_deadline_at timestamptz);
        """
        for index,source_target in enumerate(manifest['targets']):
            target=copy.deepcopy(source_target)
            schema='assessment_k56' if target['name']=='izone-k56-ic2264-api' else 'assessment'
            target['schema']=schema
            database='izone_mapping_demo' if 'demo' in target['name'] else 'mapping_db'
            def sql(text):
                return command(['docker','exec','-i',identifier,'psql','-h','127.0.0.1','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-q'],text)
            sql(ddl.replace('__SCHEMA__',schema))
            old={'Image':target['base_image'],'Config':{'Env':['DATABASE_URL=postgresql://postgres@'+name+':5432/'+database]},'NetworkSettings':{'Networks':{name:{'Aliases':[]}}}}
            def check(case,expected):
                result=r.stopped_activity(target,old)
                if result['active']!=expected:
                    raise AssertionError((case,result,expected))
                receipts.append({'target':target['name'],'case':case,'active':result['active'],'status':'passed'})
            check('empty',0)
            for skill in ('listening','reading','writing'):
                table=schema+'.'+('term_test_exam_session' if skill=='listening' else 'term_test_attempt')
                for case,deadline,submitted,superseded,expected in (
                    ('active',"clock_timestamp()+interval '1 hour'",'NULL','NULL',1),
                    ('missing_deadline','NULL','NULL','NULL',1),
                    ('submission_grace',"clock_timestamp()-interval '2 minutes'",'NULL','NULL',1),
                    ('expired',"clock_timestamp()-interval '6 minutes'",'NULL','NULL',0),
                    ('submitted',"clock_timestamp()+interval '1 hour'",'clock_timestamp()','NULL',0),
                    ('superseded',"clock_timestamp()+interval '1 hour'",'NULL','clock_timestamp()',0),
                ):
                    sql('TRUNCATE '+schema+'.term_test_attempt,'+schema+'.term_test_exam_session; INSERT INTO '+table+' ('+skill+'_started_at,'+skill+'_deadline_at,'+skill+'_submitted_at,superseded_at) VALUES(clock_timestamp(),'+deadline+','+submitted+','+superseded+');')
                    check(skill+':'+case,expected)
            # Helper phải chặn nhầm database, dù schema giả có thể mang cùng tên.
            wrong=copy.deepcopy(old)
            wrong['Config']['Env']=['DATABASE_URL=postgresql://postgres@'+name+':5432/postgres']
            try:
                r.stopped_activity(target,wrong)
            except RuntimeError as error:
                if str(error)!='activity_readback_failed':
                    raise
                receipts.append({'target':target['name'],'case':'wrong_database_blocked','status':'passed'})
            else:
                raise AssertionError('Wrong database accepted')
        return {'status':'passed','tests':len(receipts),'receipts':receipts,'postgres_image':image,'production_env_used':False,'production_database_used':False,'helper_entrypoint':'Node readonly query only, no server/worker','cleanup':'verified_after_finally'}
    finally:
        if identifier:
            item=r.inspect(identifier)
            if item['Config'].get('Labels',{}).get('codex.fixture')!=owner or item['Name']!='/'+name:
                raise RuntimeError('fixture_pg_cleanup_guard_failed')
            if item['State']['Running']:
                r.api('POST','/containers/'+identifier+'/stop?t=15')
            r.api('DELETE','/containers/'+identifier+'?v=true')
        item=r.api('GET','/networks/'+network)
        if item.get('Labels',{}).get('codex.fixture')!=owner or item.get('Containers'):
            raise RuntimeError('fixture_activity_network_cleanup_guard_failed')
        r.api('DELETE','/networks/'+network)
        remaining=[row for row in r.api('GET','/containers/json?all=true') if row.get('Labels',{}).get('codex.fixture')==owner]
        if remaining:
            raise RuntimeError('fixture_activity_cleanup_incomplete')


if __name__=='__main__':
    import sys
    print(json.dumps(exercise(json.load(sys.stdin)),ensure_ascii=False))
