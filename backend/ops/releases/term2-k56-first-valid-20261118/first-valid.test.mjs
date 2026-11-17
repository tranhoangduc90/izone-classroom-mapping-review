import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {setTimeout as wait} from 'node:timers/promises';
import test from 'node:test';
const local='postgresql://k67_fixture_admin@127.0.0.1:55468/postgres';
assert.equal(process.env.K67_ORDER_NATIVE_URL,local,'Local synthetic PostgreSQL only');
assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM,'local-synthetic-20261014');
const {Pool}=createRequire(process.env.TERM2_DEPS_PACKAGE)('pg');
const base=await readFile(new URL('../term2-k56-parallel-entry-20261117/parallel-attempts.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('./migration.sql',import.meta.url),'utf8');

test('Term2 first valid slot excludes interruption and preserves history and sealed answers',async()=>{
 const pool=new Pool({connectionString:local,max:3,application_name:'goal-term2-k56-first-valid'});
 const schema='term2_valid_fixture_'+randomUUID().replaceAll('-','');
 assert.match(schema,/^term2_valid_fixture_[a-f0-9]{32}$/);
 const q=(executor,sql,values)=>executor.query(sql.replaceAll('assessment.',schema+'.'),values);
 let first,second;
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await q(pool,`CREATE TABLE assessment.term_test_exam_session (
   id uuid PRIMARY KEY,test_slug text NOT NULL,definition_version int DEFAULT 1,
   erp_course_class_id bigint DEFAULT 5601,erp_student_contact_id bigint NOT NULL,
   attempt_mode text DEFAULT 'cbt',generation bigint DEFAULT 0,listening_submitted_at timestamptz,superseded_at timestamptz);
   CREATE TABLE assessment.term_test_attempt (
   id uuid PRIMARY KEY,test_slug text NOT NULL,definition_version int DEFAULT 1,
   erp_course_class_id bigint DEFAULT 5601,erp_student_contact_id bigint NOT NULL,exam_session_id uuid,
   attempt_mode text DEFAULT 'cbt',generation bigint DEFAULT 0,completed_at timestamptz,superseded_at timestamptz,
   listening_interrupted_at timestamptz,listening_submitted_at timestamptz,listening_answers jsonb,
   reading_submitted_at timestamptz,reading_answers jsonb,writing_submitted_at timestamptz,writing_task_1 text);
   CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student ON assessment.term_test_exam_session
   (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
   WHERE listening_submitted_at IS NULL AND superseded_at IS NULL;
   CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student ON assessment.term_test_attempt
   (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
   WHERE completed_at IS NULL AND superseded_at IS NULL;`);
  await q(pool,base);
  const interrupted=randomUUID(),sealed=randomUUID();
  await q(pool,`INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,listening_interrupted_at)
    VALUES($1,'term-test-2-k56',5602,now())`,[interrupted]);
  await q(pool,`INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,reading_submitted_at,reading_answers)
    VALUES($1,'term-test-2-k56',5603,now(),'{"1":"old"}')`,[sealed]);
  const snapshot=async id=>(await q(pool,"SELECT to_jsonb(a)-'term2_official_submission' AS value FROM assessment.term_test_attempt a WHERE id=$1",[id])).rows[0].value;
  const before=await snapshot(interrupted),sealedBefore=await snapshot(sealed);
  assert.equal((await q(pool,'SELECT term2_official_submission FROM assessment.term_test_attempt WHERE id=$1',[interrupted])).rows[0].term2_official_submission,true);
  await q(pool,migration);
  assert.deepEqual(await snapshot(interrupted),before);
  assert.deepEqual(await snapshot(sealed),sealedBefore);
  assert.equal((await q(pool,'SELECT term2_official_submission FROM assessment.term_test_attempt WHERE id=$1',[interrupted])).rows[0].term2_official_submission,false);
  await assert.rejects(q(pool,"UPDATE assessment.term_test_attempt SET reading_answers='{}' WHERE id=$1",[sealed]),{code:'P5652'});
  const attempt=async person=>{
   const id=randomUUID(),session=randomUUID();
   await q(pool,`INSERT INTO assessment.term_test_exam_session(id,test_slug,erp_student_contact_id,term2_parallel_entry)
     VALUES($1,'term-test-2-k56',$2,true)`,[session,person]);
   await q(pool,`INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,exam_session_id)
     VALUES($1,'term-test-2-k56',$2,$3)`,[id,person,session]);
   return id;
  };
  const a=await attempt(5602),b=await attempt(5602);
  first=await pool.connect();second=await pool.connect();
  await first.query('BEGIN');await second.query('BEGIN');
  await q(first,"UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),reading_answers='{\"1\":\"A\"}' WHERE id=$1",[a]);
  const rejected=assert.rejects(q(second,"UPDATE assessment.term_test_attempt SET listening_submitted_at=now(),listening_answers='{\"1\":\"B\"}' WHERE id=$1",[b]),
   error=>error.code==='23505'&&error.constraint==='uq_term2_k56_official_submission');
  let contending=false;
  for(let i=0;i<40&&!contending;i++){
   const {rows:[row]}=await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[second.processID]);
   contending=row?.wait_event_type==='Lock';if(!contending)await wait(25);
  }
  assert.equal(contending,true);await first.query('COMMIT');await rejected;await second.query('ROLLBACK');
  first.release();first=null;second.release();second=null;
  assert.deepEqual((await q(pool,'SELECT id FROM assessment.term_test_attempt WHERE erp_student_contact_id=5602 AND term2_official_submission')).rows,[{id:a}]);
  console.log(JSON.stringify({interruptionHistoryPreserved:true,sealedPayloadImmutable:true,realConcurrentTransactions:true,oneFirstValid:true}));
 }finally{
  if(first){await first.query('ROLLBACK');first.release();}if(second){await second.query('ROLLBACK');second.release();}
  await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();
 }
});
