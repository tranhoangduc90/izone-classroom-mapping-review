// Đo HTTP/SQL nhận diện thật trên source ráp từ live, dữ liệu giả trong PostgreSQL nhúng.
// Không đo trọn hành trình, AI hoặc sức chịu tải VPS; không tải media/ghi production.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
const root = process.env.IDENTITY_RUNTIME_CANDIDATES, output = process.env.IDENTITY_LOAD_OUTPUT;
assert.ok(root && output, 'Cần thư mục ứng viên và file kết quả riêng.');
// Chỉ node:http bên dưới được phép gọi 127.0.0.1; app không được gọi dịch vụ ngoài.
globalThis.fetch = () => Promise.reject(new Error('LIVE_NETWORK_FORBIDDEN'));
const origin = 'https://tranhoangduc90.github.io';
const db = new PGlite();
const servers = [], results = [];
let outcome = 'partial', queryCount = 0;
const slugs56 = ['term-test-1-k56','term-test-2-k56','mini-test-k56'];
const slugs67 = ['term-test-1','term-test-2','mini-test-lesson-5'];
const people = Array.from({length:100},(_,i)=>({ id:String(900001+i),
  ref:`11111111-1111-4111-8111-${String(i+1).padStart(12,'0')}`,
  classId:1000+Math.floor(i/25), classCode:'IC'+(9000+Math.floor(i/25)),
  ip:'192.0.2.'+(1+Math.floor(i/25)) }));
try {
  await db.exec(`CREATE SCHEMA mapping;CREATE SCHEMA assessment;CREATE SCHEMA assessment_k56;
    CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint PRIMARY KEY,erp_class_name_snapshot text,status text);
    CREATE TABLE mapping.student_mapping_review(public_id uuid PRIMARY KEY,erp_course_class_id bigint,erp_student_contact_id bigint,erp_student_name_snapshot text,status text);
    CREATE TABLE mapping.erp_class_membership_snapshot(erp_course_class_id bigint,erp_student_contact_id bigint,source_state text,registration_status text);
    CREATE TABLE mapping.k67_context_state(singleton boolean,api_version int,product_id text,captured_at timestamptz);
    INSERT INTO mapping.k67_context_state VALUES(true,1,'PRODUCT-TERM-MINI-K67',now());
    CREATE TABLE assessment.test_definition(slug text PRIMARY KEY,is_active boolean);
    CREATE TABLE assessment.term_test_roster(test_slug text,erp_course_class_id bigint,erp_student_contact_id bigint,student_ref uuid,student_name_snapshot text,is_eligible boolean);
    CREATE TABLE assessment.term_test_class_access(test_slug text,erp_course_class_id bigint,enabled boolean);
    CREATE TABLE assessment_k56.test_definition(LIKE assessment.test_definition INCLUDING ALL);
    CREATE TABLE assessment_k56.term_test_roster(LIKE assessment.term_test_roster INCLUDING ALL);
    CREATE TABLE assessment_k56.term_test_class_access(LIKE assessment.term_test_class_access INCLUDING ALL);`);
  for (const classId of [...new Set(people.map(p=>p.classId))])
    await db.query('INSERT INTO mapping.classroom_course_mapping VALUES($1,$2,$3)',[classId,'IC'+(8000+classId),'approved']);
  for (const p of people) {
    await db.query('INSERT INTO mapping.student_mapping_review VALUES($1,$2,$3,$4,$5)',[p.ref,p.classId,p.id,'Học viên giả '+p.id,'approved']);
    await db.query('INSERT INTO mapping.erp_class_membership_snapshot VALUES($1,$2,$3,$4)',[p.classId,p.id,'active','active']);
  }
  for (const [schema,slugs] of [['assessment',slugs67],['assessment_k56',slugs56]]) for (const slug of slugs) {
    await db.query(`INSERT INTO ${schema}.test_definition VALUES($1,true)`,[slug]);
    for (const classId of [...new Set(people.map(p=>p.classId))])
      await db.query(`INSERT INTO ${schema}.term_test_class_access VALUES($1,$2,true)`,[slug,classId]);
    for (const p of people) await db.query(`INSERT INTO ${schema}.term_test_roster VALUES($1,$2,$3,$4,$5,true)`,
      [slug,p.classId,p.id,p.ref,'Học viên giả '+p.id]);
  }
  const apps = new Map();
  for (const [family,name] of [['mapping','mapping-review-api'],['k56','izone-k56-ic2264-api'],['k67','term-mini-k67-api']]) {
    const directory=path.join(root,name), proof=JSON.parse(await readFile(path.join(directory,'identity-runtime-proof.json'),'utf8'));
    const hash = data => createHash('sha256').update(data).digest('hex');
    assert.equal(hash(await readFile(path.join(directory,'src/app.js'))),proof.afterAppSha);
    assert.equal(hash(await readFile(path.join(directory,'src/student-identity.js'))),proof.moduleSha);
    const {createApp}=await import(pathToFileURL(path.join(directory,'src/app.js')).href);
    let pool={query:async(sql,args)=>{
      const text=typeof sql==='string'?sql:sql.text;
      assert.doesNotMatch(text,/\b(?:INSERT|UPDATE|DELETE|ALTER|TRUNCATE)\b/i);
      queryCount++;
      return db.query(text,args||sql.values);
    }};
    if(family==='k56') {
      const {createAssessmentSchemaPool}=await import(pathToFileURL(path.join(directory,'src/assessment-schema-pool.js')).href);
      pool=createAssessmentSchemaPool(pool,{family:'k56'});
    }
    const app=createApp({pool,config:{nodeEnv:'test',authMode:'legacy',legacyReviewToken:'fixture-only',
      allowedOrigins:new Set([origin]),trustProxyHops:1,...(family==='k56'?{deploymentProfileName:'k56-ic2264'}:{})},
      logger:{info(){},warn(){},error(){}}});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    servers.push(server);apps.set(family,server.address().port);
  }
  const mappingGroups=['speaking','reading','listening','writing-task1','writing-task2','writing-lesson13',
    'handout-bax','progress-log','substitute-test-1-k56','substitute-test-2-k56','substitute-test-1-k67','substitute-test-2-k67'];
  const groups=[...mappingGroups.map(label=>({label,family:'mapping',route:'/api/student-identity/resolve'})),
    ...slugs56.map(label=>({label,family:'k56',route:`/api/term-tests/${label}/student-identity`})),
    ...slugs67.map(label=>({label,family:'k67',route:`/api/term-tests/${label}/student-identity`}))];
  function request(group,p,index,network) {
    return new Promise((resolve,reject)=>{
      const payload=JSON.stringify({identity:{authority:'erp-contact',id:p.id},classCode:p.classCode});
      const started=performance.now();
      const req=http.request({hostname:'127.0.0.1',port:apps.get(group.family),path:group.route,method:'POST',
        headers:{Origin:origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),
          'X-Forwarded-For':'192.0.2.'+(network*4+1+Math.floor(index/25))}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
          try {const data=JSON.parse(Buffer.concat(chunks));
            assert.equal(res.statusCode,200,JSON.stringify({index,label:group.label,status:res.statusCode,data}));
            assert.equal(data.status,'unique');assert.equal(data.identity.id,p.id);
            assert.equal(data.aliases.length,1);assert.equal(data.aliases[0].studentRef,p.ref);
            assert.equal(data.aliases[0].classCode,p.classCode);assert.equal(res.headers['cache-control'],'no-store');
            assert.equal(Object.keys(data).some(key=>/token|session|attempt/i.test(key)),false);
            resolve(performance.now()-started);
          }catch(error){reject(error);}
        });
      });
      req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('FIXTURE_HTTP_TIMEOUT')));req.end(payload);
    });
  }
  let network = 0;
  for (const [round,group] of [...groups.map(g=>[g.label,g]),['mixed',null]]) {
    const before=queryCount, started=performance.now();
    // Mỗi kịch bản là một nhóm 100 người độc lập; không cộng dồn 1.900 lượt vào bốn IP.
    const values=await Promise.all(people.map((p,i)=>request(group||groups[i%groups.length],p,i,network)));
    network++;
    values.sort((a,b)=>a-b);
    const record={label:round,users:100,maxUsersPerIp:25,independentNetworkGroup:true,success:values.length,failures:0,
      medianMs:Math.round(values[49]),p95Ms:Math.round(values[94]),maxMs:Math.round(values[99]),
      wallMs:Math.round(performance.now()-started),sqlReads:queryCount-before};
    results.push(record);console.log(JSON.stringify(record));
  }
  outcome='passed';
} finally {
  for(const server of servers)await new Promise(resolve=>server.close(resolve));
  await db.close();
  await writeFile(output,JSON.stringify({outcome,results,scope:'identity-http-sql-only',
    database:'PGlite single connection with 100 synthetic learners',
    productionRequests:0,mediaRequests:0,realAiCalls:0,portalWrites:0,
    limits:['Product labels share the Mapping normalization API; no product session/roster/draft/submit load.',
      'Local embedded SQL timing does not establish VPS capacity or a production latency promise.',
      'No before/after legacy journey timing has been measured by this script.']},null,2),'utf8');
}
