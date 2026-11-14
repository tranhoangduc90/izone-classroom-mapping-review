import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import express from 'express';
import pg from 'pg';
import {createLearningRouter} from '../src/learning-routes.js';
import {reuseLearningQueryPlans} from '../src/learning-query-plans.js';
import {postgresFixture,publishedFixture} from './learning-postgres-fixture.js';

const pages=process.env.PAGES_SOURCE_ROOT;
assert.ok(pages,'Set PAGES_SOURCE_ROOT to the Pages worktree');
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||
  'C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');
const migration=await readFile(new URL('../ops/learning-migrations/202610230001_teacher_live_updates.sql',import.meta.url),'utf8');
const reviewer={email:'teacher@example.test',displayName:'Giảng viên mẫu',canAccessAllClasses:false};

for(const stream of [true,false])test('Bài nộp PostgreSQL đến Chrome qua '+(stream?'SSE':'đọc dự phòng'),{timeout:120000},async()=>{
  const fixture=await postgresFixture({asApplication:true,studentCount:5});
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
    const {published,inputs,itemId}=await publishedFixture(fixture);
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
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/progress-log/teacher-thuy.html#assignment='+published.publicToken);
    await page.locator('.thuy-roster tbody tr').first().waitFor();
    await page.locator('[data-thuy-mode="results"]').click();
    await page.getByRole('button',{name:'Xem câu trả lời',exact:true}).click();
    await page.getByText('Chưa có bài nộp cho câu này.',{exact:true}).waitFor();
    const jsonPost=async (path,body,method='POST')=>{
      const response=await fetch(origin+'/api/learning'+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const payload=await response.json();
      assert.equal(response.status,200,JSON.stringify(payload));
      return payload;
    };
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

async function expectPolls(page,count,target){
  const expires=performance.now()+15000;
  while(count()<target&&performance.now()<expires)await page.waitForTimeout(100);
  assert.ok(count()>=target,'Đọc nền không tới mốc '+target);
}
