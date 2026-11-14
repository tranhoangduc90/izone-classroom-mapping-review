import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import express from 'express';
import pg from 'pg';
import {createLearningRouter} from '../src/learning-routes.js';
import {createLearningAttendanceSync} from '../src/learning-attendance-sync.js';
import {claimLearningJobs,processLearningJob} from '../src/learning-outbox.js';
import {reuseLearningQueryPlans} from '../src/learning-query-plans.js';
import {postgresFixture,publishedFixture} from './learning-postgres-fixture.js';

const pages=process.env.PAGES_SOURCE_ROOT;
assert.ok(pages,'Set PAGES_SOURCE_ROOT to the Pages worktree');
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||
  'C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');
const migration=await readFile(new URL('../ops/learning-migrations/202610230001_teacher_live_updates.sql',import.meta.url),'utf8');
const reviewer={email:'teacher@example.test',displayName:'Giảng viên mẫu',canAccessAllClasses:false};

const cases=[
  {title:'Bài nộp PostgreSQL đến Chrome qua SSE',stream:true,studentCount:5},
  {title:'Bài nộp PostgreSQL đến Chrome qua đọc dự phòng',stream:false,studentCount:5},
  {title:'20 bài và điểm danh Portal giả khi hai tab GV cùng xem qua SSE và đọc dự phòng',stream:true,studentCount:20}
];
for(const {title,stream,studentCount} of cases)test(title,{timeout:120000},async()=>{
  const mixedPilot=studentCount===20;
  const fixture=await postgresFixture({asApplication:true,studentCount});
  const pool=new pg.Pool({connectionString:fixture.pool.options.connectionString,max:6,
    options:'-c role=learning_api'});
  reuseLearningQueryPlans(pool);
  const submitContext=new AsyncLocalStorage();
  let submittedAt;
  pool.on('connect',client=>{
    const query=client.query.bind(client);
    client.query=async (sql,...args)=>{
      const result=await query(sql,...args);
      if(sql==='COMMIT'&&submitContext.getStore())submittedAt=performance.now();
      return result;
    };
  });
  let browser,server,router;
  try {
    const {published,assignment,inputs,itemId}=await publishedFixture(fixture);
    for(const name of ['202610010001_progress_log_form_drafts','202610220002_form_library',
      '202610280001_form_publications','202610300001_worksheet_revisions']){
      await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/'+name+'.sql',import.meta.url),'utf8'));
    }
    await fixture.pool.query(migration);
    const app=express();
    app.use(express.json());
    const accept=(_req,res,next)=>{if(!authorized)return res.status(401).json({ok:false,message:'Phiên thử đã hết hạn.'});next();};
    let authorized=true,revisionPolls=0;
    const readEvents=[];
    app.use((req,res,next)=>{
      if(req.path.endsWith('/live-updates'))revisionPolls++;
      if(req.path.endsWith('/attempts/submit'))return submitContext.run(true,next);
      next();
    });
    app.get('/api/auth/session',accept,(_req,res)=>res.json({ok:true,reviewer}));
    router=createLearningRouter({pool,authenticate:(req,res,next)=>accept(req,res,()=>{
      req.reviewer=reviewer;next();
    }),revalidate:async()=>authorized?reviewer:null,realtimeEnabled:true,realtimeStreamEnabled:stream,
    logger:{info:line=>readEvents.push(JSON.parse(line))}});
    app.use('/api/learning',router);
    app.get('/progress-log/config.js',(_req,res)=>res.type('js').send('window.PROGRESS_LOG_CONFIG={API_BASE_URL:location.origin};'));
    app.use(express.static(pages));
    server=await new Promise(done=>{const listener=app.listen(0,'127.0.0.1',()=>done(listener));});
    const origin='http://127.0.0.1:'+server.address().port;
    if(stream){
      const open=async source=>fetch(origin+'/api/learning/assignments/open',{
        method:'POST',headers:{'content-type':'application/json',origin:source},
        body:JSON.stringify({publicToken:published.publicToken})
      });
      const pagesOrigin='https://tranhoangduc90.github.io';
      const first=await open(pagesOrigin);
      assert.equal(first.status,200);
      assert.equal(first.headers.get('timing-allow-origin'),pagesOrigin);
      const id=first.headers.get('server-timing').match(/progress_request;desc="([a-f0-9-]+)"/)?.[1];
      assert.ok(id);
      const event=readEvents.find(event=>event.correlation===id);
      assert.equal(event?.operation,'assignment_open');
      assert.equal(event?.definitionCache,'miss');
      assert.ok(!JSON.stringify(event).includes(published.publicToken));
      const cached=await open('https://other.invalid');
      assert.equal(cached.status,200);
      assert.equal(cached.headers.get('timing-allow-origin'),null);
      assert.equal(cached.headers.get('server-timing'),null);
      assert.equal(readEvents.filter(event=>event.operation==='assignment_open').at(-1).definitionCache,'hit');
    }
    browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext();
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    const errors=[];
    async function openTeacherTab(pollOnly=false){
      const tab=await context.newPage();
      if(pollOnly)await tab.addInitScript(()=>{window.EventSource=undefined;});
      tab.on('pageerror',error=>errors.push(error.message));
      await tab.goto(origin+'/progress-log/teacher-thuy.html#assignment='+published.publicToken);
      await tab.locator('.thuy-roster tbody tr').first().waitFor();
      await tab.locator('[data-thuy-mode="results"]').click();
      await tab.getByRole('button',{name:'Xem câu trả lời',exact:true}).click();
      await tab.getByText('Chưa có bài nộp cho câu này.',{exact:true}).waitFor();
      return tab;
    }
    const page=await openTeacherTab();
    const jsonPost=async (path,body,method='POST',status=200)=>{
      const response=await fetch(origin+'/api/learning'+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const payload=await response.json();
      assert.equal(response.status,status,JSON.stringify(payload));
      return payload;
    };
    if(mixedPilot){
      const pollingPage=await openTeacherTab(true);
      await runMixedPilot({fixture,published,assignment,inputs,itemId,page,pollingPage,jsonPost,
        getLastCommit:()=>submittedAt,getPolls:()=>revisionPolls});
      assert.deepEqual(errors,[]);
      return;
    }
    const {attemptToken,definitionHash}=inputs[0];
    await jsonPost('/attempts/draft',{attemptToken,definitionHash,revision:1,
      responses:{[itemId]:'Nháp thử chưa nộp'}},'PATCH');
    if(!stream){
      const afterDraft=revisionPolls;
      await expectPolls(page,()=>revisionPolls,afterDraft+1);
    }
    assert.equal(await page.locator('.thuy-responses-table tbody tr').count(),0);
    const latencies=[];
    for(const [index,input] of inputs.entries()){
      const responseText='Bài kiểm commit số '+(index+1);
      submittedAt=undefined;
      await jsonPost('/attempts/submit',{...input,draftRevision:index===0?1:0,responses:{[itemId]:responseText}});
      assert.ok(submittedAt);
      const row=page.locator('.thuy-responses-table tbody').getByText(responseText,{exact:true});
      await row.waitFor({timeout:stream?5000:11000});
      latencies.push(Math.round(performance.now()-submittedAt));
      assert.equal(await page.locator('.thuy-responses-table tbody tr').count(),index+1);
      assert.match(await page.locator('#questionAnalytics .thuy-analytics-heading').innerText(),
        new RegExp((index+1)+'/5 học viên có bài nộp'));
    }
    const table=page.locator('.thuy-responses-table');
    await table.evaluate(el=>{
      window.startTable=el;el.focus();
      const selection=document.getSelection(),range=document.createRange();
      range.selectNodeContents(el.querySelector('.thuy-response-value'));
      selection.removeAllRanges();selection.addRange(range);
    });
    // Use the real fallback tick or the equivalent three full reads while SSE remains open.
    if(stream){
      for(let i=0;i<3;i++){
        const before=revisionPolls;
        await page.locator('#refreshDashboardButton').evaluate(el=>el.click());
        await expectPolls(page,()=>revisionPolls,before+1);
      }
    }else await expectPolls(page,()=>revisionPolls,revisionPolls+3);
    assert.equal(await table.evaluate(el=>el===window.startTable&&el===document.activeElement&&!document.getSelection().isCollapsed),true);
    authorized=false;
    await page.locator('#refreshDashboardButton').evaluate(el=>el.click());
    await table.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);
    assert.equal(await fixture.pool.query('SELECT count(*)::int n FROM learning.submission').then(r=>r.rows[0].n),5);
    const p95=Math.max(...latencies);
    assert.ok(p95<=(stream?3000:10000),JSON.stringify(latencies));
    console.log(JSON.stringify({transport:stream?'sse':'poll',commitAcknowledgedToBrowserMs:latencies,p95}));
  } finally {
    await browser?.close();
    await router?.liveUpdates.close();
    if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}
    await pool.end();
    await fixture.close();
  }
});

async function runMixedPilot({fixture,published,assignment,inputs,itemId,page,pollingPage,jsonPost,getLastCommit,getPolls}){
  const results=tab=>tab.locator('.thuy-responses-table tbody tr');
  const block=assignment.definition.blocks[0];
  const count=inputs.length;
  const writes=inputs.map((input,index)=>({...input,draftRevision:1,responses:{[itemId]:'Nộp kiểm tải '+(index+1)}}));
  await Promise.all(writes.map(async input=>{
    const opened=await jsonPost('/assignments/open',{publicToken:published.publicToken});
    assert.equal(opened.assignment.assignmentId,published.assignmentId);
    await jsonPost('/attempts/draft',{attemptToken:input.attemptToken,definitionHash:input.definitionHash,
      revision:1,responses:input.responses},'PATCH');
    const {checkpointSubmission}=await jsonPost('/attempts/checkpoints/submit',{
      attemptToken:input.attemptToken,definitionHash:input.definitionHash,draftRevision:1,responses:input.responses,
      blockId:block.blockId,checkpoint:block.checkpoint,checkpointSubmissionId:randomUUID(),idempotencyKey:randomUUID()
    },'POST',201);
    assert.equal(checkpointSubmission.attendance.status,'self_confirmed');
  }));
  await expectPolls(pollingPage,getPolls,getPolls()+2);
  for(const tab of [page,pollingPage])assert.equal(await results(tab).count(),0);
  assert.equal(await fixture.pool.query('SELECT count(*)::int n FROM learning.submission').then(r=>r.rows[0].n),0);

  const jobTypes=['sync_portal_attendance'],workerId='pl-browser-pilot';
  const jobs=await claimLearningJobs({pool:fixture.pool,workerId,limit:count,leaseSeconds:90,jobTypes});
  assert.equal(jobs.length,count);
  assert.ok(jobs.every(job=>job.payload.schemaVersion==='LearningPortalAttendanceCheckpointJobV1'));
  const present=new Set();
  const handler=createLearningAttendanceSync({pool:fixture.pool,
    config:{learningAttendanceSyncUrl:'https://fixture.test/portal',learningAttendanceSyncSecret:'fixture-only',
      learningAttendanceSyncTimeoutMs:1000},
    fetchImpl:async(_url,options)=>{
      const request=JSON.parse(options.body);
      const {commit,expectedScheduleFingerprint,...identity}=request;
      const {entityKey,unitKey,operationKey,idempotencyKey,classId,studentId,sessionNumber,bindingRevision}=identity;
      assert.equal(classId,'2139');assert.equal(sessionNumber,assignment.sessionNumber);
      const targetSessionId='35817',scheduleFingerprint='pilot-schedule';
      if(commit){
        assert.equal(request.targetSessionId,targetSessionId);
        assert.equal(expectedScheduleFingerprint,scheduleFingerprint);
        assert.equal(present.has(studentId),false);
        present.add(studentId);
      }
      return {ok:true,status:200,async json(){return {ok:true,status:commit?'synced':present.has(studentId)?'already_present':'resolved',
        entityKey,unitKey,operationKey,idempotencyKey,classId,studentId,sessionNumber,bindingRevision:bindingRevision??null,
        targetSessionId,resolvedSessionId:targetSessionId,scheduleFingerprint,sessionDate:'2026-10-05'};}};
    }});
  for(const job of jobs)assert.equal((await processLearningJob({pool:fixture.pool,workerId,job,handler})).status,'complete');
  assert.equal(present.size,count);

  await Promise.all(writes.map(input=>jsonPost('/attempts/submit',input)));
  const committedAt=getLastCommit();
  assert.ok(committedAt);
  const expected=writes.map(input=>input.responses[itemId]).sort();
  const settled=await Promise.all([page,pollingPage].map(async tab=>{
    await tab.waitForFunction(n=>document.querySelectorAll('.thuy-responses-table tbody tr').length===n,count);
    const duration=Math.round(performance.now()-committedAt);
    assert.deepEqual((await results(tab).locator('.thuy-response-value').allTextContents()).sort(),expected);
    assert.match(await tab.locator('#questionAnalytics .thuy-analytics-heading').innerText(),new RegExp(count+'/'+count+' học viên có bài nộp'));
    return duration;
  }));
  assert.ok(settled[0]<=3000&&settled[1]<=10000,JSON.stringify(settled));
  assert.equal((await claimLearningJobs({pool:fixture.pool,workerId,limit:count,leaseSeconds:90,jobTypes})).length,0);
  const totals=(await fixture.pool.query(`SELECT
    (SELECT count(*)::int FROM learning.submission) AS submissions,
    (SELECT count(*)::int FROM learning.attendance_record) AS attendance,
    (SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS jobs`)).rows[0];
  assert.deepEqual(totals,{submissions:count,attendance:count,jobs:count});
  console.log(JSON.stringify({students:count,portalWrites:present.size,teacherTabs:2,lastCommitToAllRowsMs:{sse:settled[0],poll:settled[1]}}));
}

async function expectPolls(page,count,target){
  const expires=performance.now()+15000;
  while(count()<target&&performance.now()<expires)await page.waitForTimeout(100);
  assert.ok(count()>=target,'Đọc nền không tới mốc '+target);
}
