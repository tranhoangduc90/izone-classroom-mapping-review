import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {createIndependentDocuments} from '../src/speaking-independent-documents.js';
import {createIndependentSpeaking} from '../src/speaking-independent.js';
import {createIndependentApp} from '../src/speaking-independent-server.js';
import {createIndependentSource} from '../src/speaking-independent-source.js';
import {createSpeakingSelfMatch, createSpeakingSelfMatchMailer, deliverSpeakingSelfMatchNotice} from '../src/speaking-self-match.js';

const secret = 'fixture-standalone-self-match-secret-long';
const assignmentCode = '67-speaking-ly_do_hanh_vi';
const classCode = 'IC2304';
const classId = 1293;
const courseId = '123450000000';
const courseWorkId = '777770000000';
const pending = '11111111-1111-4111-8111-111111111111';
const approved = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
const prefix = '/api/speaking-homework-independent';
const template = {assignmentCode, title: 'Speaking Lesson 6 thử', lesson: 6, requiredPracticeCount: 2, doctorEnabled: true,
  digest: 'f'.repeat(64), parts: [{part_key:'benefit_harm',min_questions:0},{part_key:'reason_action',min_questions:2},{part_key:'freestyle',min_questions:1}]};

function documentFixture(documentId) {
  const run = (content, startIndex) => ({startIndex,endIndex:startIndex+content.length,textRun:{content,textStyle:{}}});
  return {documentId,title:'Speaking fixture',revisionId:'fixture-revision',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[
    {paragraph:{elements:[run(`SPEAKING - LUYỆN LÝ DO\n${assignmentCode}\n`,1)]}},
    {paragraph:{elements:[run('NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING',60)]}},
    {paragraph:{elements:[run('TÌNH TRẠNG NỘP BÀI SPEAKING\n',131)]}},
  ]}}}]};
}

async function fixture(t, eligibleDocuments, directDocEntryIds=[], registeredDocsEnabled=false) {
  const db = new PGlite();
  t.after(() => db.close());
  const schema = await readFile(new URL('../../docs/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema.split('CREATE SCHEMA IF NOT EXISTS assessment;')[0]);
  await db.exec('CREATE ROLE speaking_homework_api');
  for (const name of ['202609270001_speaking_homework_candidate.sql','202609290003_speaking_lesson4_practice.sql',
    '202609301329_speaking_course67_catalog.sql',
    '202610080530_speaking_independent_intake.sql','202611030102_speaking_unmatched_sources.sql',
    '202610250930_speaking_progress_docs.sql','202610250931_speaking_independent_progress_docs.sql',
    '202611040339_speaking_self_match.sql']) {
    await db.exec(await readFile(new URL(`../ops/migrations/${name}`,import.meta.url),'utf8'));
  }
  await db.exec(`CREATE TABLE speaking_independent.conversation_snapshot(link_id uuid PRIMARY KEY,original_fingerprint text,
    fingerprint text,messages jsonb,source text DEFAULT 'accepted',recovery_job_id uuid)`);
  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return {...result,rowCount:result.affectedRows || result.rows.length};
  };
  const pool = {query,async connect(){return {query,release(){}};}};
  await query(`INSERT INTO mapping.classroom_course_mapping (erp_course_class_id,erp_class_name_snapshot,classroom_course_id,status)
    VALUES($1,$2,$3,'approved')`, [classId,classCode,courseId]);
  await query(`INSERT INTO speaking_homework.class_scope(class_id,class_code,course_key,active,source_key,source_observed_at)
    VALUES($1,$2,'67',true,'fixture',now())`, [classId,classCode]);
  await query(`INSERT INTO speaking_homework.assignment_template(assignment_code,course_key,page_path,title,doctor_course_key,required_practice_count,parts)
    VALUES($1,'67','lesson-6.html',$2,'67',2,$3)`, [assignmentCode,template.title,JSON.stringify(template.parts)]);
  for (const [ref,id,name,google] of [[pending,11,'Tên chưa khớp A',null],[approved,22,'Tên đã khớp B','google-b'],[second,33,'Tên chưa khớp C',null]]) {
    await query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot,classroom_course_id,classroom_user_id,status)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [ref,classId,id,name,courseId,google,google?'approved':'pending_review']);
    await query(`INSERT INTO mapping.erp_class_membership_snapshot (erp_course_class_id,erp_student_contact_id,erp_class_name_snapshot,erp_student_name_snapshot,registration_status)
      VALUES($1,$2,$3,$4,'on_going')`, [classId,id,classCode,name]);
  }
  await query(`INSERT INTO mapping.student_identity_mapping(erp_student_contact_id,google_user_id,match_method) VALUES(22,'google-b','manual')`);
  const docsData = new Map();
  const source = createIndependentSource({pool});
  const selfMatch = createSpeakingSelfMatch({pool,secret,
    eligibleRefs:registeredDocsEnabled?[]:[pending,approved,second],eligibleDocuments,registeredDocsEnabled});
  const documents = createIndependentDocuments({pool,source,accessSecret:secret,selfMatch,directDocEntryIds,gateway:{async get(id){
    assert.ok(docsData.has(id), 'A fixture must not fetch an external document'); return docsData.get(id);
  }}});
  const service = createIndependentSpeaking({pool,accessSecret:secret,source,documents,progressDocsEnabled:false});
  const api = createIndependentApp({service,documents});
  await documents.register({courseId,courseWorkId,assignmentCode,classroomState:'PUBLISHED'});
  async function addDocument(documentId, google, {roster=true, verified=true} = {}) {
    const document = documentFixture(documentId);
    docsData.set(documentId, document);
    if (roster) await query(`INSERT INTO mapping.classroom_roster_snapshot
      (classroom_course_id,classroom_user_id,classroom_name_snapshot,classroom_email_snapshot)
      VALUES($1,$2,'Chủ thử',$3) ON CONFLICT DO NOTHING`, [courseId,google,`${google}@example.invalid`]);
    await documents.sync({courseId,courseWorkId,submissions:[{id:`submission-${documentId}`,userId:google,documentId}]});
    const plan = await documents.plan({documentId,document});
    document.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle = plan.requests[0].updateTextStyle.textStyle;
    if (verified) await documents.verify({documentId,document});
    return {documentId,assignmentCode,classCode};
  }
  const post = (endpoint,input) => request(api).post(prefix+endpoint).send(input);
  const verifyDocument = documentId => documents.verify({documentId,document:docsData.get(documentId)});
  return {db,pool,api,post,query,addDocument,verifyDocument};
}

const selected = (input, ref, form) => ({...input,studentRef:ref,identityConfirmed:true,
  ...(form ? {selfMatchToken:form.token,selfMatchStudentRefs:form.studentRefs} : {})});

test('Speaking: một xác nhận qua HTTP, ghi mapping/audit cùng nguồn, retry và giữ đúng bài', async t => {
  const f = await fixture(t,['fixture-once-doc']);
  const input = await f.addDocument('fixture-once-doc','google-a');
  const before = (await f.query('SELECT to_jsonb(m) AS row FROM mapping.student_mapping_review m WHERE public_id=$1',[approved])).rows[0];
  const {body:{assignment}} = await f.post('/assignment/roster',input).expect(200).expect('Cache-Control','no-store');
  assert.deepEqual(assignment.selfMatch.studentRefs,[pending,second]);
  assert.equal(assignment.selfMatch.account,'google-a@example.invalid');
  const confirm = selected(input,pending,assignment.selfMatch);
  await f.post('/session/start-selected',{...confirm,selfMatchStudentRefs:[pending,approved,second]}).expect(409);
  assert.equal((await f.query('SELECT * FROM speaking_independent.self_match_decision')).rows.length,0);
  await f.query('ALTER TABLE mapping.mapping_decision_event ADD CONSTRAINT fixture_block_audit CHECK (false)');
  await f.post('/session/start-selected',confirm).expect(503);
  assert.equal((await f.query('SELECT status FROM mapping.student_mapping_review WHERE public_id=$1',[pending])).rows[0].status,'pending_review');
  assert.equal((await f.query('SELECT count(*)::int n FROM mapping.student_identity_mapping')).rows[0].n,1);
  assert.equal((await f.query('SELECT count(*)::int n FROM speaking_independent.self_match_decision')).rows[0].n,0);
  await f.query('ALTER TABLE mapping.mapping_decision_event DROP CONSTRAINT fixture_block_audit');
  const first = (await f.post('/session/start-selected',confirm).expect(200)).body.session;
  const replay = (await f.post('/session/start-selected',confirm).expect(200)).body.session;
  assert.deepEqual(replay,first);
  assert.ok(first.selfMatchDecisionId);
  assert.equal((await f.post('/open',{studentRef:pending,accessToken:first.accessToken}).expect(200)).body.workUnitId,first.workUnitId);
  const after = (await f.query(`SELECT d.id,d.previous->'review'->>'status' AS previous,d.current->'review'->>'status' AS current,
    i.google_user_id,b.status,b.work_unit_id FROM speaking_independent.self_match_decision d
    JOIN mapping.student_mapping_review m ON m.public_id=d.student_ref
    JOIN mapping.student_identity_mapping i USING (erp_student_contact_id)
    JOIN speaking_independent.source_binding b ON b.document_id=d.document_id`)).rows;
  assert.deepEqual(after,[{id:first.selfMatchDecisionId,previous:'pending_review',current:'approved',google_user_id:'google-a',status:'linked',work_unit_id:first.workUnitId}]);
  assert.deepEqual((await f.query('SELECT to_jsonb(m) AS row FROM mapping.student_mapping_review m WHERE public_id=$1',[approved])).rows[0],before);
  const linked = (await f.post('/assignment/roster',input).expect(200)).body.assignment;
  assert.equal(linked.selectedStudentRef,pending);
  assert.equal(linked.selfMatch,undefined);
  assert.ok(!JSON.stringify(linked).includes('google-a@example.invalid'));
  assert.equal((await f.query('SELECT * FROM mapping.mapping_decision_event')).rows.length,1);
  assert.equal((await f.query('SELECT * FROM speaking_independent.self_match_notice')).rows.length,0);
  await f.query('SET ROLE speaking_independent_api');
  try {
    assert.equal((await f.query('SELECT speaking_independent.self_match($1,$2,$3) AS result',
      [input.documentId,input.assignmentCode,input.classCode])).rows[0].result.state,'already_linked');
    await assert.rejects(f.query("UPDATE mapping.student_mapping_review SET status='approved'"),{code:'42501'});
    await assert.rejects(f.query('DELETE FROM speaking_independent.self_match_decision'),{code:'42501'});
  } finally { await f.query('RESET ROLE'); }
});

test('Speaking: chọn tên kiểu cũ giữ phiên cùng Doc và không ghi mapping hay cảnh báo', async t => {
  const f = await fixture(t,['fixture-fallback-doc']);
  const input = await f.addDocument('fixture-fallback-doc','google-fallback');
  const {body:{assignment}} = await f.post('/assignment/roster',input).expect(200);
  assert.equal(assignment.students.length,3);
  assert.ok(!assignment.selfMatch.studentRefs.includes(approved));
  const {body:{session}} = await f.post('/session/start-selected',selected(input,approved)).expect(200);
  assert.equal(session.documentId,input.documentId);
  assert.equal(session.selfMatchDecisionId,undefined);
  assert.equal((await f.query('SELECT * FROM speaking_independent.self_match_decision')).rows.length,0);
  assert.equal((await f.query('SELECT * FROM speaking_independent.self_match_notice')).rows.length,0);
  assert.equal((await f.query('SELECT count(*)::int n FROM mapping.student_identity_mapping')).rows[0].n,1);
  assert.equal((await f.post('/open',{studentRef:approved,accessToken:session.accessToken}).expect(200)).body.workUnitId,session.workUnitId);
  const outside = await f.addDocument('fixture-outside-pilot','google-outside',{roster:false});
  const outsideResult = await f.post('/assignment/roster',outside).expect(200);
  assert.equal(outsideResult.body.assignment.selfMatch,undefined);
  assert.equal((await f.query('SELECT * FROM speaking_independent.self_match_notice')).rows.length,0);
});

test('Speaking: sai lớp, thiếu chủ, xung đột và thử lại email không đổi mapping', async t => {
  const f = await fixture(t,['fixture-conflict-doc','fixture-missing-owner']);
  const conflict = await f.addDocument('fixture-conflict-doc','google-conflict');
  const {body:{assignment}} = await f.post('/assignment/roster',conflict).expect(200);
  await f.query(`INSERT INTO mapping.student_identity_mapping(erp_student_contact_id,google_user_id,match_method) VALUES(11,'different-google','manual')`);
  for (let i=0;i<2;i++) assert.equal((await f.post('/session/start-selected',selected(conflict,pending,assignment.selfMatch)).expect(409)).body.error,'MAPPING_CONFLICT');
  const unknown = await f.addDocument('fixture-missing-owner','google-unknown',{roster:false});
  for (let i=0;i<2;i++) assert.equal((await f.post('/assignment/open',unknown).expect(409)).body.error,'OWNER_UNRESOLVED');
  await f.post('/assignment/open',{...conflict,classCode:'IC9999'}).expect(409);
  await f.query("UPDATE mapping.classroom_course_mapping SET status='inactive'");
  assert.equal((await f.post('/assignment/open',conflict).expect(409)).body.error,'CLASS_MISMATCH');
  const {rows} = await f.query('SELECT id,reason FROM speaking_independent.self_match_notice ORDER BY reason');
  assert.deepEqual(rows.map(r=>r.reason),['CLASS_MISMATCH','MAPPING_CONFLICT','OWNER_UNRESOLVED']);
  assert.equal((await f.query('SELECT * FROM speaking_independent.self_match_decision')).rows.length,0);
  assert.equal((await f.query('SELECT google_user_id FROM mapping.student_identity_mapping WHERE erp_student_contact_id=11')).rows[0].google_user_id,'different-google');
  const received=[];
  let failFirst=true;
  const send=createSpeakingSelfMatchMailer({to:'duc-fixture@example.invalid',from:'sender-fixture@example.invalid',accessToken:async()=> 'fixture-token',
    async call(url,options) {
      assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      const raw=Buffer.from(JSON.parse(options.body).raw,'base64url').toString();
      if (failFirst) {failFirst=false;return new Response('{}',{status:503});}
      received.push(raw);
      return Response.json({id:`fixture-mail-${received.length}`});
    }});
  await deliverSpeakingSelfMatchNotice(f.pool,send);
  assert.equal((await f.query("SELECT count(*)::int n FROM speaking_independent.self_match_notice WHERE last_error='MAIL_HTTP_503' AND sent_at IS NULL")).rows[0].n,1);
  await f.query('UPDATE speaking_independent.self_match_notice SET available_at=now()');
  for(let i=0;i<3;i++) assert.equal(await deliverSpeakingSelfMatchNotice(f.pool,send),true);
  assert.equal(await deliverSpeakingSelfMatchNotice(f.pool,send),false);
  assert.equal(received.length,3);
  for(const raw of received) {
    assert.match(raw,/To: duc-fixture@example\.invalid/);
    const content=Buffer.from(raw.split('\r\n\r\n')[1].replaceAll('\r\n',''),'base64').toString();
    assert.ok(rows.some(row=>content.includes(row.id)));
    assert.ok(!content.includes('google-conflict'));
    if (process.env.SPEAKING_EVIDENCE_DIR && content.includes(rows.find(row=>row.reason==='MAPPING_CONFLICT').id)) {
      const subject=Buffer.from(raw.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1],'base64').toString();
      await mkdir(process.env.SPEAKING_EVIDENCE_DIR,{recursive:true});
      await writeFile(path.join(process.env.SPEAKING_EVIDENCE_DIR,'email-fixture.json'),JSON.stringify({subject,content},null,2));
    }
  }
  assert.equal((await f.query('SELECT count(*)::int n FROM speaking_independent.self_match_notice WHERE sent_at IS NOT NULL AND message_id IS NOT NULL')).rows[0].n,3);
});

test('Speaking: đăng ký đổi sau khi hiện tên tạo ca sai lớp và giữ mapping chờ', async t => {
  const f=await fixture(t,['fixture-membership-change']);
  const input=await f.addDocument('fixture-membership-change','google-changing');
  const {body:{assignment}}=await f.post('/assignment/roster',input).expect(200);
  await f.query("UPDATE mapping.erp_class_membership_snapshot SET registration_status='on_hold' WHERE erp_student_contact_id=11");
  const result=await f.post('/session/start-selected',selected(input,pending,assignment.selfMatch)).expect(409);
  assert.equal(result.body.error,'CLASS_MISMATCH');
  assert.deepEqual((await f.query('SELECT reason,student_ref FROM speaking_independent.self_match_notice')).rows,
    [{reason:'CLASS_MISMATCH',student_ref:pending}]);
  assert.equal((await f.query('SELECT status FROM mapping.student_mapping_review WHERE public_id=$1',[pending])).rows[0].status,'pending_review');
});

test('Speaking: nguồn Classroom mới được xác nhận không cần danh sách DocID hoặc UUID cấu hình', async t => {
  const f = await fixture(t,[],[],true);
  const outside = await f.addDocument('fixture-no-verified-cta','google-outside',{verified:false});
  const before = (await f.post('/assignment/open',outside).expect(200)).body.assignment;
  assert.equal(before.selfMatch,undefined);
  assert.ok(!JSON.stringify(before).includes('google-outside@example.invalid'));
  const input = await f.addDocument('fixture-registered-after-rollout','google-new');
  const {body:{assignment}} = await f.post('/assignment/open',input).expect(200).expect('Cache-Control','no-store');
  assert.equal(assignment.selfMatch.account,'google-new@example.invalid');
  assert.deepEqual(assignment.selfMatch.studentRefs,[pending,second]);
  const selection = selected(input,second,assignment.selfMatch);
  const invalid = await f.post('/session/start-selected',{...selection,studentRef:approved}).expect(409);
  assert.equal(invalid.body.error,'SELF_MATCH_INVALID');
  const confirmed = (await f.post('/session/start-selected',selection).expect(200)).body.session;
  assert.ok(confirmed.selfMatchDecisionId);
  const replay = (await f.post('/session/start-selected',selection).expect(200)).body.session;
  assert.deepEqual(replay,confirmed);
  const readback = (await f.post('/assignment/open',input).expect(200)).body.assignment;
  assert.equal(readback.selectedStudentRef,second);
  assert.equal(readback.selfMatch,undefined);
  assert.equal(readback.directDocEntry,undefined);
  assert.equal((await f.query('SELECT count(*)::int n FROM speaking_independent.self_match_decision')).rows[0].n,1);
  assert.equal((await f.query('SELECT count(*)::int n FROM speaking_independent.self_match_notice')).rows[0].n,0);
});

test('Speaking: bỏ qua bài đã thu hồi và nối lại CTA với đúng bài đang hoạt động', async t => {
  const documentId='fixture-recover-revoked-doc';
  const f=await fixture(t,[documentId],[documentId],true);
  const input=await f.addDocument(documentId,'google-b');
  async function seedUnit(key, ref, doc, hashChar) {
    const {rows:[unit]}=await f.query(`WITH profile AS (
      INSERT INTO speaking_independent.profile(identity_ref,profile_key,kind,class_id,class_code,student_ref,student_name)
      VALUES(gen_random_uuid(),$1,'document',CASE WHEN $2::uuid IS NULL THEN NULL ELSE $3::bigint END,
        CASE WHEN $2::uuid IS NULL THEN NULL ELSE $4 END,$2,'Fixture') RETURNING id
    )
    INSERT INTO speaking_independent.work_unit(profile_id,assignment_code,context_key,template,template_digest,
      document_id,tab_id,origin,token_hash)
    SELECT id,$5,$1,$6,$7,$8,CASE WHEN $8::text IS NULL THEN NULL ELSE 't.0' END,'document',repeat($9,64)
    FROM profile RETURNING id`,[key,ref,classId,classCode,assignmentCode,JSON.stringify(template),template.digest,doc,hashChar]);
    return unit.id;
  }
  const old=await seedUnit('document:retired-fixture:t.0',approved,null,'a');
  const current=await seedUnit('document:fixture-recover-revoked-doc:t.0',null,documentId,'b');
  await f.query(`INSERT INTO speaking_independent.document_binding(document_id,tab_id,assignment_code,work_unit_id,verified_revision,template_digest)
    VALUES($1,'t.0',$2,$3,'fixture-revision',$4)`,[documentId,assignmentCode,current,template.digest]);
  const conflict=await f.verifyDocument(documentId);
  assert.equal(conflict.reason,'EXISTING_PROGRESS_CONFLICT');
  await f.query('UPDATE speaking_independent.work_unit SET revoked_at=now() WHERE id=$1',[old]);
  const snapshot=async()=> (await f.query(`SELECT to_jsonb(u) AS unit,to_jsonb(p) AS profile FROM speaking_independent.work_unit u
    JOIN speaking_independent.profile p ON p.id=u.profile_id WHERE u.id=$1`,[old])).rows[0];
  const historical=await snapshot();
  assert.equal((await f.verifyDocument(documentId)).status,'linked');
  const {body:{assignment}}=await f.post('/assignment/open',input).expect(200);
  assert.equal(assignment.directDocEntry,true);
  assert.equal(assignment.selectedStudentRef,approved);
  assert.equal(assignment.selfMatch,undefined);
  const {body:{session}}=await f.post('/session/start-selected',selected(input,approved)).expect(200);
  assert.equal(session.workUnitId,current);
  assert.deepEqual(await snapshot(),historical);
  await f.query('UPDATE speaking_independent.work_unit SET revoked_at=now() WHERE id=$1',[current]);
  assert.equal((await f.verifyDocument(documentId)).status,'review');
});

test('Speaking: trang Lesson 6 thật với API và PostgreSQL fixture cách ly',
  {skip:!process.env.SPEAKING_SELF_MATCH_PAGES||!process.env.PLAYWRIGHT_MODULE,timeout:90000}, async t => {
    const f=await fixture(t,['fixture-browser-confirm','fixture-browser-fallback','fixture-browser-conflict'],['fixture-browser-confirm']);
    const success=await f.addDocument('fixture-browser-confirm','google-a');
    const fallback=await f.addDocument('fixture-browser-fallback','google-c');
    const browserConflict=await f.addDocument('fixture-browser-conflict','google-invalid',{roster:false});
    const assets=express();
    assets.use('/mapping-api/api/student-identity/resolve',express.json(),async(req,res)=>{
      const {rows:[m]}=await f.query(`SELECT public_id,erp_student_contact_id::text AS portal,erp_student_name_snapshot AS name
        FROM mapping.student_mapping_review WHERE public_id::text=$1 OR erp_student_contact_id::text=$2`,[req.body.studentRef||'',req.body.identity?.id||'']);
      return res.json({ok:true,status:m?'unique':'missing',identity:m?{authority:'erp-contact',id:m.portal}:null,
        aliases:m?[{classId:String(classId),classCode,studentRef:m.public_id,studentName:m.name}]:[]});
    });
    assets.use('/mapping-api',f.api);
    assets.use(express.static(process.env.SPEAKING_SELF_MATCH_PAGES));
    const server=await new Promise(resolve=>{const s=assets.listen(0,'127.0.0.1',()=>resolve(s));});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
    const browser=await chromium.launch({channel:'msedge',headless:true});
    t.after(()=>browser.close());
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const page=await context.newPage();
    page.setDefaultTimeout(9_000);
    const errors=[];
    const writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    const handleRoute=async route=>{
      const requestUrl=new URL(route.request().url());
      if(requestUrl.origin===origin)return route.continue();
      if(requestUrl.origin!=='https://ducizone.ddns.net')return route.abort();
      if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':origin,
        'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'}});
      const data=route.request().postData();
      if(requestUrl.pathname.endsWith('/session/start-selected'))writes.push(JSON.parse(data));
      const response=await fetch(origin+requestUrl.pathname+requestUrl.search,{method:route.request().method(),
        ...(data?{body:data,headers:{'content-type':'application/json'}}:{})});
      return route.fulfill({status:response.status,body:await response.text(),contentType:'application/json',headers:{'access-control-allow-origin':origin}});
    };
    await context.route('**/*',handleRoute);
    const url = input => `${origin}/speaking-homework/lesson-6.html?${new URLSearchParams({...input,class:classCode,mode:'student'})}`;
    const evidence=process.env.SPEAKING_EVIDENCE_DIR;
    const screenshot=async name=>{if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});}};
    await page.goto(url(success));
    try { await page.getByRole('heading',{name:'Xác nhận họ và tên của bạn'}).waitFor(); }
    catch (error) { await screenshot('failed-entry'); throw new Error(`${error.message}\n${await page.locator('#identity-message').textContent()}\n${errors.join('\n')}`); }
    assert.equal(await page.locator('#student-select option').count(),3);
    assert.match(await page.locator('.self-match-account').textContent(),/google-a@example\.invalid/);
    await page.locator('#student-select').selectOption(pending);
    await page.getByRole('button',{name:'Tiếp tục',exact:true}).click();
    assert.match(await page.locator('[data-match-summary]').textContent(),/google-a@example\.invalid/);
    await page.getByRole('button',{name:'Quay lại',exact:true}).click();
    assert.equal(writes.length,0);
    assert.equal(await page.locator('#student-select').inputValue(),pending);
    await page.getByRole('button',{name:'Tiếp tục',exact:true}).click();
    await screenshot('01-xem-lai');
    await page.getByRole('button',{name:'Xác nhận và vào bài',exact:true}).click();
    await page.locator('#homework-content').waitFor({state:'visible'});
    assert.equal(writes.length,1);
    assert.ok(writes[0].selfMatchToken);
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('izone:student-identity:v1'))?.identity?.id==='11');
    await page.reload();
    await page.locator('#homework-content').waitFor({state:'visible'});
    assert.equal(writes.length,2);
    assert.equal(writes[1].selfMatchToken,undefined);
    await screenshot('02-nho-dung-hoc-vien');
    const clean=await browser.newContext({viewport:{width:390,height:844}});
    await clean.route('**/*',handleRoute);
    const direct=await clean.newPage();
    direct.on('pageerror',e=>errors.push(e.message));
    await direct.goto(url(success));
    await direct.locator('#homework-content').waitFor({state:'visible',timeout:9000});
    assert.equal(writes.length,3);
    assert.equal(writes[2].studentRef,pending);
    assert.equal(writes[2].documentId,success.documentId);
    assert.equal(await direct.evaluate(()=>localStorage.getItem('izone:student-identity:v1')),null);
    if(evidence)await direct.screenshot({path:path.join(evidence,'05-vao-thang-doc-da-duyet.png'),fullPage:true});
    await direct.evaluate(()=>localStorage.setItem('izone:student-identity:v1',JSON.stringify({version:1,
      identity:{authority:'erp-contact',id:'22'},revision:'direct_guard_other',updatedAt:new Date().toISOString()})));
    const mismatch=await clean.newPage();
    mismatch.on('pageerror',e=>errors.push(e.message));
    await mismatch.goto(url(success));
    await mismatch.getByText('Người học đã nhớ khác chủ link',{exact:false}).waitFor({timeout:9000});
    assert.equal(await mismatch.locator('#homework-content').isHidden(),true);
    assert.equal(writes.length,3);
    await clean.close();
    await page.goto(url(fallback));
    await page.getByRole('button',{name:'Không thấy tên của tôi',exact:true}).click();
    assert.equal(await page.locator('#student-select option').count(),4);
    await screenshot('03-ve-danh-sach-ten');
    await page.locator('#student-select').selectOption(second);
    await page.locator('#open-homework').click();
    await page.locator('#homework-content').waitFor({state:'visible'});
    assert.equal(writes.at(-1).selfMatchToken,undefined);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('izone:student-identity:v1'))?.identity?.id),'11');
    assert.equal((await f.query('SELECT count(*)::int n FROM speaking_independent.self_match_decision')).rows[0].n,1);
    await page.goto(url(browserConflict));
    await page.getByText('Chưa xác định được tài khoản Google của chủ bài nộp.',{exact:false}).waitFor();
    await screenshot('04-ca-ngoai-le');
    assert.deepEqual((await f.query('SELECT reason FROM speaking_independent.self_match_notice')).rows,[{reason:'OWNER_UNRESOLVED'}]);
    assert.deepEqual(errors,[]);
  });
