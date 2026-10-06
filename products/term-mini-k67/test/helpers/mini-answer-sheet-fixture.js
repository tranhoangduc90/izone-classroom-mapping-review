import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../../src/app.js';

// Dữ liệu lớp và đáp án đều giả; chạy SQL thật trong PostgreSQL nhúng trên máy local.
// Trả ứng dụng và database để kiểm giao diện, đồng thời đọc lại đúng kết quả đã ghi.
export async function createMiniFixture() {
  const db=new PGlite();await db.exec('CREATE SCHEMA assessment;CREATE SCHEMA mapping;');
  const schema=await readFile(new URL('../../db/003-assessment.sql',import.meta.url),'utf8');
  for(const name of ['test_definition','term_test_attempt','term_test_exam_session','term_test_roster','term_test_temporary_student'])
    await db.exec(schema.match(new RegExp(`CREATE TABLE assessment\\.${name} \\([\\s\\S]*?\\n\\);`))[0]);
  for(const [sql] of schema.matchAll(/^CREATE UNIQUE INDEX .*;$/gm))
    if(/ON assessment\.term_test_(attempt|exam_session) /.test(sql))await db.exec(sql);
  await db.exec(`CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,erp_class_name_snapshot text);
    CREATE TABLE mapping.student_mapping_review(public_id uuid,erp_course_class_id bigint,erp_student_contact_id bigint,erp_student_name_snapshot text,status text);
    CREATE TABLE mapping.k67_context_state(singleton boolean,api_version int,product_id text,captured_at timestamptz);
    INSERT INTO mapping.k67_context_state VALUES(true,1,'PRODUCT-TERM-MINI-K67',now());
    INSERT INTO mapping.classroom_course_mapping VALUES(1293,'IC2304');
    INSERT INTO mapping.student_mapping_review VALUES
      ('11111111-1111-4111-8111-111111111111',1293,900001,'Học viên mô phỏng','approved'),
      ('44444444-4444-4444-8444-444444444444',1293,900002,'Người khác','approved');`);
  await db.exec(await readFile(new URL('../../db/007-mini-answer-sheet.sql',import.meta.url),'utf8'));
  const section=(count,start)=>({questions:Array.from({length:count},(_,i)=>({number:i+start,type:'Câu thử',accepted:['A']}))});
  await db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES('mini-test-lesson-5','Đề mô phỏng',1,$1,$2,true)`,[JSON.stringify(section(20,11)),JSON.stringify(section(13,14))]);
  // Một connection PostgreSQL nhúng: xếp hàng giao dịch để mô phỏng pool an toàn.
  let queue=Promise.resolve();
  const query=async(sql,args)=>{const r=await db.query(sql,args);return{...r,rowCount:r.rows.length||r.affectedRows||0};};
  const pool={query,connect:async()=>{let release;const gate=new Promise(r=>release=r);const previous=queue;queue=queue.then(()=>gate);await previous;return{query,release};}};
  return {db,app:createApp({pool,config:{allowedOrigins:new Set(['https://tranhoangduc90.github.io']),trustProxyHops:0,authMode:'legacy',legacyReviewToken:'fixture-only-key'}})};
}
