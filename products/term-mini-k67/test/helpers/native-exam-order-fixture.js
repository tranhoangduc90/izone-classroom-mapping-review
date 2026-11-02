import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

// Nhận localhost cố định hoặc PostgreSQL riêng có marker của task; tạo DB ngẫu nhiên.
// Không nhận URL production. Setup lỗi đóng pool và xóa đúng DB vừa tạo, không dùng pool giả.
export async function createNativeOrderFixture({examOrder}) {
  assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM,'local-synthetic-20261014');
  const url=new URL(process.env.K67_ORDER_NATIVE_URL);
  const owned=Boolean(process.env.PRACTICE_FIXTURE_DATABASE_URL);
  if(owned){
    assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
    const expected=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL);assert.equal(url.href,expected.href);
    assert.equal(url.protocol,'postgres:');assert.match(url.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(url.username,'fixture');
  }else{assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55468');assert.equal(url.username,'k67_fixture_admin');}
  assert.equal(url.pathname,'/postgres');assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');
  const admin=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:15000});
  const database='term_mini_k67_test_order_'+randomBytes(6).toString('hex');
  let owner,pool,created=false,closed=false;
  async function close(){
    if(closed)return;closed=true;
    try{await pool?.end();await owner?.end();if(created){assert.match(database,/^term_mini_k67_test_order_[a-f0-9]{12}$/);await admin.query(`DROP DATABASE ${database}`);}}
    finally{await admin.end();}
    if(owned)console.log(JSON.stringify({event:'native_order_fixture_closed',database,appRole:'k67_app',serverVersion:160014}));
  }
  try{
  if(owned){
    assert.equal(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num),160014);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='k67_app') THEN CREATE ROLE k67_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='k67_context_sync') THEN CREATE ROLE k67_context_sync LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
      END $$;`);
  }
  await admin.query(`CREATE DATABASE ${database}`);created=true;
  url.pathname='/'+database;
  owner=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:5000,statement_timeout:15000});
  for(const file of ['001-context.sql','002-history.sql','003-assessment.sql','004-grants.sql','005-context-auth.sql','006-writing-planning.sql','007-mini-answer-sheet.sql'])
    await owner.query(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
  await owner.query(`INSERT INTO mapping.k67_context_state(singleton,api_version,product_id,source_revision,captured_at)
    VALUES(true,1,'PRODUCT-TERM-MINI-K67','local-order-fixture',now());
    INSERT INTO mapping.classroom_course_mapping VALUES(1293,'IC2304');
    INSERT INTO mapping.student_mapping_review VALUES
      ('11111111-1111-4111-8111-111111111111',1293,900001,'Học viên mô phỏng','approved'),
      ('44444444-4444-4444-8444-444444444444',1293,900002,'Người khác','approved');`);
  if(examOrder)await owner.query(await readFile(new URL('../../db/008-exam-order.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../db/009-audio-recovery-events.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../db/010-audio-incidents.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../db/011-audio-asset-pin.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../db/012-audio-owner.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../db/014-audio-preparation-without-owner.sql',import.meta.url),'utf8'));
  const section=(count,start)=>({questions:Array.from({length:count},(_,i)=>({number:i+start,type:'Câu thử',accepted:['A']}))});
  await owner.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES('mini-test-lesson-5','Đề mô phỏng',1,$1,$2,true)`,[JSON.stringify(section(20,11)),JSON.stringify(section(13,14))]);
  url.username='k67_app';pool=new pg.Pool({connectionString:url.href,max:5,connectionTimeoutMillis:5000,statement_timeout:15000});
  const identity=(await pool.query('SELECT current_user AS role,current_database() AS db')).rows[0];
  assert.deepEqual(identity,{role:'k67_app',db:database});
  if(owned)assert.deepEqual((await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0],{rolsuper:false,rolcreatedb:false,rolcreaterole:false});
  const db={query:(...args)=>owner.query(...args),exec:sql=>owner.query(sql),
    close};
  return {db,pool};
  }catch(error){await close();throw error;}
}
