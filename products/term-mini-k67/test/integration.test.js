import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createErpGradeSync } from '../src/erp-sync.js';
import { createTermTestWritingGradingService } from '../src/term-test-writing-grading.js';

// Nhận DB mới có marker qua harness. Chạy HTTP/SQL thật với người và đề giả.
// Chỉ giả lập Google và kết quả AI; lỗi hiện ở native TAP, không gọi điểm Portal thật.
const fixtureId = process.env.K67_HTTP_FIXTURE_ID;
const database = process.env.K67_HTTP_DATABASE;
assert.match(database || '', /^term_mini_k67_test_http_[0-9a-f]{12}$/);
assert.match(fixtureId || '', /^synthetic-http-[0-9a-f]{32}$/);
function url(field, role) {
  assert.equal(process.env.K67_TEST_FIXTURE_CONFIRMATION, 'synthetic-fixture-20261006');
  const value = new URL(process.env[field]);
  assert.equal(value.hostname, '127.0.0.1');
  assert.equal(value.pathname, `/${database}`);
  assert.equal(value.username, role);
  assert.equal(value.search, '');
  assert.equal(value.hash, '');
  return value.href;
}
const pool = new pg.Pool({ connectionString: url('K67_TEST_DATABASE_URL', 'k67_app'), max: 5 });
const owner = new pg.Pool({ connectionString: url('K67_TEST_OWNER_URL', 'k67_owner'), max: 2 });
const classCode = 'K67HTTP';
const classId = '1124';
const otherCode = 'K67HTTPOTHER';
const teacher = 'http-teacher@example.test';
const studentName = 'Học viên HTTP mô phỏng';
const credential = 'synthetic-google-credential-for-http';
const origin = 'http://k67-fixture.test';
const secret = crypto.randomBytes(40).toString('hex');
const slugs = ['term-test-1', 'term-test-2', 'mini-test-lesson-5'];
const students = new Map(slugs.map((slug, index) => [slug, { ref: crypto.randomUUID(), id: String(9870677001 + index) }]));
const allowedStudentPairs = new Set(slugs.map(slug => `${slug}:${students.get(slug).id}`));
const attempts = new Map();
const sent = new Map();
let appServer, destination, base, writerBase, cookie;
let failErpAck = false;
function content(slug) {
  return { title: 'Đề HTTP mô phỏng', listening: { sections: [{ label:'Nghe', range:'1-40', html:'<p>Nghe mô phỏng</p>' }] },
    reading: { sections: [{ label:'Đọc', range:'1-40', title:'Đọc giả', passageHtml:'<p>Đoạn đọc giả</p>', questionsHtml:'<p>Câu hỏi giả</p>' }] },
    writing: { tasks: slug.startsWith('mini') ? [] : (slug === 'term-test-1' ? [2] : [1,2]).map(number => ({
      id:`task${number}`, label:`Task ${number}`, prompt:'Đề Writing mô phỏng', minimumWords:1
    })) } };
}
const assets = { supports: slug => slugs.includes(slug), getContent: async slug => content(slug),
  getTiming: () => ({ listeningTotalSeconds:1800, readingDurationMinutes:60, writingDurationMinutes:60 }),
  getSessionAudioKey: () => Buffer.alloc(32, 1) };
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function request(path, body, headers = {}, expected = 200, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers:{ origin, 'content-type':'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal:AbortSignal.timeout(10000) });
  const value = await response.json();
  assert.equal(response.status, expected, `${path}: ${value.error || value.message || 'unexpected status'}`);
  return { value, response };
}
const gradingHeaders = { 'x-writing-test-sync':secret };
before(async () => {
  assert.deepEqual((await owner.query('SELECT * FROM mapping.k67_fixture_identity')).rows,
    [{ product_id:'PRODUCT-TERM-MINI-K67', fixture_id:fixtureId }]);
  assert.equal((await pool.query('SELECT current_database() AS name,current_user AS role')).rows[0].name, database);
  await owner.query('INSERT INTO mapping.classroom_course_mapping VALUES (1124,$1),(1131,$2)', [classCode, otherCode]);
  await owner.query(`INSERT INTO mapping.k67_context_state(api_version,product_id,source_revision,captured_at)
    VALUES(1,'PRODUCT-TERM-MINI-K67',repeat('a',64),now())`);
  await owner.query(`INSERT INTO mapping.reviewer_account(email,google_subject,display_name)
    VALUES ($1,'synthetic-subject','Giảng viên HTTP mô phỏng')`, [teacher]);
  await owner.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1124)', [teacher]);
  await owner.query('INSERT INTO mapping.erp_class_membership_snapshot VALUES(1124,$1,$2,\'active\')',
    [students.get('mini-test-lesson-5').id, studentName]);
  const definition = { questions:Array.from({ length:40 }, (_, i) => ({ number:i+1, type:'Câu giả', accepted:['answer'] })), pairGroups:{} };
  for (const slug of slugs) {
    await owner.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
      VALUES($1,'Đề HTTP mô phỏng',1,$2,$2,true)`, [slug, JSON.stringify(definition)]);
    const student = students.get(slug);
    await owner.query(`INSERT INTO assessment.term_test_roster(test_slug,erp_course_class_id,erp_student_contact_id,student_ref,student_name_snapshot)
      VALUES($1,1124,$2,$3,$4)`, [slug,student.id,student.ref,studentName]);
  }
  destination = http.createServer(async (req, res) => {
    // Đích điểm giả chỉ nhận định danh fixture; GET đọc lại dữ liệu đã thực sự nhận.
    res.setHeader('content-type','application/json');
    if (req.method === 'GET') { res.end(JSON.stringify([...sent.values()])); return; }
    if (req.method !== 'POST' || req.headers['x-term-test-sync'] !== secret) {
      res.writeHead(401); res.end('{"ok":false}'); return;
    }
    try {
      let data=''; for await (const chunk of req) data+=chunk;
      const value=JSON.parse(data);
      assert.equal(value.classId,classId);
      assert.equal(allowedStudentPairs.has(`${value.testSlug}:${value.studentId}`),true);
      assert.match(value.attemptToken,/^[0-9a-f-]{36}$/);
      // Mô phỏng n8n lỗi nhưng HTTP200 rỗng; caller phải giữ việc ghi điểm chưa hoàn tất.
      if (failErpAck) { res.end(''); return; }
      sent.set(value.attemptToken,value);
      res.end(JSON.stringify({ ok:true,status:'synced',attemptToken:value.attemptToken }));
    } catch { res.writeHead(422); res.end('{"ok":false}'); }
  });
  writerBase = await listen(destination);
  const config = loadConfig({ K67_ENV:'test', K67_DATABASE_URL:url('K67_TEST_DATABASE_URL','k67_app'),
    K67_GOOGLE_CLIENT_ID:'http-fixture', K67_ALLOWED_ORIGINS:origin, K67_PUBLIC_API_BASE_URL:'http://k67-fixture.test/term-mini-k67-api',
    K67_ERP_SYNC_URL:writerBase, K67_ERP_SYNC_SECRET:secret, K67_WRITING_SYNC_SECRET:secret, K67_MINI_SYNC_SECRET:secret,
    K67_SESSION_SECRET:secret, K67_ASSET_DIR:'/synthetic-assets', K67_APP_VERSION:'http-fixture', K67_BUILD_SHA:'a'.repeat(64) });
  const syncErpGrades=createErpGradeSync({ config });
  const service=createTermTestWritingGradingService({ pool,syncErpGrades });
  const app=createApp({ config,pool,termTestAssetService:assets,termTestWritingGradingService:service,syncErpGrades,
    logger:{ info(){} }, verifyGoogleToken:async token => {
      if (token !== credential) throw new Error('synthetic token rejected');
      return { email:teacher,sub:'synthetic-subject',email_verified:true };
    } });
  appServer=http.createServer(app);
  base=await listen(appServer);
});
after(async () => {
  for (const server of [appServer,destination]) if (server) await new Promise(resolve => server.close(resolve));
  await Promise.all([pool.end(),owner.end()]);
});

test('HTTP readiness, CORS và đường sản phẩm khác giữ đúng ranh giới K67', async () => {
  assert.equal((await request('/ready')).value.ok,true);
  await request('/api/term-tests/roster?class=K67HTTP&test=term-test-1',undefined,{origin:'http://not-allowed.test'},403);
  await request('/api/progress-log/lessons',undefined,{},404);
  await request('/api/speaking/tasks',undefined,{},404);
});
test('HTTP giảng viên dùng cookie K67 riêng và không xem được lớp chưa cấp', async () => {
  await request('/api/term-tests/teacher/options',undefined,{},401);
  const logged=await request('/api/auth/session',{credential},{},201);
  const header=logged.response.headers.get('set-cookie');
  assert.match(header,/^izone_k67_teacher_session=/);
  assert.match(header,/Path=\/term-mini-k67-api/);
  cookie=header.split(';')[0];
  const options=(await request('/api/term-tests/teacher/options',undefined,{cookie})).value;
  assert.equal(options.classes.length,1);
  assert.equal(options.classes[0].name,classCode);
  await request('/api/term-tests/teacher/results?class=K67HTTPOTHER&test=term-test-1',undefined,{cookie},403);
});
for (const slug of slugs) test(`HTTP hành trình ${slug}: nháp, nộp lặp, kết quả và readback`, async () => {
  const student=students.get(slug);
  const roster=(await request(`/api/term-tests/roster?class=${classCode}&test=${slug}`)).value;
  assert.deepEqual(roster.students,[{ref:student.ref,name:studentName}]);
  const prepared=(await request(`/api/term-tests/${slug}/session/prepare`,{classCode,studentRef:student.ref},{},201)).value;
  const session=prepared.examSessionToken;
  const started=(await request(`/api/term-tests/${slug}/session/start`,{examSessionToken:session})).value;
  assert.equal(started.content.title,'Đề HTTP mô phỏng');
  const repeatStart=(await request(`/api/term-tests/${slug}/session/start`,{examSessionToken:session})).value;
  assert.equal(repeatStart.listeningDeadlineAt,started.listeningDeadlineAt);
  const answers=Object.fromEntries(Array.from({length:40},(_,i)=>[String(i+1),'answer']));
  await request(`/api/term-tests/${slug}/listening/draft`,{examSessionToken:session,revision:2,answers});
  const stale=(await request(`/api/term-tests/${slug}/listening/draft`,{examSessionToken:session,revision:1,answers:{1:'wrong'}})).value;
  assert.equal(stale.accepted,false);
  assert.deepEqual(stale.draft,answers);
  const submission={classCode,studentRef:student.ref,examSessionToken:session,clientSubmissionId:crypto.randomUUID(),draftRevision:2,answers};
  const listening=(await request(`/api/term-tests/${slug}/listening`,submission,{},201)).value;
  const attemptToken=listening.attemptToken;
  attempts.set(slug,attemptToken);
  const duplicate=(await request(`/api/term-tests/${slug}/listening`,{...submission,answers:{1:'wrong'}},{},201)).value;
  assert.equal(duplicate.attemptToken,attemptToken);
  assert.equal(duplicate.result.listening.correct,40);
  await request(`/api/term-tests/${slug}/reading/start`,{attemptToken});
  await request(`/api/term-tests/${slug}/reading/draft`,{attemptToken,revision:2,answers});
  await request(`/api/term-tests/${slug}/reading`,{attemptToken,draftRevision:2,answers});
  await request(`/api/term-tests/${slug}/reading`,{attemptToken,draftRevision:3,answers:{1:'wrong'}});
  if (!slug.startsWith('mini')) {
    const startedWriting=(await request('/api/term-tests/writing',{attemptToken,action:'start',task1:'',task2:''})).value.writing;
    const draft=(await request('/api/term-tests/writing',{attemptToken,action:'draft',task1:slug==='term-test-2'?'Synthetic essay one.':'',task2:'Synthetic essay two.',baseRevision:startedWriting.revision})).value.writing;
    assert.equal(draft.accepted,true);
    const submitted=(await request('/api/term-tests/writing',{attemptToken,action:'submit',task1:draft.task1,task2:draft.task2,baseRevision:draft.revision})).value.writing;
    assert.equal(submitted.submitted,true);
    const workerId='k67-http-worker';
    const dispatch=(await request('/api/term-tests/writing-grading/jobs/claim',{workerId},gradingHeaders)).value.jobs;
    assert.equal(dispatch.length,slug==='term-test-1'?1:2);
    for (const job of dispatch) {
      const beforeWrongOwner=(await owner.query('SELECT to_jsonb(job) AS row FROM assessment.term_test_writing_grading_job job WHERE id=$1',[job.jobId])).rows[0].row;
      await request('/api/term-tests/writing-grading/jobs/dispatch-complete',{jobId:job.jobId,workerId:'wrong-owner'},gradingHeaders,409);
      assert.deepEqual((await owner.query('SELECT to_jsonb(job) AS row FROM assessment.term_test_writing_grading_job job WHERE id=$1',[job.jobId])).rows[0].row,beforeWrongOwner);
      const completed=await request('/api/term-tests/writing-grading/jobs/dispatch-complete',{jobId:job.jobId,workerId},gradingHeaders);
      assert.equal(completed.value.status,'accepted');
    }
    // Chỉ làm tới hạn các job giả trong DB mới; không chờ 45 giây hoặc đổi thời gian runtime.
    await owner.query("UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now() WHERE job_type='collect'");
    const collect=(await request('/api/term-tests/writing-grading/jobs/claim',{workerId},gradingHeaders)).value.jobs;
    assert.equal(collect.length,dispatch.length);
    for (const job of collect) {
      const criteria=(job.taskNumber===1?['TA','CC','LR','GRA']:['TR','CC','LR','GRA']).map(code=>({code,bandScore:6,feedback:'Nhận xét giả'}));
      const callback={jobId:job.jobId,workerId,runKey:job.runKey,result:{taskScore:6,criteria}};
      const beforeInvalid=(await owner.query(`SELECT jsonb_build_object('job',to_jsonb(job),'run',to_jsonb(run),
        'criteria',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.criterion_code),'[]'::jsonb)
          FROM assessment.term_test_writing_grading_criterion c WHERE c.run_id=run.id)) AS value
        FROM assessment.term_test_writing_grading_job job JOIN assessment.term_test_writing_grading_run run ON run.id=job.run_id WHERE job.id=$1`,[job.jobId])).rows[0].value;
      await request('/api/term-tests/writing-grading/jobs/result',{...callback,runKey:'wrong-run-key-value-000000',
        result:{taskScore:9,criteria:criteria.map(item=>({...item,bandScore:9}))}},gradingHeaders,409);
      const afterInvalid=(await owner.query(`SELECT jsonb_build_object('job',to_jsonb(job),'run',to_jsonb(run),
        'criteria',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.criterion_code),'[]'::jsonb)
          FROM assessment.term_test_writing_grading_criterion c WHERE c.run_id=run.id)) AS value
        FROM assessment.term_test_writing_grading_job job JOIN assessment.term_test_writing_grading_run run ON run.id=job.run_id WHERE job.id=$1`,[job.jobId])).rows[0].value;
      assert.deepEqual(afterInvalid,beforeInvalid);
      assert.equal((await request('/api/term-tests/writing-grading/jobs/result',callback,gradingHeaders)).value.status,'accepted');
      assert.equal((await request('/api/term-tests/writing-grading/jobs/result',callback,gradingHeaders)).value.status,'duplicate');
    }
  }
  const result=(await request('/api/term-tests/result',{attemptToken})).value;
  assert.equal(result.testSlug,slug);
  assert.equal(result.result.listening.correct,40);
  assert.equal(result.result.reading.correct,40);
  assert.equal(result.completed,true);
  if (!slug.startsWith('mini')) {
    assert.equal(result.writing.grading.ready,true);
    assert.equal(result.writing.grading.writingScore,6);
    const readback=await (await fetch(writerBase)).json();
    assert.deepEqual(readback.find(item=>item.attemptToken===attemptToken),{version:1,attemptToken,testSlug:slug,classId,studentId:student.id,grades:{listening:9,reading:9,writing:6}});
    const review=(await request('/api/term-tests/result/review',{attemptToken})).value.review;
    assert.equal(review.answers.writing.task1,slug==='term-test-2'?'Synthetic essay one.':'');
    assert.equal(review.answers.writing.task2,'Synthetic essay two.');
    assert.equal(review.answers.reading['1'],'answer');
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_criterion')).rows[0].n,slug==='term-test-1'?4:12);
  }
});
test('HTTP Mini callback cũ kiểm khóa và không tạo trùng bản ghi', async () => {
  const payload={version:1,sourceSubmissionKey:crypto.randomBytes(32).toString('hex'),testSlug:'mini-test-lesson-5',classCode,studentName,
    scores:{listeningCorrect:20,readingCorrect:13},typeStats:[{type:'Dạng giả',correct:33,total:33}]};
  await request('/api/mini-tests/results',payload,{},401);
  for (let i=0;i<2;i++) await request('/api/mini-tests/results',payload,{'x-mini-test-sync':secret},201);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM assessment.mini_test_result WHERE source_submission_key=$1',[payload.sourceSubmissionKey])).rows[0].n,1);
});
test('HTTP ACK Portal lỗi giữ bài và kết quả; collect thử lại cùng job, không chấm lại', async () => {
  // Người/bài mới hoàn toàn trong DB fixture; callback AI giả, caller/HTTP/SQL thật.
  // HTTP200 rỗng phải trả 503, giữ collect processing; /fail đưa retry_wait và giữ điểm.
  const studentRef=crypto.randomUUID(), studentId='9870677090', slug='term-test-1';
  allowedStudentPairs.add(`${slug}:${studentId}`);
  await owner.query(`INSERT INTO assessment.term_test_roster(test_slug,erp_course_class_id,erp_student_contact_id,student_ref,student_name_snapshot)
    VALUES($1,1124,$2,$3,'Học viên thử lỗi ghi điểm')`,[slug,studentId,studentRef]);
  const session=(await request(`/api/term-tests/${slug}/session/prepare`,{classCode,studentRef},{},201)).value.examSessionToken;
  await request(`/api/term-tests/${slug}/session/start`,{examSessionToken:session});
  const answers=Object.fromEntries(Array.from({length:40},(_,i)=>[String(i+1),'answer']));
  const attemptToken=(await request(`/api/term-tests/${slug}/listening`,{classCode,studentRef,examSessionToken:session,
    clientSubmissionId:crypto.randomUUID(),draftRevision:1,answers},{},201)).value.attemptToken;
  await request(`/api/term-tests/${slug}/reading/start`,{attemptToken});
  await request(`/api/term-tests/${slug}/reading`,{attemptToken,answers});
  const started=(await request('/api/term-tests/writing',{attemptToken,action:'start',task1:'',task2:''})).value.writing;
  const essay='Synthetic essay retained after Portal failure.';
  await request('/api/term-tests/writing',{attemptToken,action:'submit',task1:'',task2:essay,baseRevision:started.revision});
  const workerId='k67-http-portal-fault';
  const dispatch=(await request('/api/term-tests/writing-grading/jobs/claim',{workerId},gradingHeaders)).value.jobs;
  assert.equal(dispatch.length,1);assert.equal(dispatch[0].jobType,'dispatch');
  await request('/api/term-tests/writing-grading/jobs/dispatch-complete',{jobId:dispatch[0].jobId,workerId},gradingHeaders);
  await owner.query(`UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now()
    WHERE job_type='collect' AND run_id=(SELECT run_id FROM assessment.term_test_writing_grading_job WHERE id=$1)`,[dispatch[0].jobId]);
  const collect=(await request('/api/term-tests/writing-grading/jobs/claim',{workerId},gradingHeaders)).value.jobs;
  assert.equal(collect.length,1);assert.equal(collect[0].jobType,'collect');
  const job=collect[0];
  const callback={jobId:job.jobId,workerId,runKey:job.runKey,result:{taskScore:6,
    criteria:['TR','CC','LR','GRA'].map(code=>({code,bandScore:6,feedback:'Nhận xét giả được giữ nguyên'}))}};
  const sentBefore=sent.get(attemptToken);
  const gradeEvidence=async ()=>(await owner.query(`SELECT jsonb_build_object('essay',r.essay_text,
    'criteria',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'code',c.criterion_code,'status',c.status,'band',c.band_score,'feedback',c.feedback)
      ORDER BY c.criterion_code) FROM assessment.term_test_writing_grading_criterion c WHERE c.run_id=r.id),
    'final',(SELECT jsonb_build_object('status',f.status,'version',f.grading_version,'task2Run',f.task_2_run_id,
      'task2Score',f.task_2_score,'writingScore',f.writing_score) FROM assessment.term_test_writing_grading_final f WHERE f.attempt_id=r.attempt_id)) AS value
    FROM assessment.term_test_writing_grading_job j JOIN assessment.term_test_writing_grading_run r ON r.id=j.run_id WHERE j.id=$1`,[job.jobId])).rows[0].value;
  try {
    failErpAck=true;
    const failed=await request('/api/term-tests/writing-grading/jobs/result',callback,gradingHeaders,503);
    assert.equal(failed.value.error,'WRITING_PORTAL_SYNC_FAILED');
    assert.equal((await owner.query('SELECT status FROM assessment.term_test_writing_grading_job WHERE id=$1',[job.jobId])).rows[0].status,'processing');
    const preserved=await gradeEvidence();
    assert.equal(preserved.essay,essay);assert.equal(preserved.criteria.length,4);
    assert.equal(preserved.final.status,'ready');assert.equal(preserved.final.writingScore,6);
    assert.deepEqual(sent.get(attemptToken),sentBefore);
    const fail=(await request('/api/term-tests/writing-grading/jobs/fail',{jobId:job.jobId,workerId,errorCode:'WRITING_PORTAL_SYNC_FAILED'},gradingHeaders)).value;
    assert.equal(fail.status,'retry_wait');assert.equal(fail.runKey,job.runKey);
    assert.equal((await owner.query('SELECT status FROM assessment.term_test_writing_grading_job WHERE id=$1',[job.jobId])).rows[0].status,'retry_wait');
    assert.deepEqual(await gradeEvidence(),preserved);
    // Chỉ đưa job giả mới này tới hạn trong DB fixture, không đổi đồng hồ hoặc job trước đó.
    await owner.query('UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now() WHERE id=$1',[job.jobId]);
    const retried=(await request('/api/term-tests/writing-grading/jobs/claim',{workerId},gradingHeaders)).value.jobs;
    assert.equal(retried.length,1);assert.equal(retried[0].jobId,job.jobId);assert.equal(retried[0].runKey,job.runKey);
    assert.equal(retried[0].attemptCount,job.attemptCount+1);
    failErpAck=false;
    const saved=(await request('/api/term-tests/writing-grading/jobs/result',callback,gradingHeaders)).value;
    assert.equal(saved.portalSyncStatus,'synced');
    assert.equal((await owner.query('SELECT status FROM assessment.term_test_writing_grading_job WHERE id=$1',[job.jobId])).rows[0].status,'complete');
    assert.deepEqual(await gradeEvidence(),preserved);
    assert.equal(sent.get(attemptToken).grades.writing,6);
    assert.equal((await request('/api/term-tests/result/review',{attemptToken})).value.review.answers.writing.task2,essay);
  } finally { failErpAck=false; }
});

test('HTTP ngữ cảnh hết hạn chặn quyền mới nhưng bài đã bắt đầu vẫn lưu và đọc được', async () => {
  const studentRef=crypto.randomUUID();
  allowedStudentPairs.add('term-test-1:9870677999');
  await owner.query(`INSERT INTO assessment.term_test_roster(test_slug,erp_course_class_id,erp_student_contact_id,student_ref,student_name_snapshot)
    VALUES('term-test-1',1124,9870677999,$1,'Học viên thử nguồn lỗi')`,[studentRef]);
  const session=(await request('/api/term-tests/term-test-1/session/prepare',{classCode,studentRef},{},201)).value.examSessionToken;
  await request('/api/term-tests/term-test-1/session/start',{examSessionToken:session});
  await owner.query("UPDATE mapping.k67_context_state SET captured_at=now()-interval '5 minutes'");
  await request('/api/term-tests/roster?class=K67HTTP&test=term-test-1',undefined,{},503);
  await request('/api/term-tests/teacher/options',undefined,{cookie},503);
  const attemptToken=attempts.get('term-test-1');
  assert.equal((await request('/api/term-tests/result',{attemptToken})).value.writing.grading.ready,true);
  // Đọc/nộp lại bài đã thu không đòi ngữ cảnh; bài canonical không bị sửa khi gửi khác.
  await request('/api/term-tests/term-test-1/reading',{attemptToken,answers:{1:'wrong'}});
  assert.equal((await request('/api/term-tests/result',{attemptToken})).value.result.reading.correct,40);
  const answers={1:'answer'};
  await request('/api/term-tests/term-test-1/listening/draft',{examSessionToken:session,revision:1,answers});
  const saved=(await request('/api/term-tests/term-test-1/listening',{classCode,studentRef,examSessionToken:session,
    clientSubmissionId:crypto.randomUUID(),draftRevision:1,answers},{},201)).value;
  assert.equal((await request('/api/term-tests/result',{attemptToken:saved.attemptToken})).value.result.listening.correct,1);
});
