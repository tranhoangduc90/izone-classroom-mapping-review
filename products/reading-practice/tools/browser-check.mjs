import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Kiểm luồng qua trình duyệt và API thật của Reading; chỉ nguồn identity/Google dùng fixture local.
const [playwrightRoot,contentPath,staticRoot,artifactDir,portArg='4390']=process.argv.slice(2);
if(!artifactDir)throw new Error('Usage: browser-check.mjs playwrightModuleDir privateContent frontendDir artifactDir [port]');
const require=createRequire(path.join(playwrightRoot,'package.json')),{chromium}=require('playwright');
const runDir=path.join(artifactDir,`browser-${Date.now()}`);await mkdir(runDir,{recursive:true});
const server=spawn(process.execPath,[new URL('./preview.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),contentPath,staticRoot,path.join(runDir,'data'),portArg],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='';server.stdout.on('data',x=>stdout+=x);server.stderr.on('data',x=>stderr+=x);
await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Preview did not start: '+stderr)),20000);const timer=setInterval(()=>{if(stdout.includes('reading_local_ready')){clearInterval(timer);clearTimeout(timeout);resolve();}},100);server.once('exit',()=>{clearInterval(timer);clearTimeout(timeout);reject(new Error('Preview exited: '+stderr));});});
const open=JSON.parse(await readFile(path.join(runDir,'data/open.json'),'utf8')),content=JSON.parse(await readFile(contentPath,'utf8'));
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1401,height:797}}),page=await context.newPage();
const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=(label,condition)=>{assert.ok(condition,label);checks.push({label,status:'passed'});};
const state=()=>page.evaluate(async()=>{const token=Object.keys(sessionStorage).find(k=>k.startsWith('reading-practice67-session:'));return fetch('/api/state',{headers:{Authorization:`Bearer ${sessionStorage.getItem(token)}`}}).then(r=>r.json());});
async function click(action){await page.locator(`[data-action="${action}"]`).first().click();}
async function route(hash){await page.waitForURL(url=>url.hash===hash,{timeout:10000});}
try{
 await page.goto(open.entryUrl);await page.locator('#class-select').selectOption('CHẠY THỬ 67');await page.locator('#student-select').selectOption(open.studentRef);await page.locator('#login-submit').click();await route('#prep');
 const before=await state();check('CTA/đăng nhập chưa sinh lượt',before.attempts.length===0);check('Trước start không có đề/key/lời giải',!before.definition&&!before.key&&!before.explanations);
 await page.screenshot({path:path.join(runDir,'01-prep.png'),fullPage:true});
 let loseStart=true;await page.route('**/api/begin',async route=>{if(!loseStart)return route.continue();loseStart=false;await route.fetch();await route.abort('failed');});
 await click('begin');await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Chưa kết nối'));
 check('Mất phản hồi start vẫn chỉ tạo một lượt', (await state()).attempts.length===1);await page.reload();await route('#resume');await click('resume');await route('#exercise');await page.locator('#answer-14').waitFor();
 check('Matching Headings dùng Nhấn để chọn',await page.locator('#answer-14 option').first().textContent()==='Nhấn để chọn');
 await page.locator('#answer-14').selectOption('iii');await click('notes');await page.locator('#notes').fill('Ghi chú riêng của lần 1');
 await click('notes');
 async function selectText(paragraph,start,end){await page.locator(`#paragraph-${paragraph} p`).evaluate((p,{start,end})=>{const node=p.firstChild,range=document.createRange();range.setStart(node,start);range.setEnd(node,end);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));},{start,end});}
 await selectText('A',0,18);await page.getByRole('button',{name:'Highlight',exact:true}).click();check('Chọn chữ tạo Highlight',await page.locator('mark.cbt-annotation-mark').count()===1);
 await selectText('B',0,18);await page.getByRole('button',{name:'Note',exact:true}).click();await page.locator('.cbt-note-editor').fill('Ghi chú gắn với trích dẫn');await page.locator('#linked-notes-panel .cbt-note-close').click();
 await page.screenshot({path:path.join(runDir,'02-exercise.png')});
 const recovery=await page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('reading-practice67-draft:'));const c=JSON.parse(localStorage.getItem(key));return {answers:c.snapshot.answers,notes:c.snapshot.notes,remainingMs:c.remainingMs};});
 await page.reload();await route('#resume');const resumedState=await state();check('Reload giữ lượt 1',resumedState.attempts.length===1);
 const shown=await page.locator('.remaining-big').textContent();await page.waitForTimeout(1500);check('Màn tiếp tục không trôi giờ',await page.locator('.remaining-big').textContent()===shown);
 await click('resume');await route('#exercise');check('Phục hồi đáp án',await page.locator('#answer-14').inputValue()==='iii');check('Phục hồi note',await page.locator('#notes').inputValue()==='Ghi chú riêng của lần 1');
 await page.waitForFunction(()=>document.querySelectorAll('mark.cbt-annotation-mark').length===2);const annotations=(await state()).attempts[0].annotations;check('Phục hồi Highlight và Note theo trích dẫn',annotations.length===2&&annotations.find(a=>a.kind==='note').note==='Ghi chú gắn với trích dẫn');
 const secondTab=await context.newPage();await secondTab.goto(open.entryUrl);await secondTab.locator('#login-submit').click();await secondTab.waitForURL(/#resume/);await secondTab.locator('[data-action="resume"]').click();await secondTab.waitForURL(/#exercise/);await route('#resume');check('Tab mới chuyển quyền, tab cũ khóa bài',await page.locator('#readingView').count()===0);await secondTab.close();await click('resume');await route('#exercise');
 await context.setOffline(true);await route('#resume');check('Mất mạng khóa đề',await page.locator('#readingView').count()===0);await context.setOffline(false);await click('resume');await route('#exercise');
 await page.waitForFunction(()=>document.querySelector('[data-action="request-submit"]')?.disabled===false);
 let activationMode='drop',resolveHeld,resolveDelivered,held,delivered;
 const holdNext=()=>{activationMode='hold';held=new Promise(resolve=>resolveHeld=resolve);delivered=new Promise(resolve=>resolveDelivered=resolve);};
 await page.route('**/api/activate',async route=>{const mode=activationMode;activationMode='continue';if(mode==='continue')return route.continue();const response=await route.fetch();if(mode==='drop')return route.abort('failed');resolveHeld();await new Promise(resolve=>setTimeout(resolve,2500));await route.fulfill({response});resolveDelivered();});
 await page.locator('.homework-options summary').click();await click('pause');await route('#resume');await page.evaluate(()=>document.querySelector('#toast').textContent='');await click('resume');await page.waitForFunction(()=>location.hash==='#resume'&&!document.querySelector('#readingView')&&document.querySelector('#toast')?.textContent.includes('Chưa kết nối'));
 check('Mất ACK kích hoạt khóa đề và không tạo thêm lượt',(await state()).attempts.length===1&&await page.locator('#readingView').count()===0);await click('check-network');await page.locator('[data-action="resume"]').waitFor();holdNext();await click('resume');await route('#exercise');await held;
 const timeDuringActivation=await page.locator('#timer strong').textContent();check('Đang chờ activation khóa Reset/Nộp',await page.locator('[data-action="request-reset"]').isDisabled()&&await page.locator('[data-action="request-submit"]').isDisabled());await page.locator('[data-action="request-reset"]').evaluate(button=>button.click());await page.waitForTimeout(1100);check('Reset bị khóa không làm đồng hồ đứng',await page.locator('#timer strong').textContent()!==timeDuringActivation&&(await state()).attempts.length===1);await delivered;await page.waitForFunction(()=>document.querySelector('[data-action="request-submit"]')?.disabled===false);
 await page.locator('.homework-options summary').click();await click('pause');await route('#resume');holdNext();await click('resume');await route('#exercise');await held;await page.locator('.homework-options summary').click();await click('pause');await route('#resume');await delivered;
 await page.waitForFunction(async()=>{const key=Object.keys(sessionStorage).find(k=>k.startsWith('reading-practice67-session:'));const value=await fetch('/api/state',{headers:{Authorization:`Bearer ${sessionStorage.getItem(key)}`}}).then(r=>r.json());return value.attempts.at(-1).status==='paused';});
 await page.evaluate(()=>location.hash='exercise');await route('#resume');check('Activation ACK tới muộn không mở lại đề/đồng hồ',await page.locator('#readingView').count()===0&&await page.evaluate(()=>window.ReadingInteractionBridge.current().status==='paused'));await click('resume');await route('#exercise');await page.waitForFunction(()=>document.querySelector('[data-action="request-submit"]')?.disabled===false);
 await page.locator('.homework-options summary').click();await click('request-reset');await page.locator('#modal [data-action="confirm-modal"]').click();await route('#exercise');
 await page.waitForFunction(()=>document.querySelector('.identity-options summary')?.textContent.includes('Lần 2'));
 const second=await state();check('Reset lượt2 đầy đủ20phút và không mang đáp án',second.attempts.length===2&&second.attempts[0].status==='reset'&&Object.keys(second.attempts[1].answers).length===0&&second.attempts[1].remainingMs>1195000&&second.attempts[1].annotations.length===0);
 await page.locator('#answer-14').selectOption('iii');await page.locator('#answer-15').selectOption('ii');
 await click('request-submit');await page.locator('#modal [data-action="confirm-modal"]').click();await page.waitForURL(/#result\?attempt=2/);
 check('Điểm từ máy chủ',await page.locator('.score-box strong').textContent()==='1/13');
 check('Chỉ một phần Đáp án và giải thích',await page.getByRole('heading',{name:'Đáp án và giải thích',exact:true}).count()===1);
 const colors=await page.locator('.detail-row').evaluateAll(rows=>rows.slice(0,3).map(r=>getComputedStyle(r.cells[0]).backgroundColor));
 check('Tô màu cả hàng đúng/sai/trống',JSON.stringify(colors)===JSON.stringify(['rgb(237, 248, 242)','rgb(255, 241, 243)','rgb(255, 248, 232)']));
 const buttons=page.locator('.explanation-button');check('13 nút giải thích rõ ràng',await buttons.count()===13);
 await buttons.first().click();check('Giải thích mở ngay dưới câu14',await page.locator('#explanation-14').isVisible());
 await page.screenshot({path:path.join(runDir,'03-results.png'),fullPage:true});
 for(let i=1;i<13;i++)await buttons.nth(i).click();
 const observed=await page.locator('.explanation-question [data-source-background],.explanation-question [data-source-foreground]').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,background:n.dataset.sourceBackground,foreground:n.dataset.sourceForeground})).filter(r=>r.background||r.foreground));
 const expected=[];const walk=value=>{if(Array.isArray(value))return value.forEach(walk);if(value&&typeof value==='object'){if(typeof value.text==='string'&&(value.background||value.foreground))expected.push({text:value.text.replace(/\n$/,''),background:value.background||'',foreground:value.foreground||''});for(const [k,v]of Object.entries(value))if(k!=='text')walk(v);}};
 walk(content.explanations.entries);const missing=expected.filter(run=>!observed.some(r=>r.text===run.text&&r.background===run.background&&r.foreground===run.foreground));await writeFile(path.join(runDir,'color-check.json'),JSON.stringify({expectedCount:expected.length,observedCount:observed.length,missing},null,2),'utf8');check('Toàn bộ màu nền/chữ nguồn được bảo toàn',expected.length>0&&missing.length===0&&observed.length===expected.length);
 const done=await state(),submission=done.attempts[1].submissionId;
 await page.evaluate(async()=>{const result=await fetch('/api/teacher/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:'LOCAL_TEST_CREDENTIAL'})}).then(r=>r.json());sessionStorage.setItem('reading-teacher-token',result.token);});
 await page.goto(`http://127.0.0.1:${portArg}/teacher.html#submission=${submission}`);await page.getByRole('heading',{name:'Lịch sử làm bài',exact:true}).waitFor();
 check('GV có lịch sử reset và kết quả',await page.locator('.history details').count()===1&&await page.locator('.history [data-action="teacher-result"]').count()===1);
 check('GV chỉ xem, không có reset/nộp',await page.locator('[data-action="request-reset"],[data-action="request-submit"]').count()===0);
 await page.screenshot({path:path.join(runDir,'04-teacher.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(runDir,'05-mobile-result.png'),fullPage:true});
 check('Mobile không tràn ngang',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 check('Không có lỗi JavaScript',errors.length===0);
 await writeFile(path.join(runDir,'results.json'),JSON.stringify({status:'passed',checks,errors,scope:'Local real Reading API + SQL; fixture roster and Google authentication; no production'},null,2),'utf8');
 console.log(JSON.stringify({status:'passed',checks:checks.length,artifactDir:runDir}));
}catch(error){await writeFile(path.join(runDir,'results.json'),JSON.stringify({status:'failed',checks,errors,error:error.message},null,2),'utf8');try{await page.screenshot({path:path.join(runDir,'failure.png'),fullPage:true,timeout:5000});}catch{}throw error;}
finally{await browser.close();server.kill('SIGINT');}
