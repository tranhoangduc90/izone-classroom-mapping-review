"""Kiểm sau phát hành trên đúng ba API bằng các danh tính giả đã ghi ledger.
Nhận manifest/UUID qua stdin, chỉ seed/start/draft; đọc đủ bảng con theo từng đích.
Hoàn nguyên bằng role quản trị với đủ UUID/marker/ERP âm/chưa nộp/child0.
Không gọi result/submit/AI/Docs/Lark/Portal; receipt API/DB không thay outcome UI.
"""
import datetime
import os
import json
import re
import subprocess
import uuid
from pathlib import Path
import release_remote as r
import database_binding as binding

NAMES = ('mapping-review-api', 'izone-k56-ic2264-api', 'izone-k56-demo-k56-demo-api-1')
CHILDREN = ('term_test_exam_session', 'term_test_writing_grading_run', 'term_test_writing_grading_final', 'term_test_writing_planning', 'term_test_portal_sync_job')
K56_CHILDREN = ('term_test_exam_session', 'term_test_writing_grading_run', 'term_test_writing_grading_final', 'term_test_portal_sync_job', 'term_test_portal_sync_state', 'k56_portal_field_dispatch')
DEMO_COURSE_ID = -560001


def uses_existing_demo_course(item):
    # Lớp này là lớp giả hiện có, không phải định danh học viên hoặc lượt làm bài.
    return item.get('name') == NAMES[2] and type(item.get('course_id')) is int and item['course_id'] == DEMO_COURSE_ID


def fixture_test_slug(target, client=None):
    if target not in NAMES:
        raise RuntimeError('canary_target_invalid')
    if client == 'k56-mini-shared':
        return 'mini-test-k56'
    if client == 'k56-test2-shared':
        return 'term-test-2-k56'
    return 'term-test-1' if target == NAMES[0] else 'term-test-1-k56'


def course_collision_sql(item):
    # UUID/marker/mã học viên luôn riêng; chỉ lớp giả đã có được dùng chung.
    return '' if uses_existing_demo_course(item) else f" OR erp_course_class_id={item['course_id']}"


def demo_course_guard_sql(item):
    if not uses_existing_demo_course(item):
        return ''
    return """IF (SELECT count(*) FROM mapping.classroom_course_mapping
 WHERE erp_course_class_id=-560001 AND upper(btrim(erp_class_name_snapshot))='CODEXDEMO56')<>1
 OR (SELECT count(*) FROM mapping.classroom_course_mapping
 WHERE upper(btrim(erp_class_name_snapshot))='CODEXDEMO56')<>1
 THEN RAISE EXCEPTION 'CANARY_DEMO_CLASS_CHANGED'; END IF;"""


def validate(request):
    r.checked_run_id(request['run_id'])
    identities = request['identities']
    if [item['name'] for item in identities] != list(NAMES):
        raise RuntimeError('canary_target_set_invalid')
    if [item['name'] for item in request['manifest']['targets']] != list(NAMES):
        raise RuntimeError('canary_manifest_invalid')
    ids = set()
    numbers = set()
    for index, item in enumerate(identities):
        if str(uuid.UUID(item['attempt_id'])) != item['attempt_id'] or item['attempt_id'] in ids:
            raise RuntimeError('canary_uuid_invalid')
        ids.add(item['attempt_id'])
        if not re.fullmatch(r'CODEX_D08_[a-f0-9]{32}_[012]', item['marker']):
            raise RuntimeError('canary_marker_invalid')
        if item['marker'] != 'CODEX_D08_' + request['run_id'] + '_' + str(index):
            raise RuntimeError('canary_marker_run_mismatch')
        for key in ('course_id', 'student_id'):
            value = item[key]
            if key == 'course_id' and uses_existing_demo_course(item):
                continue
            if type(value) is not int or not -2147483647 <= value <= -1000000 or value in numbers:
                raise RuntimeError('canary_erp_identity_invalid')
            numbers.add(value)
    return identities


def destination(item):
    if item['name'] not in NAMES:
        raise RuntimeError('canary_target_invalid')
    return ('assessment_k56' if item['name'] == NAMES[1] else 'assessment',
            'izone-k56-demo-k56-demo-db-1' if item['name'] == NAMES[2] else 'mapping-postgres',
            'izone_mapping_demo' if item['name'] == NAMES[2] else 'mapping_db')


def child_tables(item):
    # Shared và hai API K56 có schema khác nhau; không bỏ qua bảng thiếu bằng số 0 giả.
    name = item['name']
    if name == NAMES[0]:
        return tuple(sorted(CHILDREN))
    if name in NAMES[1:]:
        return tuple(sorted(K56_CHILDREN))
    raise RuntimeError('canary_target_invalid')


def topology_guard_sql(item):
    schema = destination(item)[0]
    names = ','.join("'" + table + "'" for table in child_tables(item))
    qualified = ','.join("'" + schema + '.' + table + "'" for table in child_tables(item))
    # Cả cột attempt_id và mọi FK tới attempt phải khớp; bảng mới/lạ cũng chặn xóa cascade.
    return f"""IF ARRAY(SELECT table_name::text FROM information_schema.columns
 WHERE table_schema='{schema}' AND column_name='attempt_id' ORDER BY table_name)
 <> ARRAY[{names}]::text[] OR ARRAY(SELECT child_schema.nspname::text || '.' || child.relname::text
 FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_namespace child_schema ON child_schema.oid=child.relnamespace
 WHERE fk.contype='f' AND fk.confrelid='{schema}.term_test_attempt'::regclass ORDER BY child_schema.nspname::text || '.' || child.relname::text)
 <> ARRAY[{qualified}]::text[] OR EXISTS(SELECT 1 FROM pg_constraint fk
 WHERE fk.contype='f' AND fk.confrelid='{schema}.term_test_attempt'::regclass
 AND (fk.conkey <> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=fk.conrelid AND attname='attempt_id' AND NOT attisdropped)]::smallint[]
 OR fk.confkey <> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=fk.confrelid AND attname='id' AND NOT attisdropped)]::smallint[]))
 THEN RAISE EXCEPTION 'CANARY_CHILD_TOPOLOGY_CHANGED'; END IF;"""


def verify_child_topology(item):
    admin_query(item, 'BEGIN READ ONLY; DO $$ BEGIN ' + topology_guard_sql(item) + ' END $$; COMMIT;')


def child_expression(schema, identifier, item):
    tables = child_tables(item)
    if schema != destination(item)[0]:
        raise RuntimeError('canary_child_schema_mismatch')
    return ' + '.join(f"(SELECT count(*) FROM {schema}.{table} WHERE attempt_id='{identifier}'::uuid)" for table in tables)


def cleanup_sql(item):
    schema, _, database = destination(item)
    identifier = item['attempt_id']
    test_slug = item.get('test_slug',fixture_test_slug(item['name']))
    if test_slug not in ('term-test-1','term-test-1-k56','mini-test-k56','term-test-2-k56'):
        raise RuntimeError('canary_test_slug_invalid')
    condition = (f"id='{identifier}'::uuid AND class_name_snapshot='{item['marker']}'"
                 f" AND erp_course_class_id={item['course_id']} AND erp_student_contact_id={item['student_id']}"
                 f" AND test_slug='{test_slug}' AND writing_submitted_at IS NULL AND exam_session_id IS NULL")
    children = child_expression(schema, identifier, item)
    # Không xóa theo marker diện rộng; khóa UUID trước kiểm child và xóa đúng dòng.
    return f"""BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s';
DO $$ BEGIN IF current_database()<>'{database}' THEN RAISE EXCEPTION 'CANARY_DATABASE_MISMATCH'; END IF; {topology_guard_sql(item)} END $$;
SELECT 1 FROM {schema}.term_test_attempt WHERE id='{identifier}'::uuid FOR UPDATE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM {schema}.term_test_attempt WHERE id='{identifier}'::uuid)
  AND (SELECT count(*) FROM {schema}.term_test_attempt WHERE {condition})<>1
  THEN RAISE EXCEPTION 'CANARY_IDENTITY_GUARD_FAILED'; END IF;
 IF ({children})<>0 THEN RAISE EXCEPTION 'CANARY_CHILD_GUARD_FAILED'; END IF;
END $$;
WITH removed AS(DELETE FROM {schema}.term_test_attempt WHERE {condition} RETURNING id)
SELECT jsonb_build_object('removed',count(*))::text FROM removed;
COMMIT;
BEGIN READ ONLY;
SELECT jsonb_build_object('attempt_remaining',(SELECT count(*) FROM {schema}.term_test_attempt WHERE id='{identifier}'::uuid),
 'marker_remaining',(SELECT count(*) FROM {schema}.term_test_attempt WHERE class_name_snapshot='{item['marker']}'),
 'children_remaining',({children}))::text;
COMMIT;"""


def admin_query(item, sql):
    _, container, database = destination(item)
    frozen = binding.require(item, destination)
    container = frozen['db_id']
    run = subprocess.run(['docker', 'exec', '-i', container, 'sh', '-c',
                          'exec psql -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ' + database],
                         input=sql, text=True, encoding='utf-8', capture_output=True, timeout=60)
    # PostgreSQL stderr có thể chứa dữ liệu; chỉ lưu mã lỗi chuẩn, không đưa raw vào receipt.
    if run.returncode:
        raise RuntimeError('canary_admin_cleanup_failed')
    values = [json.loads(line) for line in run.stdout.splitlines() if line.startswith('{')]
    return values


def cleanup(item):
    values = admin_query(item, cleanup_sql(item))
    if len(values) != 2 or values[0]['removed'] not in (0, 1) or any(value != 0 for value in values[1].values()):
        raise RuntimeError('canary_cleanup_readback_failed')
    return {'status': 'passed', 'attempt_id': item['attempt_id'], 'removal': values[0], 'readback': values[1]}


def node_source(item, core):
    schema, _, database = destination(item)
    config = json.dumps({**item, 'schema': schema, 'database': database,
                         'test_slug': fixture_test_slug(item['name']),
                         'existing_demo_course': uses_existing_demo_course(item)}, ensure_ascii=False)
    # Toàn bộ nội dung là UUID và bài giả; connection string chỉ đọc trong container.
    return core.replace('export async function exerciseCanary', 'async function exerciseCanary') + '\n' + """
import pg from 'pg';
const config = __CONFIG__;
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
 connectionTimeoutMillis:5000,statement_timeout:15000,application_name:'codex_d08_release_canary'});
const tables=__TABLES__;
let value;
try {
 const identity=(await pool.query('SELECT current_database() AS database')).rows[0];
 assert.equal(identity.database,config.database);
 await pool.query(__TOPOLOGY_GUARD__);
 const schema=config.schema;
 // Xác minh đủ bảng con và FK theo đích trước mutation.
 for(const table of tables) await pool.query(`SELECT count(*) FROM ${schema}.${table} WHERE attempt_id=$1`,[config.attempt_id]);
 if(config.existing_demo_course){
  const allowed=(await pool.query(`SELECT erp_course_class_id::text AS course_id,erp_class_name_snapshot AS class_code
   FROM mapping.classroom_course_mapping WHERE upper(btrim(erp_class_name_snapshot))='CODEXDEMO56'`)).rows;
  assert.deepEqual(allowed,[{course_id:'-560001',class_code:'CODEXDEMO56'}],'CANARY_DEMO_CLASS_CHANGED');
 }
 const existing=await pool.query(`SELECT count(*)::int n FROM ${schema}.term_test_attempt
  WHERE id=$1 OR class_name_snapshot=$2 OR erp_student_contact_id=$3 OR (NOT $5::boolean AND erp_course_class_id=$4::bigint)`,
  [config.attempt_id,config.marker,config.student_id,config.course_id,config.existing_demo_course]);
 assert.equal(existing.rows[0].n,0,'CANARY_EXISTING_IDENTITY');
 const definition=(await pool.query(`SELECT slug,version FROM ${schema}.test_definition WHERE slug=$1 ORDER BY version DESC LIMIT 1`,[config.test_slug])).rows[0];
 assert.ok(definition,'CANARY_DEFINITION_MISSING');
 await pool.query(`INSERT INTO ${schema}.term_test_attempt
  (id,client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
   erp_student_contact_id,student_name_snapshot,listening_answers,listening_result,
   reading_answers,reading_result,combined_result,listening_submitted_at,reading_submitted_at,completed_at)
  VALUES($1::uuid,$1::uuid,$2,$3,$4,$5,$6,'D08 synthetic temporary','{}','{}','{}','{}','{}',now(),now(),now())`,
  [config.attempt_id,definition.slug,definition.version,config.course_id,config.marker,config.student_id]);
 const read=async()=>{
  const row=(await pool.query(`SELECT writing_task_1,writing_task_2,writing_draft_revision,test_slug,
   writing_updated_at,writing_submitted_at FROM ${schema}.term_test_attempt
   WHERE id=$1 AND class_name_snapshot=$2 AND erp_student_contact_id=$3 AND erp_course_class_id=$4`,
   [config.attempt_id,config.marker,config.student_id,config.course_id])).rows[0];
  assert.ok(row,'CANARY_ROW_IDENTITY_CHANGED');
  assert.equal(row.test_slug,config.test_slug,'CANARY_ROW_TEST_CHANGED');
  const children={};
  for(const table of tables) children[table]=Number((await pool.query(`SELECT count(*)::int n FROM ${schema}.${table} WHERE attempt_id=$1`,[config.attempt_id])).rows[0].n);
  return {task1:row.writing_task_1,task2:row.writing_task_2,revision:Number(row.writing_draft_revision),
   updatedAt:row.writing_updated_at?.toISOString(),submitted:row.writing_submitted_at!==null,children};
 };
 value=await exerciseCanary({id:config.attempt_id,read,childTables:tables,post:async payload=>{
  assert.equal(payload.attemptToken,config.attempt_id);
  assert.ok(['start','draft'].includes(payload.action));
  const response=await fetch(`http://127.0.0.1:${process.env.PORT||8788}/api/term-tests/writing`,{
   method:'POST',headers:{'Content-Type':'application/json',Origin:'https://tranhoangduc90.github.io'},
   body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  return {status:response.status,body:await response.json()};
 }});
}catch(error){value={status:'failed',error:error.code||error.message.split('\\n')[0],attempt_id:config.attempt_id};process.exitCode=1;}
finally{await pool.end();}
console.log(JSON.stringify(value));
""".replace('__CONFIG__', config).replace('__TABLES__', json.dumps(child_tables(item))).replace('__TOPOLOGY_GUARD__', json.dumps('DO $$ BEGIN '+topology_guard_sql(item)+' END $$;'))


def acceptance_path(value):
    # Đầu vào không chứa token; khóa gắn đúng release, digest và sổ UI đã duyệt.
    if not isinstance(value,dict) or set(value) != {'release_run_id','acceptance_run_id','original_plan_digest','acceptance_digest','ui_ledger_sha256','expected_generation'}:
        raise RuntimeError('acceptance_executor_binding_invalid')
    for key in ('release_run_id','acceptance_run_id'):
        r.checked_run_id(value[key])
    for key in ('original_plan_digest','acceptance_digest','ui_ledger_sha256'):
        if not isinstance(value[key],str) or not re.fullmatch('[a-f0-9]{64}',value[key]):
            raise RuntimeError('acceptance_executor_digest_invalid')
    if type(value['expected_generation']) is not int or value['expected_generation'] not in (0,2):
        raise RuntimeError('acceptance_executor_generation_conflict')
    return r.RELEASE_ROOT/value['release_run_id']/'acceptance.executor.json'


def acquire_acceptance(value):
    path=acceptance_path(value)
    if value['expected_generation']!=0:
        raise RuntimeError('acceptance_resume_requires_cas')
    release=r.RELEASE_ROOT/(value['release_run_id']+'.json')
    if not release.is_file() or json.loads(release.read_text(encoding='utf-8')).get('status') != 'deployed_awaiting_validation':
        raise RuntimeError('acceptance_executor_release_not_deployed')
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    # create-exclusive chính là CAS từ generation0/absent; sender thứ hai không được ghi.
    state={'generation':1,'binding':value,'status':'api_started','pid':os.getpid()}
    with path.open('x',encoding='utf-8') as stream:
        json.dump(state,stream,ensure_ascii=False,indent=2);stream.flush();os.fsync(stream.fileno())
    if os.name!='nt':
        descriptor=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)
    return path


def require_acceptance(value):
    path=acceptance_path(value)
    state=json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    if state.get('binding') != value or state.get('status') != 'api_passed' or state.get('generation') != value['expected_generation']+2:
        raise RuntimeError('acceptance_executor_not_passed_or_binding_changed')
    return state


def complete_api_acceptance(value,passed):
    path=acceptance_path(value);state=json.loads(path.read_text(encoding='utf-8'))
    if state.get('generation')!=value['expected_generation']+1 or state.get('binding')!=value or state.get('status')!='api_started' or state.get('pid')!=os.getpid():
        raise RuntimeError('acceptance_executor_completion_conflict')
    state.update(generation=value['expected_generation']+2,status='api_passed' if passed else 'unknown')
    r.write_receipt(path,state)
    # Khóa được giữ kể cả passed/unknown; không chạy lại API hoặc lấy lại theo tuổi.


def exercise(request):
    identities = validate(request)
    rows = r.probe(request['manifest'])
    if rows != request['expected'] or any(row['image'] != target['candidate_image'] or not row['running'] or row['healthy'] != 'healthy' for row, target in zip(rows, request['manifest']['targets'])):
        raise RuntimeError('canary_live_candidate_drift')
    resume=request['acceptance_binding']['expected_generation']==2
    journal = r.RELEASE_ROOT / request['run_id'] / ('canary.generation-3.json' if resume else 'canary.json')
    if journal.exists():
        raise RuntimeError('canary_replay_blocked_reconcile_cleanup')
    if resume:
        import acceptance_resume
        previous=acceptance_resume.acquire(request,__import__(__name__))
    else:
        if request.get('acceptance_resume'):raise RuntimeError('resume_initial_binding_invalid')
        acquire_acceptance(request['acceptance_binding'])
    try:
        # Khóa API/database/network ID trước lượt; mỗi query/cleanup phải so lại topology.
        for item in identities:
            item['_database_binding'] = binding.resolve(item, destination)
        for item in identities:
            schema, _, database = destination(item)
            counts = child_expression(schema, item['attempt_id'], item)
            preflight = admin_query(item, f"BEGIN READ ONLY; DO $$ BEGIN {topology_guard_sql(item)} {demo_course_guard_sql(item)} END $$; SELECT jsonb_build_object('database',current_database(),'existing',(SELECT count(*) FROM {schema}.term_test_attempt WHERE id='{item['attempt_id']}'::uuid OR class_name_snapshot='{item['marker']}' OR erp_student_contact_id={item['student_id']}{course_collision_sql(item)}),'children',({counts}))::text; COMMIT;")
            if preflight != [{'database':database,'existing':0,'children':0}]:
                raise RuntimeError('canary_preexisting_identity_blocked_no_cleanup')
    except Exception as error:
        failure={'status':'unknown','phase':'preflight_after_executor_claim','error_type':type(error).__name__,'no_seed_sent':True,'before':rows,'identities':identities,'receipts':[previous['receipts'][0]] if resume else [],'acceptance_binding':request['acceptance_binding']}
        r.write_receipt(journal,failure)
        complete_api_acceptance(request['acceptance_binding'],False)
        raise
    state = {'status': 'in_progress', 'before': rows, 'identities': identities, 'receipts': [previous['receipts'][0]] if resume else []}
    if resume:state['acceptance_resume']=request['acceptance_resume']
    r.write_receipt(journal, state)
    for item in (identities[1:] if resume else identities):
        state['phase'] = 'before_seed:' + item['name']
        r.write_receipt(journal, state)
        receipt = {'target': item['name'], 'status': 'unknown'}
        sender_stopped = False
        try:
            frozen = binding.require(item, destination)
            run = subprocess.run(['docker', 'exec', '-i', '-w', '/app', frozen['api_id'], 'node', '--input-type=module', '-'],
                                 input=node_source(item, request['core']), text=True, encoding='utf-8', capture_output=True, timeout=180)
            sender_stopped = True
            values = [json.loads(line) for line in run.stdout.splitlines() if line.startswith('{')]
            if len(values) != 1:
                raise RuntimeError('canary_api_response_unknown')
            receipt['api_database'] = values[0]
            receipt['status'] = 'passed' if run.returncode == 0 and values[0]['status'] == 'passed' else 'failed'
        except Exception as error:
            receipt['error'] = type(error).__name__
        finally:
            state['phase'] = 'before_cleanup:' + item['name']
            r.write_receipt(journal, state)
            try:
                if not sender_stopped:
                    raise RuntimeError('canary_cleanup_blocked_sender_state_unknown')
                receipt['cleanup'] = cleanup(item)
            except Exception as error:
                receipt['status'] = 'unknown'
                receipt['cleanup_error'] = str(error)
            state['receipts'].append(receipt)
            r.write_receipt(journal, state)
        if receipt['status'] != 'passed':
            break
    state['after'] = r.probe(request['manifest'])
    state['runtime_unchanged'] = state['after'] == rows
    state['status'] = 'passed_api_database' if len(state['receipts']) == 3 and all(item['status'] == 'passed' for item in state['receipts']) and state['runtime_unchanged'] else 'unknown'
    if resume:
        state['receipt_provenance']={item['name']:({'epoch':'reused','journal_sha256':request['acceptance_resume']['journal_sha256'],'receipt_sha256':request['acceptance_resume']['reuse_receipt_sha256']} if index==0 else {'epoch':'current','acceptance_digest':request['acceptance_binding']['acceptance_digest']}) for index,item in enumerate(identities)}
    state['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    state['scope'] = 'API + database + exact cleanup only; browser and external boundary evidence still required'
    r.write_receipt(journal, state)
    complete_api_acceptance(request['acceptance_binding'],state['status']=='passed_api_database')
    return state
