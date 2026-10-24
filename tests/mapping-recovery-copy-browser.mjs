import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const out=process.env.MAPPING_RECOVERY_EVIDENCE_DIR;assert(out,'Use an evidence directory outside the repository.');await fs.mkdir(out,{recursive:true});
const revision=process.env.MAPPING_RECOVERY_REVISION||null,publicBase=process.env.MAPPING_RECOVERY_PUBLIC_BASE||null;assert(!(revision&&publicBase));
const cache=new Map();
async function load(name){
 if(cache.has(name))return cache.get(name);let b;
 if(revision)b=execFileSync('git',['show',`${revision}:${name}`],{cwd:root,maxBuffer:3000000});
 else if(publicBase){const r=await fetch(new URL(name,publicBase));assert(r.ok);b=Buffer.from(await r.arrayBuffer());}
 else b=await fs.readFile(path.join(root,name));
 cache.set(name,b);return b;
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{try{const n=decodeURIComponent(new URL(req.url,'http://local').pathname).slice(1);assert(n&&!n.includes('..'));res.writeHead(200,{'content-type':types[path.extname(n)]||'application/octet-stream'}).end(await load(n));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(35689,'127.0.0.1',resolve));
const origin='http://127.0.0.1:35689',browser=await chromium.launch({channel:'chrome',headless:true}),records=[];
try{
 for(const [width,height]of [[1440,1000],[320,568]])for(const action of ['login','refresh','decision'])for(const mode of ['network','403','500','invalid-json',...(action==='decision'?['readback-network']:[])]){
  const ctx=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'}),p=await ctx.newPage();p.setDefaultTimeout(7000);
  const rows=[{id:'fixture-review-A',classId:'fixture-class-A',className:'IC9001',erpStudentId:'ERP-FIXTURE-A',erpStudentName:'Học viên giả A',classroomUserId:'account-A',classroomName:'Tài khoản giả A',classroomEmail:'a@example.test',confidence:.94,status:'pending_review',reason:'Chỉ dữ liệu giả.',candidates:[{userId:'account-A',fullName:'Tài khoản giả A',email:'a@example.test'},{userId:'account-other',fullName:'Tài khoản khác',email:'other@example.test'}]}];
  const calls=[],errors=[];let fault=action==='login',recovering=false,acked=false;
  p.on('pageerror',e=>errors.push(e.message));
  try{
   await ctx.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.hostname==='accounts.google.com')return route.fulfill({contentType:'text/javascript',body:"window.google={accounts:{id:{initialize(o){window.fixtureCredential=o.callback},renderButton(root){const b=document.createElement('button');b.textContent='Đăng nhập giả';b.onclick=()=>window.fixtureCredential({credential:'LOCAL_FIXTURE_ONLY'});root.append(b)}}}};"});
    if(u.pathname.startsWith('/mapping-api/')){
     assert.equal(u.hostname,'ducizone.ddns.net');
     const body=req.method()==='POST'?req.postDataJSON():null;
     calls.push({method:req.method(),path:u.pathname,query:u.search,body,hasAuth:!!req.headers().authorization});
     if(body&&fault&&!recovering&&(mode==='network'||mode==='readback-network')){rows[0].status='approved';rows[0].classroomUserId=body.classroomUserId;rows[0].classroomName='Tài khoản khác';rows[0].classroomEmail='other@example.test';}
     if(fault&&!recovering){
      if(mode==='network'||mode==='readback-network'&&acked)return route.abort();
      if(mode==='403'||mode==='500')return route.fulfill({status:Number(mode),json:{ok:false,message:'Phản hồi lỗi giả '+mode+'.'}});
      if(mode==='invalid-json')return route.fulfill({contentType:'application/json',body:'broken'});
     }
     if(body){acked=true;return route.fulfill({json:{ok:true}});}
     return route.fulfill({json:{ok:true,items:rows,reviewer:{displayName:'Giảng viên giả'}}});
    }
    if(u.origin===origin)return route.continue();return route.abort();
   });
   await p.goto(origin+'/index.html');await p.getByRole('button',{name:'Đăng nhập giả'}).click();
   if(action!=='login'){
    await p.locator('#notice.success').waitFor();fault=true;
    if(action==='refresh')await p.locator('#refreshButton').click();
    else {await p.locator('[data-decision=choose_another]').first().click();await p.selectOption('#alternateAccountSelect','account-other');await p.fill('#decisionNote','Ghi chú giả giữ đúng phiếu A');await p.locator('#confirmDecisionButton').click();}
   }
   const target=action==='decision'?p.locator('.m170-decision-feedback'):p.locator('#notice');
   if(action==='decision')await target.waitFor({state:'visible'});
   else await p.waitForFunction(()=>document.querySelector('#notice').dataset.state!=='success'&&/Không thể|Chưa/.test(document.querySelector('#notice').textContent));
   await p.evaluate(()=>document.fonts.ready);
   const unknown=mode==='network'||mode==='readback-network';
   const ui=await p.evaluate(()=>({notice:document.querySelector('#notice').textContent,kind:document.querySelector('#notice').dataset.state,feedback:document.querySelector('.m170-decision-feedback')?.textContent||'',feedbackKind:document.querySelector('.m170-decision-feedback')?.getAttribute('data-state')||null,dialogOpen:document.querySelector('#decisionDialog').open,note:document.querySelector('#decisionNote').value,selected:document.querySelector('#alternateAccountSelect').value,disabled:document.querySelector('#confirmDecisionButton').disabled,table:document.querySelector('#reviewTableBody').textContent,counts:['pendingCount','highConfidenceCount','approvedCount','resultCount'].map(id=>document.getElementById(id).textContent),badge:document.querySelector('#modeBadge').textContent,title:document.querySelector('#accessTitle').textContent}));
   const posts=calls.filter(x=>x.method==='POST');assert.equal(posts.length,action==='decision'?1:0);assert(calls.every(x=>x.hasAuth));
   if(action==='decision'){assert(ui.dialogOpen&&!ui.disabled);assert.equal(ui.note,'Ghi chú giả giữ đúng phiếu A');assert.equal(ui.selected,'account-other');assert.deepEqual(posts[0].body,{reviewId:'fixture-review-A',decision:'choose_another',classroomUserId:'account-other',note:'Ghi chú giả giữ đúng phiếu A'});assert.equal(await p.locator('#notice').getAttribute('data-state')==='success',false);}
   if(action==='refresh'){assert.match(ui.notice,/bản tải trước/);assert.equal(await p.locator('#reviewTableBody tr').count(),1);}
   const expected=action==='decision'?'Chưa xác nhận được quyết định vì mất kết nối. Ghi chú vẫn được giữ trong cửa sổ này.':'Chưa kết nối được với hệ thống. Hãy kiểm tra mạng rồi thử lại.';
   await target.scrollIntoViewIfNeeded();
   const geometry=await target.evaluate(e=>{const b=e.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2),s=getComputedStyle(e);return{top:b.top,bottom:b.bottom,height:innerHeight,uncovered:!!hit&&(hit===e||e.contains(hit)),bg:s.backgroundColor,fg:s.color,overflow:document.documentElement.scrollWidth>innerWidth};});
   assert(geometry.top>=0&&geometry.bottom<=height&&geometry.uncovered&&!geometry.overflow);
   const copyOk=!unknown||(ui.notice.includes(expected)&&ui.kind==='attention'&&(action!=='decision'||ui.feedbackKind==='attention')&&geometry.bg==='rgb(255, 244, 224)'&&geometry.fg==='rgb(138, 83, 0)');
   await target.screenshot({path:path.join(out,`${action}-${mode}-${width}-notice.png`)});
   const beforeCalls=structuredClone(calls);recovering=true;
   if(action==='decision'){await p.keyboard.press('Escape');await p.locator('#decisionDialog').waitFor({state:'hidden'});await p.locator('#refreshButton').click();}
   else await p.locator(action==='login'?'#googleSignInButton button':'#refreshButton').click();
   await p.locator('#notice.success').waitFor();assert.equal(calls.filter(x=>x.method==='POST').length,action==='decision'?1:0);
   if(action==='decision'&&unknown){await p.selectOption('#statusFilter','all');await p.waitForFunction(()=>document.querySelector('#reviewTableBody').textContent.includes('Đã duyệt'));}
   const recovered=await p.locator('#reviewTableBody').innerText();if(action==='decision'&&unknown)assert.match(recovered,/Đã duyệt/);
   assert.deepEqual(errors,[]);records.push({action,mode,width,height,passed:copyOk,copyOk,unknown,ui,geometry,calls:beforeCalls,recoveryCalls:calls,recovered,errors});
  }catch(e){records.push({action,mode,width,height,passed:false,error:e.message});}
  finally{await ctx.close();}
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
const d={outcome:records.every(x=>x.passed)?'passed':'failed',records,revision,publicBase,sourceHashes:[...cache].map(([name,b])=>({name,sha256:crypto.createHash('sha256').update(b).digest('hex')})),testSha256:crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),externalWrites:0,scope:'Actual frontend; Google/API synthetic. Lost ACK fixture commits server state before abort; explicit close/refresh reads it back, no automatic or repeated POST. No real ERP/Classroom/DB write.'};
await fs.writeFile(path.join(out,'results.json'),JSON.stringify(d,null,2));console.log(JSON.stringify({outcome:d.outcome,cases:records.length,copyFailures:records.filter(x=>x.copyOk===false).length,errors:records.filter(x=>x.error)}));if(d.outcome!=='passed')process.exitCode=1;
