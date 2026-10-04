"""Chạy producer canary trên ba image candidate + PostgreSQL thật trong mạng Internal.
Env/DB/UUID giả; API dùng createApp thật, không server.js hoặc worker production.
Kiểm HTTP/SQL và cleanup guard thật; bộ đếm AI/Portal giả vẫn phải bằng0.
Không dùng receipt này thay quan sát production hoặc giao diện đã phát hành.
"""
import json
import subprocess
import time
import uuid
import canary_remote as c
import release_remote as r


def command(argv, text=None):
    value = subprocess.run(argv,input=text,text=True,encoding='utf-8',capture_output=True,timeout=180)
    if value.returncode:
        raise RuntimeError('owned_fixture_command_failed:' + str(value.returncode) + ':' + value.stderr[:300])
    return value.stdout


def exercise(manifest, core, ui_driver=None):
    owner = uuid.uuid4().hex
    name = 'izone-d08-canary-fixture-' + owner[:12]
    labels = {'codex.task':'writing-d08-canary-fixture','codex.fixture':owner}
    network = r.api('POST','/networks/create',{'Name':name,'Driver':'bridge','Internal':True,'Labels':labels})['Id']
    owned=[]
    receipts=[]
    original_admin = c.admin_query
    try:
        pgid = r.api('POST','/containers/create?name='+name,{
            'Image':'sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28',
            'Env':['POSTGRES_DB=mapping_db','POSTGRES_HOST_AUTH_METHOD=trust'],'Labels':labels,
            'HostConfig':{'NetworkMode':name,'Memory':268435456,'PidsLimit':128,'Tmpfs':{'/var/lib/postgresql/data':'rw,nosuid,size=192m'}},
            'NetworkingConfig':{'EndpointsConfig':{name:{'Aliases':[name]}}}})['Id']
        owned.append((pgid,name,True))
        r.api('POST','/containers/'+pgid+'/start')
        for _ in range(30):
            ready=subprocess.run(['docker','exec',pgid,'pg_isready','-h','127.0.0.1','-U','postgres','-d','mapping_db'],capture_output=True,timeout=10)
            if ready.returncode==0: break
            time.sleep(1)
        else: raise RuntimeError('fixture_pg_not_ready')
        command(['docker','exec',pgid,'createdb','-h','127.0.0.1','-U','postgres','izone_mapping_demo'])
        def admin(item,sql):
            _,_,database=c.destination(item)
            output=command(['docker','exec','-i',pgid,'psql','-h','127.0.0.1','-At','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],sql)
            return [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        c.admin_query=admin
        request={'run_id':owner,'manifest':manifest,'identities':[{
            'name':target['name'],'attempt_id':str(uuid.uuid4()),'marker':'CODEX_D08_'+owner+'_'+str(index),
            'course_id':c.DEMO_COURSE_ID if target['name']==c.NAMES[2] else -2000000-index*2,'student_id':-2000001-index*2} for index,target in enumerate(manifest['targets'])]}
        c.validate(request)
        ddl="""CREATE SCHEMA __SCHEMA__;
CREATE TABLE __SCHEMA__.test_definition(slug text PRIMARY KEY,title text,version int);
INSERT INTO __SCHEMA__.test_definition VALUES('term-test-1','D08 giả',1),
 ('term-test-1-k56','D08 Term 1 giả',1),('mini-test-k56','D08 Mini giả',1),('term-test-2-k56','D08 Term 2 giả',1);
CREATE TABLE __SCHEMA__.term_test_attempt(
 id uuid PRIMARY KEY,client_submission_id uuid,test_slug text,definition_version int,
 erp_course_class_id bigint,erp_student_contact_id bigint,class_name_snapshot text,student_name_snapshot text,
 exam_session_id uuid,superseded_at timestamptz,listening_submitted_at timestamptz,
 listening_answers jsonb,listening_result jsonb,reading_answers jsonb,reading_result jsonb,
 reading_started_at timestamptz,reading_deadline_at timestamptz,reading_draft_updated_at timestamptz,
 reading_submitted_at timestamptz,completed_at timestamptz,combined_result jsonb,
 writing_task_1 text NOT NULL DEFAULT '',writing_task_2 text NOT NULL DEFAULT '',
 writing_draft_revision bigint NOT NULL DEFAULT 0,writing_started_at timestamptz,
 writing_deadline_at timestamptz,writing_updated_at timestamptz,writing_submitted_at timestamptz,
 updated_at timestamptz DEFAULT now());
"""
        for index,(target,item) in enumerate(zip(manifest['targets'],request['identities'])):
            schema,_,database=c.destination(item)
            text=ddl.replace('__SCHEMA__',schema)
            text+='\n'.join('CREATE TABLE '+schema+'.'+table+'(attempt_id uuid);' for table in c.CHILDREN)
            # Lớp nền giả cho guard demo; giữ riêng DB owned, không tạo lớp production.
            class_code = 'CODEXDEMO56' if index == 2 else 'IC2264' if index == 1 else 'IC2146'
            courses = [c.DEMO_COURSE_ID] if index==2 else [-2000000-index*2] + ([-3000002,-3000006,-3000010] if index == 1 else [-3000000])
            text += "CREATE SCHEMA IF NOT EXISTS mapping; CREATE TABLE IF NOT EXISTS mapping.classroom_course_mapping(erp_course_class_id bigint PRIMARY KEY, erp_class_name_snapshot text);"
            text += "INSERT INTO mapping.classroom_course_mapping VALUES " + ','.join(f"({course},'{class_code}')" for course in courses) + ';'
            if index==2:
                # Hai lượt nền giả có cùng lớp, khác UUID/student; phải nguyên vẹn sau mọi seed/cleanup.
                for prior in range(2):
                    identifier=str(uuid.uuid4())
                    text += f"INSERT INTO {schema}.term_test_attempt(id,client_submission_id,test_slug,definition_version,erp_course_class_id,erp_student_contact_id,class_name_snapshot,student_name_snapshot,writing_task_1,writing_task_2) VALUES('{identifier}','{identifier}','term-test-1-k56',1,{c.DEMO_COURSE_ID},{-570001-prior},'D08_BASELINE_{owner}_{prior}','Synthetic baseline','Baseline Task1 {prior}','Baseline Task2 {prior}');"
            admin(item,text)
            baseline_sql=f"BEGIN READ ONLY; SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(jsonb_build_object('id',id,'hash',md5(row_to_json(prior)::text)) ORDER BY id),'[]'::jsonb))::text FROM {schema}.term_test_attempt AS prior WHERE class_name_snapshot LIKE 'D08_BASELINE_{owner}_%'; COMMIT;"
            baseline_before=admin(item,baseline_sql)
            class_guards=[]
            if index==2:
                # Đổi lớp chỉ trong transaction DB owned; lỗi đóng kết nối phải rollback.
                class_sql="BEGIN READ ONLY; SELECT jsonb_build_object('rows',jsonb_agg(row_to_json(course) ORDER BY erp_course_class_id))::text FROM mapping.classroom_course_mapping course; COMMIT;"
                classes_before=admin(item,class_sql)
                scenarios={
                    'missing':f"DELETE FROM mapping.classroom_course_mapping WHERE erp_course_class_id={c.DEMO_COURSE_ID};",
                    'wrong_code':f"UPDATE mapping.classroom_course_mapping SET erp_class_name_snapshot='OTHER_CLASS' WHERE erp_course_class_id={c.DEMO_COURSE_ID};",
                    'duplicate_code':"INSERT INTO mapping.classroom_course_mapping VALUES(-560002,'CODEXDEMO56');"
                }
                for scenario,mutation in scenarios.items():
                    sql="BEGIN; "+mutation+" DO $$ BEGIN "+c.demo_course_guard_sql(item)+" END $$; ROLLBACK;"
                    failed=subprocess.run(['docker','exec','-i',pgid,'psql','-h','127.0.0.1','-At','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],input=sql,text=True,encoding='utf-8',capture_output=True,timeout=30)
                    if failed.returncode==0 or 'CANARY_DEMO_CLASS_CHANGED' not in failed.stderr:
                        raise RuntimeError('fixture_demo_guard_not_failed:'+scenario)
                    if admin(item,class_sql)!=classes_before or admin(item,baseline_sql)!=baseline_before:
                        raise RuntimeError('fixture_demo_guard_rollback_changed_data:'+scenario)
                    class_guards.append({'scenario':scenario,'rejected':True,'rollback_readback_equal':True,'exit_code':failed.returncode})
            # Pool K56 thật định tuyến assessment sang schema riêng như server hiện hành.
            scoped="import {createAssessmentSchemaPool} from './src/assessment-schema-pool.js'; const scoped=createAssessmentSchemaPool(pool,{family:'k56'});" if index==1 else 'const scoped=pool;'
            server="""import pg from 'pg'; import express from 'express'; import {createApp} from './src/app.js'; import {createTermTestAssetService} from './src/term-test-assets.js';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,statement_timeout:15000});
__SCOPED__
let grading=0,portal=0;
const app=createApp({config:{nodeEnv:'test',deploymentProfileName:'__PROFILE__',demoIsolatedMode:__DEMO__,authMode:'legacy',legacyReviewToken:'fixture-only',
 allowedOrigins:new Set(['https://tranhoangduc90.github.io']),trustProxyHops:0},pool:scoped,
 termTestAssetService:createTermTestAssetService({assetDir:'/fixture-assets-unused',sessionSecret:'Synthetic-D08-private-fixture-key-0000000000'}),
 syncErpGrades:async()=>{portal++;},termTestWritingGradingService:{ensureSubmission:async()=>{grading++;return {ready:false};}}});
const outer=express(); outer.get('/fixture-writer-counts',(_,res)=>res.json({grading,portal}));
outer.use(app); const server=outer.listen(8798,'0.0.0.0');
process.on('SIGTERM',()=>server.close(async()=>{await pool.end();process.exit(0);}));
""".replace('__SCOPED__',scoped).replace('__PROFILE__','k56-demo' if index==2 else 'k56-ic2264' if index==1 else 'k67').replace('__DEMO__','true' if index==2 else 'false')
            api_name=name+'-api-'+str(index)
            apiid=r.api('POST','/containers/create?name='+api_name,{
                'Image':target['candidate_image'],'Entrypoint':[],
                'Cmd':['node','--input-type=module','-e',server],'WorkingDir':'/app',
                'Env':['DATABASE_URL=postgresql://postgres@'+name+':5432/'+database,'PORT=8798'],'Labels':labels,
                'Healthcheck':{'Test':['NONE']},'HostConfig':{'NetworkMode':name,'ReadonlyRootfs':True,'Memory':536870912,'PidsLimit':128,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true']},
                'NetworkingConfig':{'EndpointsConfig':{name:{'Aliases':[api_name]}}}})['Id']
            owned.append((apiid,api_name,False))
            r.api('POST','/containers/'+apiid+'/start')
            ping="fetch('http://127.0.0.1:8798/fixture-writer-counts').then(r=>r.json()).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(1));"
            for _ in range(30):
                ready=subprocess.run(['docker','exec',apiid,'node','-e',ping],capture_output=True,timeout=10)
                if ready.returncode==0: break
                if not r.inspect(apiid)['State']['Running']: raise RuntimeError('fixture_api_start_failed')
                time.sleep(1)
            else: raise RuntimeError('fixture_api_not_ready')
            if ui_driver is None:
                output=command(['docker','exec','-i','-w','/app',apiid,'node','--input-type=module','-'],c.node_source(item,core))
                result=json.loads(output)
            else:
                # Callback chỉ nhận ID/label object riêng; production names không được dùng.
                result=ui_driver(manifest,item,apiid,pgid,owner)
            if result['status']!='passed': raise RuntimeError('fixture_canary_not_passed')
            counts=json.loads(command(['docker','exec',apiid,'node','-e',ping]))
            if counts!={'grading':0,'portal':0}: raise RuntimeError('fixture_external_writer_called:'+json.dumps(counts))
            cleanup=c.cleanup(item)
            baseline_after=admin(item,baseline_sql)
            if baseline_after!=baseline_before:raise RuntimeError('fixture_existing_attempt_changed')
            receipts.append({'target':target['name'],'image':target['candidate_image'],'status':'passed',
                             'api_database':result,'cleanup':cleanup,'writers':counts,
                             'baseline_before_after_equal':True,'baseline_rows':len(baseline_before[0]['rows']),'demo_class_negative_guards':class_guards})
        return {'status':'passed','targets':receipts,'production_environment_used':False,
                'production_database_used':False,'network':'Internal','cleanup':'verified_after_finally',
                'scope':'Exact candidate createApp/SQL + actual PostgreSQL + actual seed/cleanup producer; actual profile branch with synthetic legacy auth/config; no production assets/browser outcome'}
    finally:
        c.admin_query=original_admin
        for identifier,object_name,volumes in reversed(owned):
            item=r.inspect(identifier)
            if item['Name']!='/'+object_name or item['Config'].get('Labels',{}).get('codex.fixture')!=owner:
                raise RuntimeError('fixture_canary_cleanup_identity_failed')
            if item['State']['Running']: r.api('POST','/containers/'+identifier+'/stop?t=30')
            r.api('DELETE','/containers/'+identifier+'?v='+str(volumes).lower())
        item=r.api('GET','/networks/'+network)
        if item.get('Labels',{}).get('codex.fixture')!=owner or item.get('Containers'):
            raise RuntimeError('fixture_canary_network_cleanup_failed')
        r.api('DELETE','/networks/'+network)
        if any(item.get('Labels',{}).get('codex.fixture')==owner for item in r.api('GET','/containers/json?all=true')):
            raise RuntimeError('fixture_canary_cleanup_incomplete')
