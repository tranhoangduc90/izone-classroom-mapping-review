"""Cầu nối được gọi trong cửa sổ nghiệm thu đã cấp quyền.
Chỉ dùng DB/HTTP cho UUID của ledger; đích/image/source live phải bằng snapshot.
Không submit/result/chấm/Portal/Docs/Lark. Mất response giữ journal khóa.
"""
import hashlib,json,subprocess
import release_remote as r
import canary_remote as c
import database_binding as binding
from ui_rpc_guard import execute,Journal,check

class ProductionBackend:
    def __init__(self,manifest,expected,bindings):
        self.manifest=manifest;self.expected=expected;self.bindings=bindings
        check(set(bindings)==set(c.NAMES),'ui_database_binding_target_set')
        for row in expected:
            check(bindings[row['name']]['api_id']==row['container_id'],'ui_database_binding_api_changed')
    def guard(self,entry):
        rows=r.probe(self.manifest)
        check(rows==self.expected,'ui_live_snapshot_drift')
        for row,target in zip(rows,self.manifest['targets']):
            check(row['image']==target['candidate_image'] and row['running'] and row['healthy']=='healthy','ui_candidates_not_live')
        binding.require(self.item(entry),c.destination)
        c.verify_child_topology(self.item(entry))
    def item(self,entry):
        target=entry['destination']['container']
        return {'name':target,**entry['identity'],'test_slug':c.fixture_test_slug(target,entry['client']),
                '_database_binding':self.bindings[target]}
    def query(self,entry,sql):return c.admin_query(self.item(entry),sql)
    def read(self,entry):
        item=self.item(entry);schema,_,database=c.destination(item)
        identifier=item['attempt_id']
        fields=' OR '.join([f"id='{identifier}'::uuid",f"class_name_snapshot='{item['marker']}'",f"erp_student_contact_id={item['student_id']}"])+c.course_collision_sql(item)
        children=",".join(f"(SELECT count(*) FROM {schema}.{table} WHERE attempt_id='{identifier}'::uuid)" for table in c.child_tables(item))
        sql=f"""BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT jsonb_build_object('database',current_database(),'identity_count',(SELECT count(*) FROM {schema}.term_test_attempt WHERE {fields}),
 'value',(SELECT jsonb_build_object('attempt_id',id,'marker',class_name_snapshot,'course_id',erp_course_class_id,'student_id',erp_student_contact_id,'test_slug',test_slug,
 'exam_session',exam_session_id,'child_tables',{json.dumps(c.child_tables(item))!r}::jsonb,'children',jsonb_build_array({children}),
 'writing',jsonb_build_object('task1',writing_task_1,'task2',writing_task_2,'revision',writing_draft_revision,
 'started',writing_started_at IS NOT NULL,'startedAt',writing_started_at,'submitted',writing_submitted_at IS NOT NULL,
 'deadlineAt',writing_deadline_at,'serverNow',clock_timestamp()))
 FROM {schema}.term_test_attempt WHERE id='{identifier}'::uuid))::text;
COMMIT;"""
        values=self.query(entry,sql)
        check(len(values)==1 and values[0]['database']==database and values[0]['identity_count']==1,'ui_database_identity_count')
        value=values[0]['value'];check(value is not None and value.pop('exam_session') is None,'ui_exam_session_present')
        check(value.get('test_slug')==item['test_slug'],'ui_test_slug_wrong')
        value.update(ownership_checked=True,destination=entry['destination'])
        return value
    def seed(self,entry):
        item=self.item(entry);schema,_,database=c.destination(item);identifier=item['attempt_id']
        counts=c.child_expression(schema,identifier,item)
        sql=f"""BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF current_database()<>'{database}' THEN RAISE EXCEPTION 'UI_DATABASE_MISMATCH'; END IF;
 {c.topology_guard_sql(item)}
 {c.demo_course_guard_sql(item)}
 IF EXISTS(SELECT 1 FROM {schema}.term_test_attempt WHERE id='{identifier}'::uuid
 OR class_name_snapshot='{item['marker']}' OR erp_student_contact_id={item['student_id']}{c.course_collision_sql(item)})
 OR ({counts})<>0 THEN RAISE EXCEPTION 'UI_IDENTITY_COLLISION'; END IF;
END $$;
INSERT INTO {schema}.term_test_attempt
 (id,client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
 erp_student_contact_id,student_name_snapshot,listening_answers,listening_result,
 reading_answers,reading_result,combined_result,listening_submitted_at,completed_at)
 SELECT '{identifier}'::uuid,'{identifier}'::uuid,slug,version,{item['course_id']},'{item['marker']}',
 {item['student_id']},'D08 synthetic temporary','{{}}','{{}}','{{}}','{{}}','{{}}',now(),now()
 FROM {schema}.test_definition WHERE slug='{item['test_slug']}' ORDER BY version DESC LIMIT 1;
COMMIT;"""
        self.query(entry,sql)
        return self.read(entry)
    def post(self,entry,payload):
        url=entry['destination']['public_api_base']+'/api/term-tests/writing'
        source="""const request=JSON.parse(process.argv[1]);
// Chỉ dữ liệu bài giả; Origin như trình duyệt, đi qua HTTPS công khai.
try {
 const response=await fetch(request.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',
  Origin:'https://tranhoangduc90.github.io'},body:JSON.stringify(request.payload),signal:AbortSignal.timeout(15000)});
 if(response.url!==request.url)throw new Error('UI destination changed');
 const body=await response.json();console.log(JSON.stringify({status:response.status,body}));
}catch(error){console.log(JSON.stringify({status:'unknown',error:error.name}));process.exitCode=1;}
"""
        # Request đã ghi journal trên C và VPS trước Dockerexec; timeout không tự gửi lại.
        identifier=self.sender_id(entry)
        run=subprocess.run(['docker','exec','-w','/app',identifier,'node','--input-type=module','-e',source,json.dumps({'url':url,'payload':payload})],
            capture_output=True,text=True,encoding='utf-8',timeout=45)
        check(run.returncode==0,'ui_post_sender_or_http_unknown')
        values=[json.loads(line) for line in run.stdout.splitlines() if line.startswith('{')]
        check(len(values)==1,'ui_post_receipt_unknown')
        return values[0]
    def sender_id(self,entry):
        return binding.require(self.item(entry),c.destination)['api_id']
    def cleanup(self,entry):
        item=self.item(entry);schema,_,database=c.destination(item)
        c.cleanup(item)
        identifier=item['attempt_id']
        children=",".join(f"(SELECT count(*) FROM {schema}.{table} WHERE attempt_id='{identifier}'::uuid)" for table in c.child_tables(item))
        sql=f"""BEGIN READ ONLY;
SELECT jsonb_build_object('database',current_database(),
 'remaining',jsonb_build_object('attempt',(SELECT count(*) FROM {schema}.term_test_attempt WHERE id='{identifier}'::uuid),
 'marker',(SELECT count(*) FROM {schema}.term_test_attempt WHERE class_name_snapshot='{item['marker']}'),
 'children',jsonb_build_array({children})))::text;COMMIT;"""
        values=self.query(entry,sql);check(len(values)==1 and values[0]['database']==database,'ui_cleanup_database_wrong')
        return {'status':'passed','attempt_id':identifier,'marker':item['marker'],'destination':entry['destination'],'child_tables':list(c.child_tables(item)),'remaining':values[0]['remaining']}

def perform(packet):
    check(packet.get('scope')=='production_fixture','ui_remote_scope_invalid')
    request=packet['request'];ledger=packet['ledger']
    source=packet.get('ledger_source')
    check(isinstance(source,str) and hashlib.sha256(source.encode('utf-8')).hexdigest()==request.get('ledger_sha256'),'ui_raw_ledger_binding_wrong')
    check(json.loads(source)==ledger,'ui_raw_ledger_content_wrong')
    # UI chỉ tiếp tục executor đúng release/digest/sổ đã qua API; không sender khác.
    acceptance=packet.get('acceptance_binding')
    c.require_acceptance(acceptance)
    check(acceptance['ui_ledger_sha256']==request['ledger_sha256'],'ui_acceptance_ledger_changed')
    # Chỉ thư mục journal theo run/case đã có trong ledger hợp lệ.
    from ui_rpc_guard import validate_ledger
    validate_ledger(ledger,packet['manifest'])
    check(request['case_id'] in {e['case_id'] for e in ledger['entries']},'ui_case_unknown')
    bindings=packet.get('database_bindings')
    from ui_rpc_guard import canonical_hash
    check(isinstance(bindings,dict) and canonical_hash(bindings)==request.get('database_bindings_sha256'),'ui_database_binding_packet_wrong')
    folder=r.RELEASE_ROOT/ledger['run_id']/'ui-canary'/request['case_id']
    return execute(request,ledger,packet['manifest'],ProductionBackend(packet['manifest'],packet['expected'],bindings),Journal(folder))
