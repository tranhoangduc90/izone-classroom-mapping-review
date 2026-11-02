import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContextSnapshot} from '../src/context-contract.js';
import {applyContextSnapshot} from '../src/context-sync.js';

// DB mới trong bộ nhớ, người/lớp tổng hợp. Trigger đếm hàng thực sự được ghi,
// không đếm tên SQL hoặc bỏ đối soát freshness/quyền. PG nhiều kết nối kiểm riêng.
const tables=['classroom_course_mapping','student_mapping_review','erp_class_membership_snapshot','reviewer_account','reviewer_class_access'];
function payload(){return{apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',
 classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'Lớp mô phỏng A'},{erp_course_class_id:'1131',erp_class_name_snapshot:'Lớp mô phỏng B'}],
 students:[{public_id:'60000000-0000-4000-8000-000000000001',erp_course_class_id:'1124',erp_student_contact_id:'601',erp_student_name_snapshot:'Học viên mô phỏng A',status:'approved'},{public_id:'60000000-0000-4000-8000-000000000002',erp_course_class_id:'1124',erp_student_contact_id:'602',erp_student_name_snapshot:'Học viên mô phỏng B',status:'approved'}],
 memberships:[{erp_course_class_id:'1124',erp_student_contact_id:'601',erp_student_name_snapshot:'Học viên mô phỏng A',source_state:'active'},{erp_course_class_id:'1124',erp_student_contact_id:'602',erp_student_name_snapshot:'Học viên mô phỏng B',source_state:'active'}],
 accounts:[{email:'context-fixture@example.test',google_subject:null,display_name:'Giáo viên mô phỏng',role:'teacher',status:'active',can_access_all_classes:false}],
 access:[{reviewer_email:'context-fixture@example.test',erp_course_class_id:'1124'}]};}
async function fixture(t){
 let db,pool,native;
 if(process.env.PRACTICE_FIXTURE_DATABASE_URL){native=await(await import('./context-noop-native-fixture.mjs')).nativeContextFixture();({db,pool}=native);t.after(()=>native.close());}
 else{const {PGlite}=await import('@electric-sql/pglite');db=new PGlite();t.after(()=>db.close());pool={connect:async()=>({query:(sql,params)=>db.query(sql,params),release(){}})};}
 await db.exec(await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8'));
 await db.exec(`CREATE TABLE public.fixture_mutation(table_name text,operation text);
  CREATE FUNCTION public.fixture_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  BEGIN INSERT INTO public.fixture_mutation VALUES(TG_TABLE_NAME,TG_OP); RETURN NULL; END $$;`);
 for(const table of tables)await db.exec(`CREATE TRIGGER fixture_changed AFTER INSERT OR UPDATE OR DELETE ON mapping.${table} FOR EACH ROW EXECUTE FUNCTION public.fixture_changed()`);
 if(native)await native.grantAndVerify();
 return{db,pool,clear:()=>db.exec('TRUNCATE public.fixture_mutation'),mutations:async()=>(await db.query('SELECT table_name,operation,count(*)::int n FROM public.fixture_mutation GROUP BY table_name,operation ORDER BY table_name,operation')).rows};
}
test('Same source advances freshness without rewriting mirrors or a native Google binding',async t=>{
 const f=await fixture(t),p=payload(),at=Date.now();await applyContextSnapshot(f.pool,createContextSnapshot(p,at),at);
 await f.db.query("UPDATE mapping.reviewer_account SET google_subject='fixture-bound-subject' WHERE email=$1",[p.accounts[0].email]);
 const prior=(await f.db.query('SELECT google_subject,updated_at FROM mapping.reviewer_account')).rows[0];await f.clear();
 const next=createContextSnapshot(p,at+1000);await applyContextSnapshot(f.pool,next,at+1000);
 assert.deepEqual(await f.mutations(),[]);
 assert.deepEqual((await f.db.query('SELECT google_subject,updated_at FROM mapping.reviewer_account')).rows[0],prior);
 const state=(await f.db.query('SELECT source_revision,captured_at FROM mapping.k67_context_state')).rows[0];assert.equal(state.source_revision,next.sourceRevision);assert.equal(new Date(state.captured_at).toISOString(),next.capturedAt);
});
test('Unchanged source repairs local mirror drift and writes only the affected row',async t=>{
 const f=await fixture(t),p=payload(),at=Date.now();await applyContextSnapshot(f.pool,createContextSnapshot(p,at),at);
 await f.db.query("UPDATE mapping.student_mapping_review SET erp_student_name_snapshot='Drift mô phỏng' WHERE public_id=$1",[p.students[0].public_id]);await f.clear();
 await applyContextSnapshot(f.pool,createContextSnapshot(p,at+1000),at+1000);
 assert.equal((await f.db.query('SELECT erp_student_name_snapshot FROM mapping.student_mapping_review WHERE public_id=$1',[p.students[0].public_id])).rows[0].erp_student_name_snapshot,p.students[0].erp_student_name_snapshot);
 assert.deepEqual(await f.mutations(),[{table_name:'student_mapping_review',operation:'UPDATE',n:1}]);
});
test('Real additions, removals, roster changes and grant revocation remain effective',async t=>{
 const f=await fixture(t),p=payload(),at=Date.now();await applyContextSnapshot(f.pool,createContextSnapshot(p,at),at);
 await f.db.query("INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at) VALUES($1,$2,'fixture-subject',now()+interval '90 days',now()+interval '365 days')",[Buffer.from('synthetic-token-hash'),p.accounts[0].email]);
 const next=structuredClone(p);next.students=next.students.slice(0,1);next.students[0].erp_student_name_snapshot='Tên mới mô phỏng';next.memberships=next.memberships.slice(0,1);next.memberships[0].source_state='missing';next.access.push({reviewer_email:p.accounts[0].email,erp_course_class_id:'1131'});
 await applyContextSnapshot(f.pool,createContextSnapshot(next,at+1000),at+1000);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM mapping.student_mapping_review')).rows[0].n,1);assert.equal((await f.db.query('SELECT erp_student_name_snapshot FROM mapping.student_mapping_review')).rows[0].erp_student_name_snapshot,'Tên mới mô phỏng');
 assert.equal((await f.db.query('SELECT source_state FROM mapping.erp_class_membership_snapshot')).rows[0].source_state,'missing');assert.equal((await f.db.query('SELECT count(*)::int n FROM mapping.reviewer_class_access')).rows[0].n,2);assert.equal((await f.db.query('SELECT revoked_reason FROM mapping.reviewer_session')).rows[0].revoked_reason,'context_changed');
});
if(process.env.PRACTICE_FIXTURE_DATABASE_URL)test('Live course5 classes retain their ERP course ID and course6 stays rejected',async t=>{
 const f=await fixture(t),p=payload(),at=Date.now();p.classes.push({erp_course_class_id:'990020067',erp_class_name_snapshot:'Lớp ERP mới mô phỏng',erp_course_id:'5'});
 p.students[0].erp_course_class_id='990020067';p.memberships[0].erp_course_class_id='990020067';p.access.push({reviewer_email:p.accounts[0].email,erp_course_class_id:'990020067'});
 const snapshot=createContextSnapshot(p,at);await applyContextSnapshot(f.pool,snapshot,at);
 const row=(await f.db.query("SELECT erp_course_id FROM mapping.classroom_course_mapping WHERE erp_course_class_id=990020067")).rows[0];assert.equal(String(row.erp_course_id),'5');
 const invalid=structuredClone(p);invalid.classes.at(-1).erp_course_id='6';assert.throws(()=>createContextSnapshot(invalid,at+1000),/CONTEXT_OUTSIDE_SCOPE/);
 assert.equal((await f.db.query('SELECT source_revision FROM mapping.k67_context_state')).rows[0].source_revision,snapshot.sourceRevision);
});
if(process.env.PRACTICE_FIXTURE_DATABASE_URL)test('Context transaction rollback retains grants, sessions, mirror and freshness',async t=>{
 const f=await fixture(t),p=payload(),at=Date.now(),original=createContextSnapshot(p,at);await applyContextSnapshot(f.pool,original,at);
 await f.db.query("INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at) VALUES($1,$2,'fixture-subject',now()+interval '90 days',now()+interval '365 days')",[Buffer.from('rollback-synthetic-hash'),p.accounts[0].email]);
 await f.db.exec("ALTER TABLE mapping.classroom_course_mapping ADD CONSTRAINT fixture_reject CHECK(erp_class_name_snapshot <> 'REJECTED_FIXTURE')");await f.clear();
 const changed=structuredClone(p);changed.accounts[0].role='admin';changed.accounts[0].can_access_all_classes=true;changed.access=[];changed.classes[0].erp_class_name_snapshot='REJECTED_FIXTURE';
 await assert.rejects(applyContextSnapshot(f.pool,createContextSnapshot(changed,at+1000),at+1000),e=>e.code==='23514');
 assert.equal((await f.db.query('SELECT role FROM mapping.reviewer_account')).rows[0].role,'teacher');assert.equal((await f.db.query('SELECT count(*)::int n FROM mapping.reviewer_class_access')).rows[0].n,1);assert.equal((await f.db.query('SELECT revoked_at FROM mapping.reviewer_session')).rows[0].revoked_at,null);
 assert.equal((await f.db.query('SELECT source_revision FROM mapping.k67_context_state')).rows[0].source_revision,original.sourceRevision);assert.deepEqual(await f.mutations(),[]);
 const older={...original,capturedAt:new Date(at-1).toISOString()};await assert.rejects(applyContextSnapshot(f.pool,older,at+1000),/CONTEXT_OLDER_SNAPSHOT/);assert.deepEqual(await f.mutations(),[]);
});
if(process.env.PRACTICE_FIXTURE_DATABASE_URL)test('Context SQL benchmark measures exact live baseline against differential mirror',async t=>{
 const {applyContextSnapshot:baseline}=await import('./baseline/context-sync.js'),p=payload(),ids=['1124','1131','1135','1157'];
 p.classes=ids.map((id,i)=>({erp_course_class_id:id,erp_class_name_snapshot:'Lớp benchmark '+i,erp_course_id:'5'}));
 p.students=Array.from({length:40},(_,i)=>({public_id:'70000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),erp_course_class_id:ids[i%4],erp_student_contact_id:String(8000+i),erp_student_name_snapshot:'Học viên benchmark '+i,status:'approved'}));
 p.memberships=p.students.map(x=>({erp_course_class_id:x.erp_course_class_id,erp_student_contact_id:x.erp_student_contact_id,erp_student_name_snapshot:x.erp_student_name_snapshot,source_state:'active'}));
 p.accounts=Array.from({length:10},(_,i)=>({email:'context-benchmark-'+i+'@example.test',google_subject:null,display_name:'Giáo viên benchmark '+i,role:'teacher',status:'active',can_access_all_classes:false}));p.access=p.accounts.flatMap(a=>ids.map(id=>({reviewer_email:a.email,erp_course_class_id:id})));
 const measured={};for(const [kind,apply] of [['baseline',baseline],['optimized',applyContextSnapshot]]){
  const f=await fixture(t),at=Date.now();await apply(f.pool,createContextSnapshot(p,at),at);await f.clear();let commands=0;
  const counted={connect:async()=>{const c=await f.pool.connect();return{query:(...args)=>{commands++;return c.query(...args);},release:()=>c.release()};}};
  const next=createContextSnapshot(p,at+1000);await apply(counted,next,at+1000);measured[kind]={sqlCommands:commands,mirrorRowsWritten:(await f.mutations()).reduce((n,x)=>n+x.n,0)};
  assert.equal(new Date((await f.db.query('SELECT captured_at FROM mapping.k67_context_state')).rows[0].captured_at).toISOString(),next.capturedAt);
 }
 assert.ok(measured.optimized.sqlCommands<measured.baseline.sqlCommands);assert.ok(measured.baseline.mirrorRowsWritten>0);assert.equal(measured.optimized.mirrorRowsWritten,0);
 console.log(JSON.stringify({event:'term_context_noop_benchmark',...measured,fixture:{classes:4,students:40,memberships:40,accounts:10,grants:40},scope:'one apply transaction including BEGIN/COMMIT; setup/seed/audit reads excluded',productionCapacityClaim:false}));
});
