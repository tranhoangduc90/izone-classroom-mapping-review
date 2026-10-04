"""Kiểm sau phát hành trên đúng ba API bằng các danh tính giả đã ghi ledger.
Nhận manifest/UUID qua stdin, chỉ seed/start/draft và đọc năm bảng child.
Hoàn nguyên bằng role quản trị với đủ UUID/marker/ERP âm/chưa nộp/child0.
Không gọi result/submit/AI/Docs/Lark/Portal; receipt API/DB không thay outcome UI.
"""
import datetime
import json
import re
import subprocess
import uuid
from pathlib import Path
import release_remote as r

NAMES = ('mapping-review-api', 'izone-k56-ic2264-api', 'izone-k56-demo-k56-demo-api-1')
CHILDREN = ('term_test_exam_session', 'term_test_writing_grading_run', 'term_test_writing_grading_final', 'term_test_writing_planning', 'term_test_portal_sync_job')


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
            if type(value) is not int or not -2147483647 <= value <= -1000000 or value in numbers:
                raise RuntimeError('canary_erp_identity_invalid')
            numbers.add(value)
    return identities


def destination(item):
    if item['name'] not in NAMES:
        raise RuntimeError('canary_target_invalid')
    return ('assessment_k56' if item['name'] == NAMES[1] else 'assessment',
            'k56-demo-db' if item['name'] == NAMES[2] else 'mapping-postgres',
            'izone_mapping_demo' if item['name'] == NAMES[2] else 'mapping_db')


def child_expression(schema, identifier):
    return ' + '.join(f"(SELECT count(*) FROM {schema}.{table} WHERE attempt_id='{identifier}'::uuid)" for table in CHILDREN)


def cleanup_sql(item):
    schema, _, database = destination(item)
    identifier = item['attempt_id']
    condition = (f"id='{identifier}'::uuid AND class_name_snapshot='{item['marker']}'"
                 f" AND erp_course_class_id={item['course_id']} AND erp_student_contact_id={item['student_id']}"
                 " AND writing_submitted_at IS NULL AND exam_session_id IS NULL")
    children = child_expression(schema, identifier)
    # Không xóa theo marker diện rộng; khóa UUID trước kiểm child và xóa đúng dòng.
    return f"""BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s';
DO $$ BEGIN IF current_database()<>'{database}' THEN RAISE EXCEPTION 'CANARY_DATABASE_MISMATCH'; END IF; END $$;
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
    config = json.dumps({**item, 'schema': schema, 'database': database}, ensure_ascii=False)
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
 const schema=config.schema;
 // Xác minh tồn tại năm bảng child trước mutation.
 for(const table of tables) await pool.query(`SELECT count(*) FROM ${schema}.${table} WHERE attempt_id=$1`,[config.attempt_id]);
 const existing=await pool.query(`SELECT count(*)::int n FROM ${schema}.term_test_attempt
  WHERE id=$1 OR class_name_snapshot=$2 OR erp_student_contact_id=$3 OR erp_course_class_id=$4`,
  [config.attempt_id,config.marker,config.student_id,config.course_id]);
 assert.equal(existing.rows[0].n,0,'CANARY_EXISTING_IDENTITY');
 const definition=(await pool.query(`SELECT slug,version FROM ${schema}.test_definition WHERE slug='term-test-1' ORDER BY version DESC LIMIT 1`)).rows[0];
 assert.ok(definition,'CANARY_DEFINITION_MISSING');
 await pool.query(`INSERT INTO ${schema}.term_test_attempt
  (id,client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
   erp_student_contact_id,student_name_snapshot,listening_answers,listening_result,
   reading_answers,reading_result,combined_result,listening_submitted_at,completed_at)
  VALUES($1::uuid,$1::uuid,$2,$3,$4,$5,$6,'D08 synthetic temporary','{}','{}','{}','{}','{}',now(),now())`,
  [config.attempt_id,definition.slug,definition.version,config.course_id,config.marker,config.student_id]);
 const read=async()=>{
  const row=(await pool.query(`SELECT writing_task_1,writing_task_2,writing_draft_revision,
   writing_updated_at,writing_submitted_at FROM ${schema}.term_test_attempt
   WHERE id=$1 AND class_name_snapshot=$2 AND erp_student_contact_id=$3 AND erp_course_class_id=$4`,
   [config.attempt_id,config.marker,config.student_id,config.course_id])).rows[0];
  assert.ok(row,'CANARY_ROW_IDENTITY_CHANGED');
  const children={};
  for(const table of tables) children[table]=Number((await pool.query(`SELECT count(*)::int n FROM ${schema}.${table} WHERE attempt_id=$1`,[config.attempt_id])).rows[0].n);
  return {task1:row.writing_task_1,task2:row.writing_task_2,revision:Number(row.writing_draft_revision),
   updatedAt:row.writing_updated_at?.toISOString(),submitted:row.writing_submitted_at!==null,children};
 };
 value=await exerciseCanary({id:config.attempt_id,read,post:async payload=>{
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
""".replace('__CONFIG__', config).replace('__TABLES__', json.dumps(CHILDREN))


def exercise(request):
    identities = validate(request)
    rows = r.probe(request['manifest'])
    if rows != request['expected'] or any(row['image'] != target['candidate_image'] or not row['running'] or row['healthy'] != 'healthy' for row, target in zip(rows, request['manifest']['targets'])):
        raise RuntimeError('canary_live_candidate_drift')
    journal = r.RELEASE_ROOT / request['run_id'] / 'canary.json'
    if journal.exists():
        raise RuntimeError('canary_replay_blocked_reconcile_cleanup')
    for item in identities:
        schema, _, database = destination(item)
        counts = child_expression(schema, item['attempt_id'])
        preflight = admin_query(item, f"BEGIN READ ONLY; SELECT jsonb_build_object('database',current_database(),'existing',(SELECT count(*) FROM {schema}.term_test_attempt WHERE id='{item['attempt_id']}'::uuid OR class_name_snapshot='{item['marker']}' OR erp_student_contact_id={item['student_id']} OR erp_course_class_id={item['course_id']}),'children',({counts}))::text; COMMIT;")
        if preflight != [{'database':database,'existing':0,'children':0}]:
            raise RuntimeError('canary_preexisting_identity_blocked_no_cleanup')
    state = {'status': 'in_progress', 'before': rows, 'identities': identities, 'receipts': []}
    r.write_receipt(journal, state)
    for item in identities:
        state['phase'] = 'before_seed:' + item['name']
        r.write_receipt(journal, state)
        receipt = {'target': item['name'], 'status': 'unknown'}
        sender_stopped = False
        try:
            run = subprocess.run(['docker', 'exec', '-i', '-w', '/app', item['name'], 'node', '--input-type=module', '-'],
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
    state['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    state['scope'] = 'API + database + exact cleanup only; browser and external boundary evidence still required'
    r.write_receipt(journal, state)
    return state
