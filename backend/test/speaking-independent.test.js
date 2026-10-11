import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import request from 'supertest';
import { createIndependentSpeaking } from '../src/speaking-independent.js';
import { createIndependentApp } from '../src/speaking-independent-server.js';
import { runSpeakingCheckJob } from '../src/speaking-check-worker.js';
import { runPracticeCheckJob,runPracticeAnalysisJob } from '../src/speaking-practice-worker.js';
import { createIndependentDocuments,validateIndependentDocument } from '../src/speaking-independent-documents.js';
import { planSpeakingCopyCta } from '../src/speaking-classroom-copies.js';

const ref='60000000-0000-4000-8000-000000000006';
const code='67-speaking-ly_do_hanh_vi';
const exercise=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const url=n=>`https://chatgpt.com/share/${String(n).padStart(32,'0')}`;
const fingerprint=n=>String(n).repeat(64).slice(0,64);
const template={assignmentCode:code,title:'Lesson 6',lesson:6,requiredPracticeCount:2,doctorEnabled:true,digest:'a'.repeat(64),
  parts:[{part_key:'benefit_harm',min_questions:0},{part_key:'reason_action',min_questions:2},{part_key:'freestyle',min_questions:1}]};

async function fixture({start=true,recommendations=[]}={}) {
  let db,nativePool;
  if(process.env.SPEAKING_NATIVE_TEST_DATABASE_URL) {
    const url=new URL(process.env.SPEAKING_NATIVE_TEST_DATABASE_URL);
    assert.match(url.pathname,/^\/speaking_independent_fixture_[a-z0-9_]+$/);
    nativePool=new pg.Pool({connectionString:url.href,max:8});
    await nativePool.query('DROP SCHEMA IF EXISTS speaking_independent CASCADE; DROP SCHEMA IF EXISTS speaking_homework CASCADE; DROP SCHEMA IF EXISTS mapping CASCADE');
    db={exec:sql=>nativePool.query(sql),query:(sql,params)=>nativePool.query(sql,params),close:()=>nativePool.end()};
  }else db=new PGlite();
  await db.exec(`CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint PRIMARY KEY);
    CREATE TABLE mapping.student_mapping_review(public_id uuid PRIMARY KEY);
    CREATE SCHEMA speaking_homework;
    CREATE TABLE speaking_homework.assignment_template(page_path text CONSTRAINT assignment_template_page_path_check CHECK(page_path='lesson-6.html'));
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='speaking_homework_api') THEN CREATE ROLE speaking_homework_api; END IF; END $$;`);
  for(const name of ['202609270001_speaking_homework_candidate.sql','202609290003_speaking_lesson4_practice.sql'])
    await db.exec(await readFile(new URL(`../ops/migrations/${name}`,import.meta.url),'utf8'));
  // Live còn khóa hội thoại nguồn legacy; migration phải giữ cả loại nguồn lịch sử này.
  await db.exec("ALTER TABLE speaking_homework.conversation_claim DROP CONSTRAINT conversation_claim_source_kind_check, ADD CONSTRAINT conversation_claim_source_kind_check CHECK(source_kind IN ('homework','practice','legacy'))");
  await db.exec(await readFile(new URL('../ops/migrations/202610080530_speaking_independent_intake.sql',import.meta.url),'utf8'));
  const query=async(sql,params)=>{const r=await db.query(sql,params);return {...r,rowCount:r.rowCount??r.rows.length};};
  const pool=nativePool||{query,async connect(){return {query,release(){}};}};
  let active=true;
  const source={async context(i){
    if(i.assignmentCode!==code) throw Object.assign(new Error('Mã cũ'),{code:'UNSUPPORTED_ASSIGNMENT'});
    const classes=[{class_id:1293,class_code:'IC2304',course_id:'826336470852'}];
    const exercises=[{id:exercise(1),title:'Bài một',exercise_url:'https://example.invalid/1'},{id:exercise(2),title:'Bài hai',exercise_url:'https://example.invalid/2'}];
    if(!i.classCode) return {template,classes,exercises};
    if(i.classCode!=='IC2304'||(i.studentRef&&(i.studentRef!==ref||!active))) throw Object.assign(new Error('Hồ sơ không hoạt động'),{code:'STUDENT_NOT_ACTIVE'});
    return {template,scope:classes[0],students:[{student_ref:ref,name:'Học viên fixture',google_user_id:'fixture-user'}],member:i.studentRef?{student_ref:ref,name:'Học viên fixture'}:null,
      exercises,recommendations};},
    async teacher(_class,headers){return headers.cookie==='teacher=allowed';}};
  const service=createIndependentSpeaking({pool,source,accessSecret:'fixture-secret-32-characters-long-only'});
  const session=start?await service.startSelected({assignmentCode:code,classCode:'IC2304',studentRef:ref}):null;
  const identity=session?{accessToken:session.accessToken,studentRef:ref}:null;
  return {db,pool,service,session,identity,source,drop:()=>{active=false;}};
}

test('Lesson 6 mở lớp và phiên khi không có assignment hoặc bản Docs',async()=>{
  const f=await fixture();try{
    assert.equal((await f.service.classes({assignmentCode:code}))[0].ready,true);
    assert.equal(f.session.documentId,null);assert.ok(f.session.workUnitId);
    const again=await f.service.startSelected({assignmentCode:code,classCode:'IC2304',studentRef:ref});
    assert.equal(again.workUnitId,f.session.workUnitId);assert.equal(again.accessToken,f.session.accessToken);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_homework.assignment')).rows[0].n,0);
    assert.equal((await f.service.open(f.identity)).status,'draft');
    await assert.rejects(f.service.finish(f.identity),e=>e.code==='ALL_LINKS_REQUIRED');
    await assert.rejects(f.service.open({...f.identity,studentRef:exercise(99)}),e=>e.code==='SESSION_INVALID');
    f.drop();await assert.rejects(f.service.open(f.identity),e=>e.code==='STUDENT_NOT_ACTIVE');
  }finally{await f.db.close();}
});

test('Bài web giữ cùng phiên khi Docs lịch sử xuất hiện sau',async()=>{
  const f=await fixture({start:false});try {
    let calls=0;f.source.legacySession=async()=>{calls++;return calls===1?null:{intakeMode:'legacy',documentId:'late-doc'};};
    const input={assignmentCode:code,classCode:'IC2304',studentRef:ref};
    const first=await f.service.startSelected(input),again=await f.service.startSelected(input);
    assert.ok(first.workUnitId);assert.equal(again.workUnitId,first.workUnitId);assert.equal(calls,1);
  }finally{await f.db.close();}
});

test('Luồng năm link, 0/2/1, biên nhận retry, quyền giáo viên và bài cũ không đổi',async()=>{
  const f=await fixture();try{
    let calls=0;
    await f.service.requestCheck({...f.identity,part:'benefit_harm',rawUrl:url(1)});
    assert.equal(await f.service.claimJob(),null); // Link-only không gọi Share/AI.
    for(const [part,count,n] of [['reason_action',2,2],['freestyle',1,3]]) {
      await f.service.requestCheck({...f.identity,part,rawUrl:url(n)});
      const j=await f.service.claimJob();assert.equal(j.kind,'check_main');
      assert.equal(await runSpeakingCheckJob(f.service.workerService(j),j,async()=>{calls++;return {kind:'pass',fingerprint:fingerprint(n),count};}),'accepted');
    }
    assert.equal(calls,2);
    await assert.rejects(f.service.finish(f.identity),e=>e.code==='PRACTICE_LINKS_REQUIRED');
    for(let slot=1;slot<=2;slot++){
      await f.service.requestPracticeCheck({...f.identity,slot,exerciseId:exercise(slot),rawUrl:url(slot+3)});
      let j=await f.service.claimJob();
      // Phép thử này chỉ lấy check job; phân tích được giữ riêng, không báo giả đã xong.
      if(j.kind==='analyze_practice') {await f.service.failJob(j,'FIXTURE_PENDING_ANALYSIS');j=await f.service.claimJob();}
      assert.equal(j.kind,'check_practice');
      await f.service.workerService(j).completePracticeCheck({fingerprint:fingerprint(slot+3),questionCount:1,qualityPassed:true,matchedExerciseId:exercise(slot)});
    }
    const r=await f.service.finish(f.identity);assert.ok(r.id);
    assert.equal((await f.service.finish(f.identity)).id,r.id);
    const restored=await f.service.open(f.identity);assert.equal(restored.status,'submitted');assert.equal(restored.receipt.id,r.id);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_independent.receipt')).rows[0].n,1);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_homework.conversation_claim')).rows[0].n,5);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_homework.submission')).rows[0].n,0);
    await assert.rejects(f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:url(9)}),e=>e.code==='HOMEWORK_SUBMITTED');
    await assert.rejects(f.service.teacherReceipt(r.id,{cookie:'teacher=denied'}),e=>e.code==='RECEIPT_NOT_FOUND');
    assert.equal((await f.service.teacherReceipt(r.id,{cookie:'teacher=allowed'})).student_name,'Học viên fixture');
  }finally{await f.db.close();}
});

test('Kết quả quá lease và kết quả của revision cũ không ghi đè link mới',async()=>{
  const f=await fixture();try{
    await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:url(1)});
    const old=await f.service.claimJob();
    await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:url(2)});
    assert.equal((await f.service.workerService(old).completeCheck({fingerprint:fingerprint(1),questionCount:2,qualityPassed:true})).status,'superseded');
    const fresh=await f.service.claimJob();
    await f.pool.query("UPDATE speaking_independent.job SET lease_until=now()-interval '1 second' WHERE id=$1",[fresh.job_id]);
    await assert.rejects(f.service.workerService(fresh).completeCheck({fingerprint:fingerprint(2),questionCount:2,qualityPassed:true}),e=>e.code==='STALE_JOB');
    assert.equal((await f.service.open(f.identity)).links[0].check_status,'pending');
  }finally{await f.db.close();}
});

test('HTTP mở phiên không có Docs và từ chối body lạ, link riêng, hai bài bổ trợ trùng',async()=>{
  const f=await fixture();try{
    const api=request(createIndependentApp({service:f.service}));
    assert.equal((await api.post('/api/speaking-homework-independent/session/start-selected').send({assignmentCode:code,classCode:'IC2304',studentRef:ref,identityConfirmed:true})).status,200);
    assert.equal((await api.post('/api/speaking-homework-independent/open').send({...f.identity,other:'bad'})).status,400);
    await assert.rejects(f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:'https://chatgpt.com/c/123'}),e=>e.code==='INVALID_SHARE_URL');
    await f.service.requestPracticeCheck({...f.identity,slot:1,exerciseId:exercise(1),rawUrl:url(1)});
    await assert.rejects(f.service.requestPracticeCheck({...f.identity,slot:2,exerciseId:exercise(1),rawUrl:url(2)}),e=>e.code==='SAME_CONVERSATION');
  }finally{await f.db.close();}
});

function documentFixture(documentId='fixture-document',ctaUrl='') {
  const run=(text,index=1,style={})=>({startIndex:index,endIndex:index+text.length,textRun:{content:text,textStyle:style}});
  return {documentId,title:'Homework fixture',revisionId:'fixture-revision',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[
    {paragraph:{elements:[run(`SPEAKING - LUYỆN LÝ DO\n${code}\n`)]}},
    {paragraph:{elements:[run('NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING',60,{link:{url:ctaUrl},foregroundColor:{color:{rgbColor:{red:1,green:1,blue:1}}},underline:false})]}},
    {table:{tableRows:[{tableCells:[{content:[{paragraph:{elements:[run('TÌNH TRẠNG NỘP BÀI SPEAKING\n',131)]}}]}]},
      {tableCells:[{content:[{startIndex:163,paragraph:{elements:[run('\n',163)]}}]}]}]}}
  ]}}}]};
}

test('Docs ngoài Classroom được nhận theo nội dung thật, có hồ sơ riêng và không giả lớp/học viên',async()=>{
  const f=await fixture();try{
    const document=documentFixture();
    const docs=createIndependentDocuments({pool:f.pool,source:f.source,accessSecret:'fixture-secret-32-characters-long-only',gateway:{async get(){return document;}}});
    const assignment=await docs.open({documentId:document.documentId,assignmentCode:code});
    assert.equal(assignment.classCode,'DOCS');assert.equal(assignment.intakeMode,'document');
    assert.notEqual(assignment.students[0].student_ref,ref);
    const session=await docs.start({documentId:document.documentId,assignmentCode:code,studentRef:assignment.students[0].student_ref});
    assert.equal(session.documentId,document.documentId);
    assert.equal((await f.service.open({accessToken:session.accessToken,studentRef:session.studentRef})).status,'draft');
    assert.equal((await f.pool.query("SELECT course_id,student_ref FROM speaking_independent.profile WHERE kind='document'")).rows[0].course_id,null);
    const bad=structuredClone(document);bad.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content='SPEAKING - wrong\n67-speaking-lam_ro\n';
    assert.throws(()=>validateIndependentDocument(bad,{documentId:document.documentId,assignmentCode:code}),e=>e.code==='DOCUMENT_CONTENT_INVALID');
    await assert.rejects(docs.start({documentId:document.documentId,assignmentCode:code,studentRef:ref}),e=>e.code==='DOCUMENT_PROFILE_MISMATCH');
  }finally{await f.db.close();}
});

test('Classroom đến sau gắn đúng web unit và giữ tiến độ; cảnh báo nhận ra biên nhận web',async()=>{
  const f=await fixture();try{
    await f.service.requestCheck({...f.identity,part:'benefit_harm',rawUrl:url(1)});
    const docs=createIndependentDocuments({pool:f.pool,source:f.source,accessSecret:'fixture-secret-32-characters-long-only',gateway:{}});
    await docs.register({courseId:'826336470852',courseWorkId:'123456',assignmentCode:code,classroomState:'PUBLISHED'});
    const sync=await docs.sync({courseId:'826336470852',courseWorkId:'123456',submissions:[{id:'fixture-submission',userId:'fixture-user',documentId:'fixture-document'}]});
    assert.equal(sync.pending.length,1);
    let doc=documentFixture();
    const planned=await docs.plan({documentId:doc.documentId,document:doc});
    doc=documentFixture(doc.documentId,planned.url);
    assert.equal((await docs.verify({documentId:doc.documentId,document:doc})).status,'linked');
    const open=await f.service.open(f.identity);assert.equal(open.workUnitId,f.session.workUnitId);assert.equal(open.documentId,doc.documentId);
    assert.equal(open.links[0].share_url,url(1));
    // Biên nhận fixture kiểm riêng câu truy vấn cảnh báo, không chứng nhận chấm nội dung.
    await f.pool.query('INSERT INTO speaking_independent.receipt(work_unit_id) VALUES($1)',[f.session.workUnitId]);
    const scan=await docs.scan({courseId:'826336470852',courseWorkId:'123456',submissions:[{id:'fixture-submission',userId:'fixture-user',state:'TURNED_IN',alternateLink:'https://classroom.google.com/fixture'}]});
    assert.equal(scan.pending,0);assert.equal(await docs.claimAlert({courseId:'826336470852',courseWorkId:'123456'}),null);
  }finally{await f.db.close();}
});

test('Docs gắn lớp lần đầu kế thừa Doctor cũ đúng một lần',async()=>{
  const f=await fixture({start:false,recommendations:[{exercise_id:exercise(1),recommendation_count:3,practice_count:2,waiting:true,proposed_at:'2026-10-01T00:00:00Z',last_practiced_at:null}]});try{
    let doc=documentFixture();
    const docs=createIndependentDocuments({pool:f.pool,source:f.source,accessSecret:'fixture-secret-32-characters-long-only',gateway:{async get(){return doc;}}});
    await docs.open({documentId:doc.documentId,assignmentCode:code});
    await docs.register({courseId:'826336470852',courseWorkId:'123456',assignmentCode:code,classroomState:'PUBLISHED'});
    await docs.sync({courseId:'826336470852',courseWorkId:'123456',submissions:[{id:'fixture-submission',userId:'fixture-user',documentId:doc.documentId}]});
    const planned=await docs.plan({documentId:doc.documentId,document:doc});doc=documentFixture(doc.documentId,planned.url);
    assert.equal((await docs.verify({documentId:doc.documentId,document:doc})).status,'linked');
    assert.equal((await docs.verify({documentId:doc.documentId,document:doc})).status,'linked');
    const session=await f.service.startSelected({assignmentCode:code,classCode:'IC2304',studentRef:ref});
    const doctor=await f.service.listDoctor({accessToken:session.accessToken,studentRef:ref});
    assert.equal(doctor.needed[0].recommendation_count,3);assert.equal(doctor.needed[0].practice_count,2);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_homework.doctor_recommendation')).rows[0].n,0);
  }finally{await f.db.close();}
});

test('Có hai bản chứa tiến độ thì giữ nguyên cả hai và đưa nguồn vào review',async()=>{
  const f=await fixture();try{
    let doc=documentFixture();
    const docs=createIndependentDocuments({pool:f.pool,source:f.source,accessSecret:'fixture-secret-32-characters-long-only',gateway:{async get(){return doc;}}});
    await docs.open({documentId:doc.documentId,assignmentCode:code});
    await docs.register({courseId:'826336470852',courseWorkId:'123456',assignmentCode:code,classroomState:'PUBLISHED'});
    await docs.sync({courseId:'826336470852',courseWorkId:'123456',submissions:[{id:'fixture-submission',userId:'fixture-user',documentId:doc.documentId}]});
    const plan=await docs.plan({documentId:doc.documentId,document:doc});doc=documentFixture(doc.documentId,plan.url);
    assert.equal((await docs.verify({documentId:doc.documentId,document:doc})).status,'review');
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_independent.work_unit')).rows[0].n,2);
    assert.equal((await f.service.open(f.identity)).documentId,null);
  }finally{await f.db.close();}
});

test('Nâng scope của file ngoài lớp giữ claim và khóa hội thoại thật của khóa học',async()=>{
  const f=await fixture();try{
    const p=(await f.pool.query(`INSERT INTO speaking_independent.profile(identity_ref,profile_key,kind,student_name) VALUES($1,'unlinked','document','Fixture') RETURNING id`,[exercise(99)])).rows[0];
    const u=(await f.pool.query(`INSERT INTO speaking_independent.work_unit(profile_id,assignment_code,context_key,template,template_digest,origin,token_hash)
      VALUES($1,$2,'doc',$3,$4,'document',$5) RETURNING id`,[p.id,code,JSON.stringify(template),template.digest,'b'.repeat(64)])).rows[0];
    const l=(await f.pool.query(`INSERT INTO speaking_independent.link(work_unit_id,kind,part,revision,share_url,share_id,fingerprint,status)
      VALUES($1,'main','freestyle',1,$2,$3,$4,'accepted') RETURNING id`,[u.id,url(1),'1'.padStart(32,'0'),fingerprint(1)])).rows[0];
    await f.pool.query('SELECT speaking_independent.reserve_claim($1)',[l.id]);
    await f.pool.query("UPDATE speaking_independent.profile SET course_id='826336470852' WHERE id=$1",[p.id]);
    await f.pool.query('SELECT speaking_independent.reserve_claim($1)',[l.id]);
    await f.pool.query('SELECT speaking_independent.reserve_claim($1)',[l.id]);
    assert.equal((await f.pool.query('SELECT scope_key FROM speaking_independent.claim WHERE link_id=$1',[l.id])).rows[0].scope_key,'course:826336470852');
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_homework.conversation_claim')).rows[0].n,1);
  }finally{await f.db.close();}
});

test('Worker bổ trợ và Doctor ghi lượt luyện/đề xuất đúng một lần, không sửa Doctor cũ',async()=>{
  const f=await fixture();try{
    const conversation={messages:[{role:'assistant',text:'Why do you exercise?'},{role:'user',text:'I exercise to stay healthy.'},{role:'assistant',text:'Use a clearer reason for this habit.'},{role:'user',text:'I exercise because I want to stay healthy.'}]};
    await f.service.requestPracticeCheck({...f.identity,slot:1,exerciseId:exercise(1),rawUrl:url(1)});
    const check=await f.service.claimJob();
    assert.equal((await runPracticeCheckJob(f.service.workerService(check),check,{readShare:async()=>conversation,analyze:async()=>({completed:true})})).status,'accepted');
    const analysis=await f.service.claimJob();assert.equal(analysis.kind,'analyze_practice');
    assert.equal((await runPracticeAnalysisJob(f.service.workerService(analysis),analysis,{readShare:async()=>conversation,analyze:async()=>[{part:'practice',exerciseId:exercise(2),evidenceMessage:3,evidenceQuote:'Use a clearer reason',reason:'Luyện cách giải thích lý do rõ hơn.'}]})).status,'done');
    const doctor=await f.service.listDoctor(f.identity);
    assert.equal(doctor.needed[0].exercise_id,exercise(2));assert.equal(doctor.needed[0].recommendation_count,1);
    assert.equal(doctor.practiced[0].exercise_id,exercise(1));assert.equal(doctor.practiced[0].practice_count,1);
    await assert.rejects(f.service.workerService(analysis).completePracticeAnalysisJob({catalogDigest:'a'.repeat(64),matches:[]}),e=>e.code==='DOCTOR_RESULT_INVALID');
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_homework.doctor_recommendation')).rows[0].n,0);
  }finally{await f.db.close();}
});

if(process.env.SPEAKING_NATIVE_TEST_DATABASE_URL) test('PostgreSQL nhiều connection: mở/nộp đồng thời giữ một unit và một biên nhận',async()=>{
  const f=await fixture();try{
    const sessions=await Promise.all(Array.from({length:12},()=>f.service.startSelected({assignmentCode:code,classCode:'IC2304',studentRef:ref})));
    assert.equal(new Set(sessions.map(s=>s.workUnitId)).size,1);
    for(const [part,count,n] of [['benefit_harm',0,1],['reason_action',2,2],['freestyle',1,3]]) {
      await f.service.requestCheck({...f.identity,part,rawUrl:url(n)});
      if(count){const j=await f.service.claimJob();await f.service.workerService(j).completeCheck({qualityPassed:true,fingerprint:fingerprint(n),questionCount:count});}
    }
    for(let slot=1;slot<=2;slot++) {
      await f.service.requestPracticeCheck({...f.identity,slot,exerciseId:exercise(slot),rawUrl:url(slot+3)});
      let j=await f.service.claimJob();if(j.kind==='analyze_practice'){await f.service.failJob(j,'FIXTURE_ANALYSIS');j=await f.service.claimJob();}
      await f.service.workerService(j).completePracticeCheck({qualityPassed:true,fingerprint:fingerprint(slot+3),questionCount:1,matchedExerciseId:exercise(slot)});
    }
    const receipts=await Promise.all(Array.from({length:12},()=>f.service.finish(f.identity)));
    assert.equal(new Set(receipts.map(r=>r.id)).size,1);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM speaking_independent.receipt')).rows[0].n,1);
  }finally{await f.db.close();}
});
