// Actual Mapping UI, owned fake reviewer/records and fake HTTP decisions.
// Verify error visibility, drafts, focus and late-response context without external writes.
import fs from 'node:fs/promises';import http from 'node:http';import path from 'node:path';import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root=process.env.SOURCE_ROOT||fileURLToPath(new URL('../',import.meta.url)),out=process.env.MAPPING_FEEDBACK_EVIDENCE_DIR||path.join(root,'output/playwright/decision-feedback');
await fs.mkdir(out,{recursive:true});
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript; charset=utf-8','.woff2':'font/woff2','.png':'image/png'};
const server=http.createServer(async(q,r)=>{try{const pathname=new URL(q.url,'http://local').pathname;const p=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!p.startsWith(path.resolve(root)+path.sep))return r.writeHead(403).end();const data=await fs.readFile(p);r.writeHead(200,{'content-type':types[path.extname(p)]||'application/octet-stream'}).end(data);}catch{r.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true}),records=[];
const items=[0,1].map(i=>({id:'fixture-'+i,classId:'class-fixture',className:'IC9001',erpStudentId:'ERP-FIXTURE-'+i,erpStudentName:'Người thử riêng '+i,classroomUserId:'google-fixture-'+i,classroomName:'Tài khoản giả '+i,classroomEmail:'fake'+i+'@example.test',confidence:.94,status:'pending_review',reason:'Chỉ dữ liệu thử.',candidates:[{userId:'google-fixture-'+i,fullName:'Tài khoản giả '+i,email:'fake'+i+'@example.test'}]}));
try{for(const width of[1440,390,320]){
 const height=width===1440?1000:width===320?568:844;
 const ctx=await browser.newContext({viewport:{width,height}}),p=await ctx.newPage();p.setDefaultTimeout(6000);let mode='409',hold=null;const writes=[],errors=[];p.on('pageerror',e=>errors.push(e.message));
 await ctx.route('**/*',async route=>{const q=route.request(),u=new URL(q.url());
  if(u.hostname==='accounts.google.com')return route.fulfill({contentType:'text/javascript',body:"window.google={accounts:{id:{initialize(o){window.fixtureCredential=o.callback},renderButton(root){let b=document.createElement('button');b.textContent='Đăng nhập giả';b.onclick=()=>window.fixtureCredential({credential:'LOCAL_FIXTURE_ONLY'});root.append(b)}}}};"});
  if(u.pathname.startsWith('/mapping-api/')){
   if(q.method()!=='POST')return route.fulfill({json:{items,reviewer:{displayName:'GV thử'},ok:true}});
   writes.push(q.postDataJSON());if(hold){const pending=hold;hold=null;pending.started();await pending.wait;}
   if(mode==='network')return route.abort();return route.fulfill({status:mode==='success'?200:409,json:mode==='success'?{ok:true}:{message:'Phiếu đã đổi phiên bản thử'}});
  }
  if(u.origin!==origin)return route.abort();
  if(process.env.MAPPING_FEEDBACK_BEFORE_DIR&&u.pathname==='/app.js')return route.fulfill({contentType:'text/javascript; charset=utf-8',body:await fs.readFile(path.join(process.env.MAPPING_FEEDBACK_BEFORE_DIR,'app.js'))});
  return route.continue();
 });
 const check=async(name,fn)=>{try{await fn();records.push({width,height,case:name,outcome:'passed'});}catch(e){records.push({width,height,case:name,outcome:'failed',error:e.message});}};
 const open=async(id=0)=>{await p.locator(`[data-id="fixture-${id}"][data-decision=approve]`).click();await p.locator('#decisionDialog[open]').waitFor();};
 const inline=p.locator('#decisionDialog [role=alert]');
 const waitError=async()=>{await p.waitForFunction(()=>!document.querySelector('#confirmDecisionButton').disabled);await p.locator('#notice').filter({hasText:'Không thể ghi nhận'}).waitFor();};
 const holdNext=()=>{let release,started;const wait=new Promise(r=>release=r),ready=new Promise(r=>started=r);hold={wait,started};return{release,ready};};
 try{
  await p.goto(origin+'/');await p.getByRole('button',{name:'Đăng nhập giả'}).click();await p.locator('#reviewTableBody tr').first().waitFor();
  await open();await p.locator('#decisionNote').fill('Nháp giữ nguyên khi API trả409.');await p.locator('#confirmDecisionButton').click();await waitError();
  await check('conflict-visible-inside-dialog',async()=>{assert.equal(await inline.isVisible(),true);assert.match(await inline.innerText(),/Phiếu đã đổi phiên bản thử/);assert.equal(await p.locator('#decisionNote').inputValue(),'Nháp giữ nguyên khi API trả409.');assert.equal(writes[0].reviewId,'fixture-0');});
  await check('conflict-restores-confirm-focus',async()=>{await p.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));assert.equal(await p.locator('#confirmDecisionButton').evaluate(e=>e===document.activeElement),true);const r=await p.locator('#confirmDecisionButton').boundingBox();assert.ok(r.y>=0&&r.y+r.height<=height);});
  await p.locator('#decisionDialog').screenshot({path:out+'/conflict-'+width+'.png'});
  await p.locator('#closeDecisionButton').click();await open();
  await check('reopen-clears-stale-error',async()=>{assert.equal(await inline.isVisible(),false);assert.equal(await p.locator('#decisionNote').inputValue(),'');});
  mode='network';await p.locator('#decisionNote').fill('Nháp giữ khi mất phản hồi.');await p.locator('#confirmDecisionButton').click();await waitError();
  await check('network-error-keeps-draft-and-shows-inline',async()=>{assert.equal(await inline.isVisible(),true);assert.equal(await p.locator('#decisionNote').inputValue(),'Nháp giữ khi mất phản hồi.');assert.equal(writes.at(-1).reviewId,'fixture-0');assert.equal(await p.locator('#confirmDecisionButton').isDisabled(),false);});
  await p.locator('#closeDecisionButton').click();await open();mode='409';await p.locator('#decisionNote').fill('Nội dung đã gửi.');
  let pending=holdNext();try{await p.locator('#confirmDecisionButton').click();await Promise.race([pending.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Held POST not reached')),6000))]);await p.locator('#decisionNote').focus();await p.locator('#decisionNote').fill('Chữ vừa sửa sau khi request bắt đầu.');}finally{pending.release();}
  await waitError();await check('late-error-keeps-new-input-and-focus',async()=>{assert.equal(await inline.isVisible(),true);assert.equal(await p.locator('#decisionNote').inputValue(),'Chữ vừa sửa sau khi request bắt đầu.');assert.equal(await p.locator('#decisionNote').evaluate(e=>e===document.activeElement),true);assert.equal(writes.at(-1).note,'Nội dung đã gửi.');});
  await p.locator('#closeDecisionButton').click();await open();pending=holdNext();
  try{await p.locator('#confirmDecisionButton').click();await Promise.race([pending.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Held POST not reached')),6000))]);await p.locator('#closeDecisionButton').click();await open(1);await p.locator('#decisionNote').fill('Bản ghi khác không nhận lỗi cũ.');}finally{pending.release();}
  await waitError();await p.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));
  await check('late-error-is-not-attached-to-other-record',async()=>{assert.equal(await inline.isVisible(),false);assert.equal(await p.locator('#decisionNote').inputValue(),'Bản ghi khác không nhận lỗi cũ.');assert.match(await p.locator('#dialogSummary').innerText(),/Người thử riêng 1/);assert.equal(writes.at(-1).reviewId,'fixture-0');});
  assert.deepEqual(errors,[]);
 }finally{if(hold){hold.started();hold=null;}await ctx.unrouteAll({behavior:'wait'});await ctx.close();}
 console.log(JSON.stringify({width,checks:records.filter(r=>r.width===width).length}));
}}
finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.writeFile(out+'/results.json',JSON.stringify({outcome:records.some(r=>r.outcome==='failed')?'failed':'passed',records,externalWrites:0,scope:'Actual Mapping UI and API client with fake Google/reviewer/records/HTTP decisions. No real ERP/Google/database mutation.'},null,2));}
assert.equal(records.length,18);if(records.some(r=>r.outcome==='failed'))throw Error('Decision feedback regression failed; see per-case evidence.');
