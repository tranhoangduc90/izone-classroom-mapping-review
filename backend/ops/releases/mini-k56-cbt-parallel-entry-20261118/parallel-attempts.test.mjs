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
const read=name=>readFile(new URL(name,import.meta.url),'utf8');
test('Mini CBT native SQL admits parallel runs, serializes the first seal and keeps legacy/paper/Term data',async()=>{
 const pool=new Pool({connectionString:local,max:3,application_name:'goal-mini-cbt-synthetic'});
 const schema='mini_cbt_fixture_'+randomUUID().replaceAll('-','');assert.match(schema,/^mini_cbt_fixture_[a-f0-9]{32}$/);
 const q=(target,sql,args)=>target.query(sql.replaceAll('assessment.',schema+'.'),args);
 let one,two;
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
    (test_slug,definition_version,erp_course_class_id,erp_student_contact_id) WHERE listening_submitted_at IS NULL AND superseded_at IS NULL;
   CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student ON assessment.term_test_attempt
    (test_slug,definition_version,erp_course_class_id,erp_student_contact_id) WHERE completed_at IS NULL AND superseded_at IS NULL;`);
  await q(pool,await read('../term2-k56-parallel-entry-20261117/parallel-attempts.sql'));
  await q(pool,await read('../term1-k56-parallel-entry-20261118/parallel-attempts.sql'));
  await q(pool,await read('../term1-k56-parallel-entry-20261118/term2-valid-submission-only.sql'));
  const legacy=randomUUID(),paper=randomUUID();
  await q(pool,"INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,reading_submitted_at,reading_answers) VALUES($1,'mini-test-k56',5699,now(),'{\"1\":\"legacy Mini\"}')",[legacy]);
  await q(pool,"INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,attempt_mode,reading_answers) VALUES($1,'mini-test-k56',5688,'answer_sheet','{\"1\":\"paper draft\"}')",[paper]);
  const historical=(await q(pool,'SELECT id,to_jsonb(a) AS value FROM assessment.term_test_attempt a ORDER BY id')).rows;
  await q(pool,await read('./parallel-attempts.sql'));
  assert.deepEqual((await q(pool,"SELECT id,to_jsonb(a)-'mini_cbt_parallel_entry'-'mini_cbt_official_submission' AS value FROM assessment.term_test_attempt a ORDER BY id")).rows,historical);
  await assert.rejects(q(pool,"UPDATE assessment.term_test_attempt SET reading_answers='{\"1\":\"overwrite\"}' WHERE id=$1",[legacy]),{code:'P5664'});
  const attempt=async(slug,person,version=1)=>{
   const id=randomUUID(),session=randomUUID(),mini=slug==='mini-test-k56';
   await q(pool,`INSERT INTO assessment.term_test_exam_session(id,test_slug,erp_student_contact_id,definition_version,mini_cbt_parallel_entry,term1_parallel_entry,term2_parallel_entry)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[session,slug,person,version,mini,slug==='term-test-1-k56',slug==='term-test-2-k56']);
   await q(pool,'INSERT INTO assessment.term_test_attempt(id,test_slug,erp_student_contact_id,definition_version,exam_session_id) VALUES($1,$2,$3,$4,$5)',[id,slug,person,version,session]);
   return id;
  };
  const slug='mini-test-k56',a=await attempt(slug,5602),b=await attempt(slug,5602);
  one=await pool.connect();two=await pool.connect();await one.query('BEGIN');await two.query('BEGIN');
  await q(one,"UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),reading_answers='{\"1\":\"winner\"}' WHERE id=$1",[a]);
  const loser=assert.rejects(q(two,"UPDATE assessment.term_test_attempt SET listening_submitted_at=now(),listening_answers='{\"1\":\"contender\"}' WHERE id=$1",[b]),
   e=>e.code==='23505'&&e.constraint==='uq_mini_cbt_k56_official_submission');
  let waiting=false;
  for(let i=0;i<40&&!waiting;i++){
   const {rows:[row]}=await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[two.processID]);
   waiting=row?.wait_event_type==='Lock';if(!waiting)await wait(25);
  }
  assert.equal(waiting,true,'The second transaction must contend before the first commit');
  await one.query('COMMIT');await loser;await two.query('ROLLBACK');one.release();one=null;two.release();two=null;
  assert.deepEqual((await q(pool,'SELECT id,reading_answers FROM assessment.term_test_attempt WHERE mini_cbt_official_submission')).rows,[{id:a,reading_answers:{1:'winner'}}]);
  const changed=await attempt(slug,5602,2);
  await assert.rejects(q(pool,"UPDATE assessment.term_test_attempt SET writing_submitted_at=now(),writing_task_2='changed definition' WHERE id=$1",[changed]),{code:'P5663'});
  const interrupted=await attempt(slug,5605),valid=await attempt(slug,5605);
  await q(pool,'UPDATE assessment.term_test_attempt SET listening_interrupted_at=now() WHERE id=$1',[interrupted]);
  assert.equal((await q(pool,'SELECT mini_cbt_official_submission FROM assessment.term_test_attempt WHERE id=$1',[interrupted])).rows[0].mini_cbt_official_submission,false);
  await q(pool,"UPDATE assessment.term_test_attempt SET listening_submitted_at=now(),listening_answers='{\"1\":\"valid\"}' WHERE id=$1",[valid]);
  for(const term of ['term-test-1-k56','term-test-2-k56']){
   const first=await attempt(term,5606),second=await attempt(term,5606);assert.notEqual(first,second);
   await q(pool,"UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),reading_answers='{\"1\":\"Term preserved\"}' WHERE id=$1",[first]);
   assert.equal((await q(pool,'SELECT mini_cbt_parallel_entry,mini_cbt_official_submission FROM assessment.term_test_attempt WHERE id=$1',[first])).rows[0].mini_cbt_parallel_entry,false);
  }
  const paperSession=randomUUID();
  await assert.rejects(q(pool,"INSERT INTO assessment.term_test_exam_session(id,test_slug,erp_student_contact_id,attempt_mode,mini_cbt_parallel_entry) VALUES($1,'mini-test-k56',5607,'answer_sheet',true)",[paperSession]),{code:'23514'});
  assert.deepEqual((await q(pool,'SELECT reading_answers,attempt_mode FROM assessment.term_test_attempt WHERE id=$1',[paper])).rows,[{reading_answers:{1:'paper draft'},attempt_mode:'answer_sheet'}]);
  const other=await attempt(slug,5610);await q(pool,"UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),reading_answers='{\"1\":\"other person\"}' WHERE id=$1",[other]);
  console.log(JSON.stringify({postgresVersion:(await pool.query('SHOW server_version')).rows[0].server_version,realConcurrentTransactions:true,firstSealUnique:true,
   legacyMiniPreserved:true,paperPreserved:true,paperCannotUseCbtFlag:true,otherPersonIndependent:true,interruptionDoesNotReserve:true,term1AndTerm2ParallelPreserved:true}));
 }finally{
  if(one){await one.query('ROLLBACK');one.release();}if(two){await two.query('ROLLBACK');two.release();}
  await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();
 }
});
