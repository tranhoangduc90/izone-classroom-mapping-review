import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';
import { startTerm1TimerSweep } from '../src/term1-listening-timer.js';

const base = '/api/term-tests/term-test-1';
const first = { classCode: 'IC2304', studentRef: '11111111-1111-4111-8111-111111111111' };
const second = { classCode: 'IC2304', studentRef: '44444444-4444-4444-8444-444444444444' };
const deviceProof = 'b'.repeat(64);
const questions = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, type: 'Fixture', accepted: ['A'] }));
const answers = Object.fromEntries(questions.filter(q => q.number <= 30).map(q => [q.number, 'A']));
const assets = { supports: () => true, getSessionAudioKey: () => Buffer.alloc(32),
  getContent: () => ({ title: 'Term Test 1 fixture', variant: 'semantic-html', listening: { instructions: [],
    sections: [{ label: 'Part 1', range: 'Questions 1–40', html: questions.map(q =>
      `<p data-question-number="${q.number}">Question ${q.number} <span data-answer-slot="${q.number}"></span></p>`).join('') }] } }),
  getTiming: () => ({ listeningDurationSeconds: 1735, listeningReviewSeconds: 120, listeningTotalSeconds: 1855 }) };

test('shared deadline closes a disconnected timer attempt and publishes the native Listening grade', async t => {
  const allowedOrigins = new Set();
  const { db, pool, app } = await createMiniFixture({ assets, allowedOrigins, examOrder: true, completeSchema: true, term1ListeningTimerMode: 'on' });
  t.after(() => db.close());
  await db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES('term-test-1','Fixture',1,$1,$1,true)`, [JSON.stringify({ questions })]);
  const portal = process.env.TERM1_TIMER_PORTAL_SOURCE;
  const cutoverAt = new Date(Date.now()-60_000).toISOString();
  if (portal) {
    const sql = async file => readFile(join(portal,'client',file), 'utf8');
    await db.exec(await sql('exam-source.sql'));
    await db.exec(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='portal_exam_k67_source') THEN
      CREATE ROLE portal_exam_k67_source; END IF; END $$;`);
    await db.exec(await sql('k67-attempt-roster.sql'));
    await db.exec((await sql('exam-capture.sql')).replaceAll('__NATIVE_SCHEMA__','assessment').replace('__WRITING_SCOPE_GUARD__',''));
    await db.query(`UPDATE portal_exam.capture_control SET enabled=true,writes_enabled=true,cutover_at=$1 WHERE id=1`, [cutoverAt]);
    await db.query(`UPDATE portal_exam.k67_class_roster_control SET enrolled_from=$1 WHERE id=1`, [cutoverAt]);
    await db.exec('GRANT USAGE ON SCHEMA portal_exam TO k67_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA portal_exam TO k67_app;');
  }
  const browser = process.env.TERM1_TIMER_BROWSER_SCRIPT;
  await db.query(`INSERT INTO assessment.term1_listening_timer_room VALUES(1293,clock_timestamp()-interval '1 second',
    clock_timestamp()+make_interval(secs=>$1))`, [browser ? 30 : 4]);
  const api = request(app);
  const post = async (path, body) => {
    const response = await api.post(base + path).send(body);
    assert.ok(response.ok, response.text);
    return response.body;
  };
  const audio = await post('/session/prepare', first);
  const startedAudio = await post('/session/start', { examSessionToken: audio.examSessionToken });
  if (browser) {
    const pages = resolve(process.env.TERM1_TIMER_PAGES);
    const server = createServer(async (req, res) => {
      if (req.url.startsWith('/api/')) return app(req, res);
      const url = new URL(req.url, 'http://localhost');
      const file = resolve(pages, '.' + url.pathname);
      if (!file.startsWith(pages + sep)) { res.writeHead(404).end(); return; }
      try {
        let data = await readFile(file);
        const type = file.endsWith('.html') ? 'text/html' : /\.m?js$/.test(file) ? 'text/javascript' :
          file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith(`${sep}k67-shared${sep}config.js`)) data = data.toString().replace(/API_BASE_URL: '[^']+'/, "API_BASE_URL: location.origin");
        res.writeHead(200, { 'Content-Type': type }).end(data);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      allowedOrigins.add(origin);
      const result = await promisify(execFile)('python',[browser,origin,second.studentRef,startedAudio.listeningDeadlineAt],{ timeout:25000 });
      t.diagnostic(result.stdout.trim());
    } finally { await new Promise(r => server.close(r)); }
  }
  const waiting = await post('/listening-timer/prepare', { ...second, deviceProof });
  const scope = { ...second, deviceProof, examSessionToken: waiting.examSessionToken, generation: waiting.generation };
  const startedTimer = await post('/listening-timer/start', scope);
  assert.equal(startedAudio.listeningDeadlineAt, startedTimer.listeningDeadlineAt);
  assert.ok(Date.parse(startedTimer.serverNow) > Date.parse(startedAudio.serverNow));
  assert.equal(startedTimer.audioKey, undefined);
  assert.equal(startedTimer.content.reading, undefined);
  const wrong = await api.post(base+'/listening-timer/draft').send({ ...scope, deviceProof:'c'.repeat(64), answers, revision:1 });
  assert.equal(wrong.status,403);
  const secondTab = await api.post(base+'/session/start').send({ examSessionToken: scope.examSessionToken });
  assert.equal(secondTab.body.error,'TIMER_SESSION_REQUIRED');
  if (browser) assert.deepEqual(startedTimer.listeningDraft,answers);
  else assert.equal((await post('/listening-timer/draft', { ...scope, answers, revision: 1 })).accepted,true);
  const newDeadline = (await db.query(`UPDATE assessment.term1_listening_timer_room SET deadline_at=deadline_at+interval '1 second'
    WHERE class_id=1293 RETURNING deadline_at`)).rows[0].deadline_at;
  const deadlines = (await db.query('SELECT DISTINCT listening_deadline_at FROM assessment.term_test_exam_session')).rows;
  assert.deepEqual(deadlines.map(row => +new Date(row.listening_deadline_at)),[+new Date(newDeadline)]);
  await post('/listening/draft', { examSessionToken: audio.examSessionToken, answers, revision:1 });
  await app.locals.closeExpiredTerm1TimerSessions();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
  // The timer client sends no submission. Run the same periodic collector the server starts in production.
  const sweepErrors = [];
  const stop = startTerm1TimerSweep(app.locals.closeExpiredTerm1TimerSessions, error => sweepErrors.push(error));
  try {
    await sleep(Math.max(0, +newDeadline-Date.now())+80);
    await post('/listening', { ...first, examSessionToken: audio.examSessionToken, answers, draftRevision:1, clientSubmissionId:randomUUID() });
    await sleep(750);
  } finally { await stop(); }
  assert.deepEqual(sweepErrors,[]);
  const status = await post('/listening-timer/status', scope);
  assert.equal(status.listeningSubmitted,true);
  const retried = await post('/listening-timer/submit', { ...scope, answers: {}, revision:2 });
  assert.equal(retried.attemptToken,status.attemptToken);
  const rows = (await db.query(`SELECT erp_student_contact_id, listening_answers, listening_result->>'band' AS band, listening_submitted_at
    FROM assessment.term_test_attempt ORDER BY erp_student_contact_id`)).rows;
  assert.equal(rows.length,2);
  for(const row of rows) {
    assert.equal(row.band,'7');
    assert.deepEqual(row.listening_answers,answers);
    assert.ok(+row.listening_submitted_at>=+newDeadline && +row.listening_submitted_at<+newDeadline+3000);
  }
  if (portal) {
    const { drainExamNative } = await import(pathToFileURL(join(portal,'client/exam-source.mjs')));
    const { inspectPortal, verifyPortal } = await import(pathToFileURL(join(portal,'src/legacy.mjs')));
    assert.equal(await drainExamNative(pool,{family:'k67',cutoverAt}),2);
    const pending=(await db.query(`SELECT hub_payload FROM portal_exam.source_event ORDER BY (hub_payload->>'studentId')`)).rows;
    assert.deepEqual(pending.map(({hub_payload:p})=>[p.classId,p.studentId,p.targetName,p.value]),
      [['1293','900001','Phase 1 Listening',7],['1293','900002','Phase 1 Listening',7]]);
    const portalState = { course_class_id: 1293,
      class_registrations: [900001,900002].map(id => ({ contact:{ id }, class_registration:{ id:id+100, course_class_id:1293 } })),
      class_tests: ['Listening','Reading','Writing'].map((name,id) =>
      ({ id: 44+id, name: 'Phase 1 ' + name, max_grade: 9 })), student_test_grades: [] };
    const portalServer = createServer(async (req,res) => {
      if (req.url !== '/portal/v1/course-classes/1293/student-tests') { res.writeHead(404).end(); return; }
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        portalState.student_test_grades.push({ ...body, meta: { records: [{ id: 1000+portalState.student_test_grades.length, grade: body.grade }] } });
      }
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(portalState));
    });
    await new Promise(r => portalServer.listen(0,'127.0.0.1',r));
    try {
      const url = `http://127.0.0.1:${portalServer.address().port}/portal/v1/course-classes/1293/student-tests`;
      for (const { hub_payload: payload } of pending) {
        const before = inspectPortal(payload, await (await fetch(url)).json());
        assert.equal(before.body.class_test_id,44);
        assert.ok((await fetch(url,{ method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(before.body) })).ok);
        const after = verifyPortal(payload, await (await fetch(url)).json(), before.snapshot);
        assert.equal(after.confirmed,true);
      }
      assert.deepEqual(portalState.student_test_grades.map(r => [r.student_id,r.class_test_id,r.grade]), [[900001,44,7],[900002,44,7]]);
      t.diagnostic('Portal fixture GET/PUT/GET: two verified Phase 1 Listening grades, zero Reading/Writing writes');
    } finally { await new Promise(r => portalServer.close(r)); }
  }
  t.diagnostic(`deadline=${newDeadline.toISOString()} commits=${rows.map(r=>r.listening_submitted_at.toISOString()).join(',')} band=${rows[1].band}`);
});
