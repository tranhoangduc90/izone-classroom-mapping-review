import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
const local='postgresql://k67_fixture_admin@127.0.0.1:55468/postgres';
assert.equal(process.env.K67_ORDER_NATIVE_URL,local,'Local synthetic PostgreSQL only');
assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM,'local-synthetic-20261014');
const {Pool}=createRequire(process.env.TERM2_DEPS_PACKAGE)('pg');
const term2=await readFile(new URL('../term2-k56-parallel-entry-20261117/parallel-attempts.sql',import.meta.url),'utf8');
const term1=await readFile(new URL('./parallel-attempts.sql',import.meta.url),'utf8');
const term2Valid=await readFile(new URL('./term2-valid-submission-only.sql',import.meta.url),'utf8');
test('Term1 K56 SQL serializes first valid submissions, preserves old answers and leaves Term2 parallel',async()=>{
 const pool=new Pool({connectionString:local,max:3,application_name:'goal-term1-k56-synthetic'});
 const schema='term1_k56_fixture_'+randomUUID().replaceAll('-','');
 assert.match(schema,/^term1_k56_fixture_[a-f0-9]{32}$/);
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
    reading_submitted_at timestamptz,reading_answers jsonb,writing_submitted_at timestamptz,writing_task_1 text,writing_task_2 text);
   CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student ON assessment.term_test_exam_session
     (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
     WHERE listening_submitted_at IS NULL AND superseded_at IS NULL;
   CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student ON assessment.term_test_attempt
     (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
     WHERE completed_at IS NULL AND superseded_at IS NULL;`);
  await q(pool,term2);
  const oldInterrupted=randomUUID();
  await q(pool,"INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,listening_interrupted_at) VALUES($1,'term-test-2-k56',5608,now())",[oldInterrupted]);
  const oldHistory=(await q(pool,"SELECT to_jsonb(a)-'term2_official_submission' AS value FROM assessment.term_test_attempt a WHERE id=$1",[oldInterrupted])).rows[0].value;
  assert.equal((await q(pool,'SELECT term2_official_submission FROM assessment.term_test_attempt WHERE id=$1',[oldInterrupted])).rows[0].term2_official_submission,true);
  const legacy=randomUUID();
  await q(pool,"INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,reading_submitted_at,reading_answers) VALUES($1,'term-test-1-k56',5603,now(),'{\"1\":\"old\"}')",[legacy]);
  await q(pool,term1);
  await q(pool,term2Valid);
  assert.equal((await q(pool,'SELECT term2_official_submission FROM assessment.term_test_attempt WHERE id=$1',[oldInterrupted])).rows[0].term2_official_submission,false);
  const updatedHistory=(await q(pool,"SELECT to_jsonb(a)-'term2_official_submission' AS value FROM assessment.term_test_attempt a WHERE id=$1",[oldInterrupted])).rows[0].value;
  // The additive Term1 migration adds its two false columns to all rows.
  const {term1_parallel_entry,term1_official_submission,...preservedHistory}=updatedHistory;
  assert.equal(term1_parallel_entry,false);assert.equal(term1_official_submission,false);
  assert.deepEqual(preservedHistory,oldHistory);
  await assert.rejects(q(pool,"UPDATE assessment.term_test_attempt SET reading_answers='{\"1\":\"changed\"}' WHERE id=$1",[legacy]),{code:'P5654'});
  const session=async(slug,person,version=1)=>{
   const id=randomUUID();
   await q(pool,`INSERT INTO assessment.term_test_exam_session
     (id,test_slug,erp_student_contact_id,definition_version,term1_parallel_entry,term2_parallel_entry)
     VALUES($1,$2,$3,$4,$5,$6)`,[id,slug,person,version,slug==='term-test-1-k56',slug==='term-test-2-k56']);
   return id;
  };
  const attempt=async(slug,person,version=1)=>{
   const id=randomUUID(),sessionId=await session(slug,person,version);
   await q(pool,'INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,definition_version,exam_session_id) VALUES($1,$2,$3,$4,$5)',[id,slug,person,version,sessionId]);
   return id;
  };
  const slug='term-test-1-k56',a=await attempt(slug,5602),b=await attempt(slug,5602);
  first=await pool.connect();second=await pool.connect();
  await first.query('BEGIN');await second.query('BEGIN');
  await q(first,"UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),reading_answers='{\"1\":\"A\"}' WHERE id=$1",[a]);
  const rejected=assert.rejects(q(second,"UPDATE assessment.term_test_attempt SET listening_submitted_at=now(),listening_answers='{\"1\":\"B\"}' WHERE id=$1",[b]),
    error=>error.code==='23505'&&error.constraint==='uq_term1_k56_official_submission');
  let contending=false;
  for(let i=0;i<40&&!contending;i++){
   const {rows:[row]}=await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[second.processID]);
   contending=row?.wait_event_type==='Lock';if(!contending)await wait(25);
  }
  assert.equal(contending,true);await first.query('COMMIT');await rejected;await second.query('ROLLBACK');
  first.release();first=null;second.release();second=null;
  assert.deepEqual((await q(pool,'SELECT id,reading_answers FROM assessment.term_test_attempt WHERE term1_official_submission')).rows,[{id:a,reading_answers:{1:'A'}}]);
  const changed=await attempt(slug,5602,2);
  await assert.rejects(q(pool,"UPDATE assessment.term_test_attempt SET writing_submitted_at=now(),writing_task_2='new definition' WHERE id=$1",[changed]),{code:'P5653'});
  const interrupted=await attempt(slug,5605),valid=await attempt(slug,5605);
  await q(pool,'UPDATE assessment.term_test_attempt SET listening_interrupted_at=now() WHERE id=$1',[interrupted]);
  assert.equal((await q(pool,'SELECT term1_official_submission FROM assessment.term_test_attempt WHERE id=$1',[interrupted])).rows[0].term1_official_submission,false);
  await q(pool,"UPDATE assessment.term_test_attempt SET listening_submitted_at=now(),listening_answers='{\"1\":\"valid\"}' WHERE id=$1",[valid]);
  assert.equal((await q(pool,'SELECT term1_official_submission FROM assessment.term_test_attempt WHERE id=$1',[valid])).rows[0].term1_official_submission,true);
  const t2a=await attempt('term-test-2-k56',5606),t2b=await attempt('term-test-2-k56',5606);
  assert.notEqual(t2a,t2b);
  await q(pool,"UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),reading_answers='{\"1\":\"Term2\"}' WHERE id=$1",[t2a]);
  assert.equal((await q(pool,'SELECT term2_official_submission FROM assessment.term_test_attempt WHERE id=$1',[t2a])).rows[0].term2_official_submission,true);
  console.log(JSON.stringify({realConcurrentTransactions:true,oneOfficial:true,oldAnswerImmutable:true,
    changedDefinitionCannotTakeSlot:true,interruptionDoesNotReserve:true,term2ParallelPreserved:true,
    oldInterruptionMarkerCorrectedWithoutChangingHistory:true}));
 }finally{
  if(first){await first.query('ROLLBACK');first.release();}if(second){await second.query('ROLLBACK');second.release();}
  await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();
 }
});
