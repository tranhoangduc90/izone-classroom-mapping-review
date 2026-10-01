// Nhận URL từ PROGRESS_LOG_TEST_DATABASE_URL, chỉ chấp nhận DB test riêng trên localhost.
// Tạo fixture giả, chạy nhiều kết nối PostgreSQL thật và đọc lại các phép ghi.
// Không xóa database, không gọi ERP/Portal; lỗi chỉ in mã, không in URL/mật khẩu.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningService} from '../src/learning-service.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {isolatedPostgresConfig} from './progress-log-postgres-test-config.mjs';

const input=process.env.PROGRESS_LOG_TEST_DATABASE_URL;
let pool;
let cleanupFailures=0;
async function releaseClient(client) {
  if(!client)return;
  // Lỗi rollback không được bỏ qua release hoặc thay lỗi nghiệp vụ ban đầu.
  let broken=false;
  try {await client.query('ROLLBACK;');}catch{broken=true;cleanupFailures++;}
  finally{client.release(broken);}
}
async function main() {
  const config=isolatedPostgresConfig(input,process.env.PROGRESS_LOG_TEST_DATABASE_CONFIRM);
  pool=new pg.Pool(config);
  const checked=await pool.query(`SELECT current_database() AS name,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema'))::integer AS tables;`);
  assert.equal(checked.rows[0].name,config.database,'DATABASE_ID_MISMATCH');
  assert.equal(checked.rows[0].tables,0,'EMPTY_DATABASE_REQUIRED');
  const db={query:(sql,params)=>pool.query(sql,params),exec:sql=>pool.query(sql)};
  await initializeLearningDemoDatabase(db);
  for(const file of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql',
    '202610010001_progress_log_form_drafts.sql'])await db.exec(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
  await db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp kiểm thử riêng','approved',NULL,NULL);
    INSERT INTO mapping.reviewer_account VALUES('teacher@example.test','active');
    INSERT INTO mapping.reviewer_class_access VALUES('teacher@example.test',1294);
    INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES(1294,111,'Học viên giả');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,111);
    INSERT INTO learning.course_content_authority(reviewer_email,course_code,can_self_approve_scored_forms,grant_reference)
      VALUES('teacher@example.test','ic23',true,'Isolated PostgreSQL fixture only');`);
  const reviewer={email:'teacher@example.test',canAccessAllClasses:false};
  const modern=createLearningFormDraftService({pool}),legacy=createLearningService({pool});
  const content=()=>{const parsed=previewFormImport('type,prompt\nreflection,Câu hỏi giả');
    assert.deepEqual(parsed.errors,[]);parsed.payload.definition.courseCode='ic23';return parsed.payload;};
  const draft=async(sessionNumber)=>{const value=await modern.create({classId:'1294',sessionNumber,
    operationId:crypto.randomUUID(),...content(),reviewer});
    await modern.approve({id:value.id,expectedRevision:1,expectedHash:value.contentHash,reviewer});return value;};
  const oldInput=sessionNumber=>({reviewer,title:'Phiếu giả',courseCode:'ic23',classId:'1294',sessionNumber,
    items:[{libraryItemId:'10000000-0000-4000-8000-000000000001',checkpoint:1,required:true}]});
  const active=async session=>(await pool.query("SELECT count(*)::integer AS n FROM learning.form_assignment WHERE session_number=$1 AND status IN ('published','closed');",[session])).rows[0].n;
  const checks=[];
  // Cùng operation ở hai kết nối phải trả cùng assignment, chỉ một lượt thực sự tạo.
  const same=await draft(1),operationId=crypto.randomUUID();
  const retries=await Promise.all([modern.publish({id:same.id,expectedRevision:1,operationId,reviewer}),
    modern.publish({id:same.id,expectedRevision:1,operationId,reviewer})]);
  assert.equal(retries[0].assignmentId,retries[1].assignmentId);assert.equal(await active(1),1);
  checks.push('same_operation_one_assignment');
  for(const oldFirst of [true,false]) {
    const session=oldFirst?2:3,candidate=await draft(session);
    const old=()=>legacy.publishReflectionForm(oldInput(session));
    const next=()=>modern.publish({id:candidate.id,expectedRevision:1,operationId:crypto.randomUUID(),reviewer});
    const race=await Promise.allSettled(oldFirst?[old(),next()]:[next(),old()]);
    assert.equal(race.filter(row=>row.status==='fulfilled').length,1);
    assert.equal(race.find(row=>row.status==='rejected').reason.code,'ASSIGNMENT_SESSION_CONFLICT');
    assert.equal(await active(session),1);
  }
  checks.push('legacy_modern_conflict_409');
  // Chứng minh khóa thực sự chặn connection thứ hai trước khi connection thứ nhất COMMIT.
  let first,second;
  try {
    first=await pool.connect();second=await pool.connect();
    const pids=await Promise.all([first.query('SELECT pg_backend_pid() AS pid;'),second.query('SELECT pg_backend_pid() AS pid;')]);
    assert.notEqual(pids[0].rows[0].pid,pids[1].rows[0].pid);
    const insert=`INSERT INTO learning.form_assignment(form_version_id,course_code,erp_course_class_id,class_name_snapshot,session_number,title,created_by_email)
      SELECT form_version_id,course_code,erp_course_class_id,class_name_snapshot,$2,'Phiếu giả đồng thời',created_by_email FROM learning.form_assignment WHERE id=$1::uuid RETURNING id;`;
    await first.query('BEGIN;');await second.query('BEGIN;');
    await first.query(insert,[retries[0].assignmentId,4]);
    const waiting=second.query(insert,[retries[0].assignmentId,4]).then(value=>({value}),error=>({error}));
    let lockObserved=false;
    for(let step=0;step<30;step++) {
      const observation=await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1;',[pids[1].rows[0].pid]);
      if(observation.rows[0]?.wait_event_type==='Lock'){lockObserved=true;break;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(lockObserved,true,'NO_REAL_LOCK_WAIT');
    await first.query('COMMIT;');const result=await waiting;assert.ok(result.value);
    await assert.rejects(()=>second.query('COMMIT;'),error=>error.code==='23505'&&error.constraint==='assignment_session_once');
    await second.query('ROLLBACK;');assert.equal(await active(4),1);
    checks.push('distinct_connections_lock_wait_commit_guard');
  }finally{await releaseClient(first);await releaseClient(second);}
  const original=await legacy.publishReflectionForm(oldInput(5)),client=await pool.connect();
  try {
    await client.query('BEGIN;');
    const copied=await client.query(`INSERT INTO learning.form_assignment(form_version_id,course_code,erp_course_class_id,class_name_snapshot,session_number,title,created_by_email)
      SELECT form_version_id,course_code,erp_course_class_id,class_name_snapshot,session_number,'Bản thay giả',created_by_email FROM learning.form_assignment WHERE id=$1::uuid RETURNING id;`,[original.assignmentId]);
    await client.query("UPDATE learning.form_assignment SET status='retired' WHERE id=$1::uuid;",[original.assignmentId]);
    await client.query('COMMIT;');assert.equal(await active(5),1);
    await client.query('BEGIN;');
    const duplicate=await client.query(`INSERT INTO learning.form_assignment(form_version_id,course_code,erp_course_class_id,class_name_snapshot,session_number,title,created_by_email)
      SELECT form_version_id,course_code,erp_course_class_id,class_name_snapshot,session_number,'Bản trùng giả',created_by_email FROM learning.form_assignment WHERE id=$1::uuid RETURNING id;`,[copied.rows[0].id]);
    await assert.rejects(()=>client.query('UPDATE learning.form_assignment SET id=$1::uuid WHERE id=$2::uuid;',[crypto.randomUUID(),duplicate.rows[0].id]),
      error=>error.code==='23514'&&error.message.includes('ASSIGNMENT_ID_IMMUTABLE'));
    await client.query('ROLLBACK;');assert.equal(await active(5),1);
    checks.push('replacement_and_id_change_guard');
  }finally{await releaseClient(client);}
  // Ngắt ghi roster giữa publish: không để lại version/assignment; thử lại vẫn dùng được nháp.
  const pending=await draft(6),before=await active(6);
  const countContent=async()=>(await pool.query(`SELECT
    (SELECT count(*)::integer FROM learning.form_template) AS templates,
    (SELECT count(*)::integer FROM learning.form_version) AS versions,
    (SELECT count(*)::integer FROM learning.form_grading_key) AS keys;`)).rows[0];
  const contentBefore=await countContent();
  const brokenPool={query:pool.query.bind(pool),async connect(){const client=await pool.connect();return {
    release:()=>client.release(),query(sql,params){if(sql.startsWith('INSERT INTO learning.form_assignment_roster'))throw Error('Injected roster failure');return client.query(sql,params);}};}};
  const rollbackOperation=crypto.randomUUID();
  await assert.rejects(()=>createLearningFormDraftService({pool:brokenPool}).publish({id:pending.id,expectedRevision:1,operationId:rollbackOperation,reviewer}),/Injected roster failure/);
  assert.equal(await active(6),before);assert.equal((await modern.get({id:pending.id,reviewer})).status,'approved');
  assert.deepEqual(await countContent(),contentBefore);
  const retried=await modern.publish({id:pending.id,expectedRevision:1,operationId:rollbackOperation,reviewer});
  assert.ok(retried.assignmentId);assert.equal(await active(6),1);
  checks.push('failed_transaction_rollback');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM learning.outbox_job;')).rows[0].n,0);
  const migration=await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8');
  await db.exec(migration);assert.equal(await active(1),1);checks.push('migration_replay_preserves_data_no_outbox');
  assert.equal(cleanupFailures,0,'CLEANUP_FAILED');
  process.stdout.write(JSON.stringify({outcome:'success',checks,checkCount:checks.length,capturedAt:new Date().toISOString()})+'\n');
}
try {await main();}catch(error){process.stderr.write(JSON.stringify({outcome:'failure',code:error.code||error.name,
  reason:error instanceof assert.AssertionError?error.message:'POSTGRES_GATE_FAILED'})+'\n');process.exitCode=1;}
finally{if(pool)await pool.end();}
