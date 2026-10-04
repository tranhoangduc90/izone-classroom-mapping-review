// Nhận app/CSS nguyên bản, UUID bài giả và bridge đã được chủ bài giả cấp.
// Chrome gửi start/draft qua bridge; roster/result là vỏ giả, mọi đích khác bị chặn.
// Mỗi bước đối chiếu bài nhìn thấy với SQL; lỗi giữ receipt thất bại, không tạo outcome production.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {createServer} = require('node:http');
const {createHash,randomInt} = require('node:crypto');
const {createRequire} = require('node:module');
const path = require('node:path');
const {chromium} = createRequire('C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pair = value => ({task1:value.task1,task2:value.task2});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validatePayload(payload,identity) {
  assert.ok(uuid.test(identity.attempt_id),'UUID fixture không hợp lệ');
  assert.equal(payload.attemptToken,identity.attempt_id,'Request ngoài UUID fixture');
  assert.ok(['start','draft'].includes(payload.action),'Cấm submit/result/writer');
  assert.equal(typeof payload.task1,'string'); assert.equal(typeof payload.task2,'string');
  if(payload.action==='draft') assert.ok(Number.isSafeInteger(payload.baseRevision)&&payload.baseRevision>=0);
}

// Nhận trạng thái cuối và bridge sở hữu bài giả; luôn lưu lỗi trước khi ném ra ngoài.
// Pending/cleanup sai giữ unknown, không báo đạt; server thử luôn được đóng.
async function finalizeReceipt({receipt,bridge,identity,scope,pending,server,evidenceDir,errors,contextsClosed=true}) {
  let failure=null;
  receipt.pending_http=pending;receipt.contexts_closed=contextsClosed;
  try {
    assert.equal(contextsClosed,true,'Chrome chưa đóng chắc chắn, giữ fixture để đối soát');
    assert.ok(Number.isSafeInteger(pending)&&pending===0,'HTTP chưa dừng, không được cleanup');
    assert.equal(typeof bridge.cleanup,'function','Thiếu primitive cleanup của chủ bài giả');
    const cleanup=await bridge.cleanup();receipt.cleanup=cleanup;
    assert.equal(cleanup.status,'passed');
    if(scope==='production_fixture')assert.deepEqual(cleanup.destination,bridge.binding.destination);
    assert.equal(cleanup.attempt_id,identity.attempt_id);assert.equal(cleanup.marker,identity.marker);
    assert.deepEqual(cleanup.remaining,{attempt:0,marker:0,children:[0,0,0,0,0]});
  } catch(error) {
    failure=error;receipt.status='unknown';
    receipt.cleanup_error={name:error.name,message:error.message};
    if(!receipt.cleanup)receipt.cleanup={status:'unknown',reason:'cleanup_not_verified'};
  } finally {
    try {if(server){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}}
    catch(error){failure=failure||error;receipt.status='unknown';receipt.server_close_error={name:error.name,message:error.message};}
    receipt.finished_at=new Date().toISOString();receipt.errors=errors;
    receipt.artifacts=Object.fromEntries(await Promise.all((await fs.readdir(evidenceDir)).filter(x=>/\.(png|zip)$/.test(x)).map(async file=>[file,hash(await fs.readFile(path.join(evidenceDir,file)))])));
    await fs.writeFile(path.join(evidenceDir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n','utf8');
  }
  if(failure)throw failure;
  return receipt;
}

// Đóng từng context/browser có hạn chờ; lỗi vẫn phải ghi receipt cuối.
// Timeout chỉ giữ unknown, không chứng minh process đã dừng hoặc cho cleanup.
async function closeContexts(contexts,browser,evidenceDir,timeoutMs=10000) {
  const failures=[];
  async function bounded(operation,label) {
    let timer;
    try {
      await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timeout')),timeoutMs);})]);
    } catch(error) {failures.push({label,name:error.name,message:error.message});}
    finally {clearTimeout(timer);}
  }
  for(let i=0;i<contexts.length;i++) {
    await bounded(()=>contexts[i].tracing.stop({path:path.join(evidenceDir,'trace-'+i+'.zip')}),'trace '+i);
    await bounded(()=>contexts[i].close(),'context '+i);
  }
  if(browser)await bounded(()=>browser.close(),'browser');
  return {closed:failures.length===0,errors:failures};
}

// Windows có thể cấp cổng 4045/6000 bị Chrome chặn khi listen(0).
// Chọn dải động cao và thử cổng khác chỉ khi cổng đã bận; không hạ guard trình duyệt.
async function listenLoopback(server,choosePort=()=>randomInt(49152,65536)) {
  for(let attempt=0;attempt<16;attempt++) {
    const port=choosePort();assert.ok(Number.isInteger(port)&&port>=49152&&port<=65535);
    try {
      await new Promise((resolve,reject)=>{
        const error=value=>{server.off('listening',listening);reject(value);};
        const listening=()=>{server.off('error',error);resolve();};
        server.once('error',error);server.once('listening',listening);server.listen(port,'127.0.0.1');
      });
      return server.address().port;
    } catch(error) {if(error.code!=='EADDRINUSE')throw error;}
  }
  throw new Error('Không tìm được cổng localhost còn trống cho fixture Chrome');
}

// Đúng đề và đồng hồ SQL trước khi công nhận từng bước lưu bài.
// Mọi tên ngoài bốn giao diện đã nhận đều bị chặn.
function fixtureSpec(client) {
  const specs={shared:{slug:'term-test-1',minutes:40},
    'k56-shared':{slug:'term-test-1-k56',minutes:55},
    'k56-mini-shared':{slug:'mini-test-k56',minutes:15},
    'k56-test2-shared':{slug:'term-test-2-k56',minutes:30}};
  assert.ok(Object.hasOwn(specs,client),'Giao diện ngoài phạm vi');
  return specs[client];
}
function validateWritingClock(writing,minutes) {
  if(!writing.started) {
    assert.equal(writing.startedAt,null);assert.equal(writing.deadlineAt,null);return;
  }
  const epoch=value=>{
    assert.equal(typeof value,'string');assert.match(value,/(?:Z|[+-]\d{2}:\d{2})$/);
    const parsed=Date.parse(value);assert.ok(Number.isFinite(parsed));return parsed;
  };
  assert.equal(epoch(writing.deadlineAt)-epoch(writing.startedAt),minutes*60000,'Sai thời lượng Writing trong SQL');
}

async function runUiCanary({client,assets,identity,bridge,evidenceDir,scope}) {
  assert.ok(['shared','k56-shared','k56-mini-shared','k56-test2-shared'].includes(client));
  assert.ok(uuid.test(identity.attempt_id)&&uuid.test(identity.student_ref));
  assert.match(identity.marker,/^CODEX_D08_[a-f0-9]{32}_\d+$/);
  assert.ok(['offline_actual_sql','production_fixture'].includes(scope));
  if(scope==='production_fixture'){
    assert.equal(bridge.binding?.schema,'d08-ui-bridge/v1');
    assert.match(bridge.binding.run_id,/^[a-f0-9]{32}$/);
    assert.match(bridge.binding.ledger_sha256,/^[a-f0-9]{64}$/);
    assert.match(bridge.binding.bundle_revision,/^[a-f0-9]{64}$/);
    assert.match(bridge.binding.destination.image,/^sha256:[a-f0-9]{64}$/);
    assert.equal(typeof bridge.cleanup,'function');
    assert.ok(Number.isSafeInteger(identity.course_id)&&identity.course_id<0);
    assert.ok(Number.isSafeInteger(identity.student_id)&&identity.student_id<0);
    assert.notEqual(identity.course_id,identity.student_id);
  }
  await fs.mkdir(path.dirname(evidenceDir),{recursive:true});
  await fs.mkdir(evidenceDir,{recursive:false}); // Không ghi đè evidence của lần chạy cũ.
  const bytes=Object.fromEntries(await Promise.all(Object.entries(assets).map(async([key,file])=>[key,await fs.readFile(file)])));
  const assetHashes=Object.fromEntries(Object.entries(bytes).map(([key,value])=>[key,hash(value)]));
  const spec=fixtureSpec(client);
  const key=`izone-test:${spec.slug}:${identity.class_code}`;
  const events=[],errors=[],contexts=[]; let browser,server,base,pending=0,blocked=null,releaseBlocked=null;
  let receipt={schema:'d08-ui-canary/v1',scope,client,test_slug:spec.slug,writing_minutes:spec.minutes,identity,assetHashes,binding:bridge.binding||null,public_assets:bridge.publicAssets||{status:'not_run'},producer_source_sha256:hash(await fs.readFile(__filename)),started_at:new Date().toISOString(),status:'failed',cases:[],events};
  const save=async()=>fs.writeFile(path.join(evidenceDir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n','utf8');
  const read=async label=>{
    const value=await bridge.read();
    if(scope==='production_fixture'){assert.deepEqual(value.destination,bridge.binding.destination);assert.equal(value.course_id,identity.course_id);assert.equal(value.student_id,identity.student_id);assert.equal(value.ownership_checked,true);}
    assert.equal(value.attempt_id,identity.attempt_id); assert.equal(value.marker,identity.marker);
    assert.equal(value.test_slug,spec.slug,'Bài SQL thuộc sai đề');
    validateWritingClock(value.writing,spec.minutes);
    assert.ok(Number.isSafeInteger(value.writing.revision)&&value.writing.revision>=0);
    assert.equal(value.writing.submitted,false); assert.deepEqual(value.children,[0,0,0,0,0]);
    events.push({kind:'database_read',label,at:new Date().toISOString(),value}); await save(); return value;
  };
  const shell=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css"></head><body class="cbt-mode"><div id="app"></div><script src="/assets/config"></script><script>
  window.D08_ORIGINAL_API_BASE=window.TERM_TEST_APP_CONFIG.API_FOR_CLASS?window.TERM_TEST_APP_CONFIG.API_FOR_CLASS(new URLSearchParams(location.search).get('class')):window.TERM_TEST_APP_CONFIG.API_BASE_URL;
  window.TERM_TEST_APP_CONFIG={...window.TERM_TEST_APP_CONFIG,API_BASE_URL:location.origin+'/fixture-api',API_FOR_CLASS:()=>location.origin+'/fixture-api'};
  window.TERM_TEST_CONFIG={slug:${JSON.stringify(spec.slug)},title:'Kiểm bài giả D08',listening:{title:'Listening',description:[],controls:[]},reading:{title:'Reading',description:[],controls:[]}};
  window.TERM_TEST_CONTENT={variant:'semantic-html',deferResultsUntilComplete:true,timing:{writingMinutes:${spec.minutes}},writing:{tasks:[{id:'task1',label:'Task 1',prompt:'Đề giả 1',minimumWords:0},{id:'task2',label:'Task 2',prompt:'Đề giả 2',minimumWords:0}]}};
  </script><script src="/assets/examOrder"></script><script src="/assets/app"></script></body></html>`;
  // Phục hồi dựa SQL mới nhất; không gọi endpoint result thật có thể mang side effect.
  async function open(label,initial) {
    const context=await browser.newContext({viewport:{width:1280,height:900}}); contexts.push(context);
    await context.tracing.start({screenshots:true,snapshots:true,sources:false});
    const page=await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',route=>{if(route.request().url().startsWith(base+'/'))return route.continue();const url=new URL(route.request().url());errors.push('External request blocked: '+url.origin+url.pathname);return route.abort();});
    await page.addInitScript(({key,identity,initial})=>{
      if(!sessionStorage.getItem(key))sessionStorage.setItem(key,JSON.stringify({studentRef:identity.student_ref,studentName:'Học viên giả D08',attemptToken:identity.attempt_id,completed:true,listeningSubmitted:true,writingStarted:initial.started,writingSubmitted:false,writingDirty:false,writingRevision:0,writingServerRevision:initial.revision,writingConfirmedDraft:{task1:initial.task1,task2:initial.task2},writingLayout:{activeTask:'task1',splits:{}},drafts:{writing:{...initial,outline:'Outline local '+identity.marker}}}));
    },{key,identity,initial});
    await page.route(base+'/fixture-api{,/**}',async route=>{
      pending++;
      try {
        const url=new URL(route.request().url()),payload=route.request().postDataJSON();
        const fulfill=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
        if(url.pathname.endsWith('/roster'))return await fulfill({class:{code:identity.class_code,name:'Lớp giả D08'},students:[{ref:identity.student_ref,name:'Học viên giả D08'}]});
        if(url.pathname.endsWith('/result'))return await fulfill({ok:true,attemptToken:identity.attempt_id,completed:true,studentName:'Học viên giả D08',className:'Lớp giả D08',writing:(await read('outer_restore_'+label)).writing});
        if(url.pathname.endsWith('/client-event'))return await fulfill({ok:true});
        assert.equal(url.pathname,'/fixture-api/api/term-tests/writing');
        validatePayload(payload,identity);
        events.push({kind:'browser_dispatch',label,payload,at:new Date().toISOString()}); await save();
        if(blocked===label&&payload.action==='draft') {
          blocked=null;
          await new Promise(resolve=>{releaseBlocked=resolve;});
        }
        const response=await bridge.post(payload);
        events.push({kind:'api_response',label,payload,response,at:new Date().toISOString()}); await save();
        assert.equal(response.status,200); assert.equal(response.body.ok,true);
        return await fulfill(response.body);
      }catch(error){errors.push(error.message); await route.abort().catch(()=>{});}
      finally{pending--;}
    });
    await page.goto(base+'/fixture.html?class='+identity.class_code);
    const selected=await page.evaluate(()=>window.D08_ORIGINAL_API_BASE);
    if(scope==='production_fixture')assert.equal(selected,bridge.binding.destination.public_api_base);
    receipt.config_selected_api=selected;
    await page.locator(initial.started?'#writingView':'#writingPrepView').waitFor({state:'visible'});
    return {page,context,label};
  }
  const session=page=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'{}'),key);
  async function fill(page,value){
    const first=page.locator('[data-writing-task="task1"]');
    if(!await first.isVisible())await page.locator('#writingTaskTabs button').nth(0).click();
    await first.fill(value.task1);
    // Trang có tab Task riêng: chọn tab để thao tác textarea thật, không sửa state bằng evaluate.
    const second=page.locator('[data-writing-task="task2"]');
    if(!await second.isVisible())await page.locator('#writingTaskTabs button').nth(1).click();
    await second.fill(value.task2);
  }
  async function saved(page,expected){await page.waitForFunction(({key,expected})=>{const s=JSON.parse(sessionStorage.getItem(key)||'{}');return s.writingDirty===false&&s.drafts.writing.task1===expected.task1&&s.drafts.writing.task2===expected.task2;},{key,expected});}
  async function visiblePair(page,expected){const value=await session(page);assert.deepEqual(pair(value.drafts.writing),expected);assert.equal(await page.locator('[data-writing-task="task1"]').inputValue(),expected.task1);assert.equal(await page.locator('[data-writing-task="task2"]').inputValue(),expected.task2);return value;}
  try {
    server=createServer((req,res)=>{const part=req.url.split('?')[0];if(part==='/fixture.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(shell);}const asset=part.replace('/assets/','');if(bytes[asset]){res.writeHead(200,{'Content-Type':asset==='css'?'text/css':'text/javascript'});return res.end(bytes[asset]);}res.writeHead(404);res.end();});
    await listenLoopback(server); base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'});
    const initial=(await read('before')).writing; assert.equal(initial.revision,0); assert.deepEqual(pair(initial),{task1:'',task2:''});
    const first=await open('A',initial);
    await first.page.locator('#startWriting').click(); await first.page.locator('#writingView').waitFor({state:'visible'});
    const started=(await read('after_ui_start')).writing;assert.equal(started.started,true);assert.equal(started.revision,0);assert.deepEqual(pair(started),pair(initial));receipt.cases.push('ui_start_preserves_canonical');
    const second=await open('B',started);
    const local={task1:'Local A Task1 '+identity.marker,task2:'Local A Task2 '+identity.marker};
    const canonical={task1:'Canonical B Task1 '+identity.marker,task2:'Canonical B Task2 '+identity.marker};
    blocked='A'; await fill(first.page,local);
    for(let i=0;!releaseBlocked&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(releaseBlocked,'Không bắt được request A trước gửi');
    await fill(second.page,canonical);await saved(second.page,canonical);
    const winner=(await read('winner_before_stale_dispatch')).writing;assert.equal(winner.revision,1);assert.deepEqual(pair(winner),canonical);
    releaseBlocked();releaseBlocked=null;
    await first.page.locator('#writingConflict').waitFor({state:'visible'});
    let current=await visiblePair(first.page,local);assert.deepEqual(pair(current.writingConflict),canonical);assert.equal(current.writingConflict.revision,1);
    const draftA=events.find(x=>x.kind==='browser_dispatch'&&x.label==='A'&&x.payload.action==='draft');assert.equal(draftA.payload.baseRevision,0);
    assert.equal(events.find(x=>x.kind==='api_response'&&x.label==='A'&&x.payload.action==='draft').response.body.writing.accepted,false);
    assert.deepEqual(pair((await read('after_stale')).writing),canonical);receipt.cases.push('two_writer_stale_preserves_both_tasks');
    const count=events.filter(x=>x.kind==='browser_dispatch').length; await first.page.waitForTimeout(16000);assert.equal(events.filter(x=>x.kind==='browser_dispatch').length,count,'Conflict tự retry');receipt.cases.push('conflict_no_automatic_rebase');
    await first.page.reload();await first.page.locator('#writingConflict').waitFor({state:'visible'});current=await visiblePair(first.page,local);assert.deepEqual(pair(current.writingConflict),canonical);receipt.cases.push('reload_preserves_local_and_canonical');
    const previews=first.page.locator('#writingConflictDrafts textarea');
    const previewValues=await previews.evaluateAll(elements=>elements.map(element=>element.value));
    for(const value of [...Object.values(local),...Object.values(canonical)])assert.ok(previewValues.includes(value));
    assert.ok(await previews.evaluateAll(elements=>elements.every(element=>element.readOnly)));
    await first.page.screenshot({path:path.join(evidenceDir,'conflict.png'),fullPage:true});
    await first.page.locator('#writingKeepLocal').click();await saved(first.page,local);
    const kept=(await read('after_explicit_keep_local')).writing;assert.equal(kept.revision,2);assert.deepEqual(pair(kept),local);
    current=await visiblePair(first.page,local);assert.ok(current.writingRecovery.some(x=>JSON.stringify(pair(x))===JSON.stringify(local)));assert.ok(current.writingRecovery.some(x=>JSON.stringify(pair(x))===JSON.stringify(canonical)));
    const rebased=events.filter(x=>x.kind==='browser_dispatch'&&x.label==='A'&&x.payload.action==='draft')[1];assert.equal(rebased.payload.baseRevision,1);receipt.cases.push('explicit_keep_local_rebases_after_choice');
    // Tab B vẫn base1; sau lựa chọn A, lưu mới B phải conflict với canonical A revision2.
    const localB={task1:'Recovery B Task1 '+identity.marker,task2:'Recovery B Task2 '+identity.marker};
    await fill(second.page,localB);await second.page.locator('#writingConflict').waitFor({state:'visible'});
    await visiblePair(second.page,localB);const before=events.filter(x=>x.kind==='browser_dispatch').length;
    await second.page.locator('#writingUseServer').click();await saved(second.page,local);await second.page.waitForTimeout(16000);
    assert.equal(events.filter(x=>x.kind==='browser_dispatch').length,before);current=await visiblePair(second.page,local);
    assert.ok(current.writingRecovery.some(x=>JSON.stringify(pair(x))===JSON.stringify(localB)));assert.equal(current.writingServerRevision,2);
    const final=(await read('after_explicit_use_server')).writing;assert.deepEqual(pair(final),local);assert.equal(final.revision,2);receipt.cases.push('explicit_use_server_keeps_recovery_without_write');
    if(client!=='shared')assert.equal(current.drafts.writing.outline,'Outline local '+identity.marker);
    const recovery=second.page.locator('#writingRecovery');await recovery.waitFor({state:'visible'});await recovery.evaluate(element=>{element.open=true;});
    assert.ok((await second.page.locator('#writingRecoveryDrafts textarea').evaluateAll(elements=>elements.map(element=>element.value))).includes(localB.task1));
    assert.ok((await second.page.locator('#writingRecoveryDrafts textarea').evaluateAll(elements=>elements.map(element=>element.value))).includes(localB.task2));
    await second.page.screenshot({path:path.join(evidenceDir,'recovery.png'),fullPage:true});receipt.cases.push('visible_recovery_and_outline_preserved');
    assert.deepEqual(errors,[]);receipt.status='passed';receipt.final=final;
  }catch(error){receipt.error={name:error.name,message:error.message,stack:error.stack};throw error;}
  finally {
    if(releaseBlocked)releaseBlocked();
    const closing=await closeContexts(contexts,browser,evidenceDir);
    receipt.context_close_errors=closing.errors;
    for(let i=0;pending&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,50));
    await finalizeReceipt({receipt,bridge,identity,scope,pending,server,evidenceDir,errors,contextsClosed:closing.closed});
  }
  return receipt;
}
module.exports={runUiCanary,validatePayload,hash,finalizeReceipt,closeContexts,listenLoopback,fixtureSpec,validateWritingClock};
