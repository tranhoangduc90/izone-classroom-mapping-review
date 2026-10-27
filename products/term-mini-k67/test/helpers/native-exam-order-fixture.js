import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

// Nhận URL fixture localhost đã xác nhận; tạo DB riêng với đủ FK, trigger và role.
// Không kết nối VPS. Lỗi setup phải làm test thất bại; không chuyển sang pool giả.
export async function createNativeOrderFixture({examOrder}) {
  assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM,'local-synthetic-20261014');
  const url=new URL(process.env.K67_ORDER_NATIVE_URL);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55468');assert.equal(url.username,'k67_fixture_admin');
  assert.equal(url.pathname,'/postgres');assert.equal(url.password,'');
  const admin=new pg.Pool({connectionString:url.href,max:1});
  const database='term_mini_k67_test_order_'+randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname='/'+database;
  const owner=new pg.Pool({connectionString:url.href,max:2});
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
  url.username='k67_app';const pool=new pg.Pool({connectionString:url.href,max:5});
  const identity=(await pool.query('SELECT current_user AS role,current_database() AS db')).rows[0];
  assert.deepEqual(identity,{role:'k67_app',db:database});
  const db={query:(...args)=>owner.query(...args),exec:sql=>owner.query(sql),
    close:async()=>{await pool.end();await owner.end();await admin.query(`DROP DATABASE ${database}`);await admin.end();}};
  return {db,pool};
}
