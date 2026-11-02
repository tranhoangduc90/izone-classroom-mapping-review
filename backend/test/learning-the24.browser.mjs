import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startThe24Fixture} from './learning-the24-browser-fixture.mjs';
const {chromium}=createRequire('C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');

test('Thẻ 24 Chrome thật: hai thiết bị, SQL, riêng tư, lỗi/race và giao diện hai vai',{timeout:240000},async()=>{
  const fixture=await startThe24Fixture(),browser=await chromium.launch({channel:'chrome',headless:true});
  const output=process.env.THE24_EVIDENCE_DIR||'E:/Codex-Data/progress-the24-implementation-20261102/browser';await mkdir(output,{recursive:true});
  const errors=[],contexts=[],allPages=[],origin=fixture.origin;
  async function pageFor(){const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});contexts.push(context);
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-02T12:00:00Z');});
    const page=await context.newPage();allPages.push(page);page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));return page;}
  async function teacher(page){await page.goto(origin+'/progress-log/teacher.html#assignment='+fixture.uid(103));await page.getByRole('button',{name:'Kết quả',exact:true}).click();await page.getByRole('tab',{name:'Nhận xét cá nhân',exact:true}).click();await page.getByRole('row',{name:'Xem bài Học viên giả A',exact:true}).click();await page.locator('.session-comment-editor textarea:not([disabled])').waitFor();}
  const text=page=>page.locator('.session-comment-editor textarea');
  const status=page=>page.locator('.session-comment-editor .notice');
  const button=(page,name)=>page.locator('.session-comment-editor').getByRole('button',{name,exact:true});
  async function edit(page){await button(page,'Lựa chọn khác').click();await button(page,'Chỉnh sửa').click();}
  const target={classId:'1294',studentRef:fixture.A,sessionNumber:3,reviewer:fixture.reviewer};
  try{
    const a=await pageFor(),b=await pageFor();await teacher(a);
    assert.equal(await text(a).getAttribute('readonly'),'');assert.equal(await a.getByText('BẢN LƯU GẦN NHẤT',{exact:true}).isVisible(),false);
    assert.equal(await a.locator('#draftStatus').isVisible(),false);
    await edit(a);await text(a).fill('Nháp A lần một');await button(a,'Lưu nháp').click();await status(a).filter({hasText:'Đã lưu nháp vào tài khoản'}).waitFor();
    assert.match((await fixture.service.readComments('1294',fixture.A,{visibleOnly:true}))[0].noteText,/Nhận xét đã gửi trước/);
    await teacher(b);assert.equal(await text(b).inputValue(),'Nháp A lần một');
    await text(a).fill('Nháp A lần hai');await button(a,'Lưu nháp').click();await status(a).filter({hasText:'Đã lưu nháp vào tài khoản'}).waitFor();
    await text(b).fill('Bản B đã kiểm xung đột');await button(b,'Lưu nháp').click();await button(b,'Tải bản hiện hành, giữ nội dung đang gõ').waitFor();assert.equal(await text(b).inputValue(),'Bản B đã kiểm xung đột');
    await button(b,'Tải bản hiện hành, giữ nội dung đang gõ').click();await status(b).filter({hasText:'Đã đọc bản hiện hành'}).waitFor();
    await button(b,'Gửi cho học viên').click();await status(b).filter({hasText:'Đã gửi.'}).waitFor();
    assert.equal((await fixture.service.readComments('1294',fixture.A,{visibleOnly:true}))[0].noteText,'Bản B đã kiểm xung đột');
    await edit(b);await text(b).fill('Nháp sửa chưa được gửi');await button(b,'Lưu nháp').click();await status(b).filter({hasText:'Đã lưu nháp vào tài khoản'}).waitFor();
    assert.equal((await fixture.service.readComments('1294',fixture.A,{visibleOnly:true}))[0].noteText,'Bản B đã kiểm xung đột');
    await b.screenshot({path:resolve(output,'comment-private-draft.png'),fullPage:true});

    // Lỗi ghi không làm mất nội dung; mất response sau commit vẫn retry đúng một lần.
    let fail=true;
    await b.route('**/api/learning/teacher/session-comments/draft',route=>{if(fail){fail=false;return route.fulfill({status:503,json:{ok:false,message:'Lỗi lưu giả lập'}});}return route.continue();});
    await text(b).fill('Giữ chữ khi lỗi lưu');await button(b,'Lưu nháp').click();await status(b).filter({hasText:'Lỗi lưu giả lập'}).waitFor();assert.equal(await text(b).inputValue(),'Giữ chữ khi lỗi lưu');
    await button(b,'Lưu nháp').click();await status(b).filter({hasText:'Đã lưu nháp vào tài khoản'}).waitFor();
    let lose=true;await b.route('**/api/learning/teacher/session-comments/send',async route=>{if(lose){lose=false;await route.fetch();return route.abort('connectionfailed');}return route.continue();});
    await text(b).fill('Gửi một lần dù mất phản hồi');await button(b,'Gửi cho học viên').click();await status(b).filter({hasText:/fetch|phản hồi|Failed/u}).waitFor();
    const afterLost=await fixture.service.getSessionCommentEditor(target);await button(b,'Gửi cho học viên').click();await status(b).filter({hasText:'Đã gửi.'}).waitFor();
    assert.equal((await fixture.service.getSessionCommentEditor(target)).comment.revision,afterLost.comment.revision);
    await b.unroute('**/api/learning/teacher/session-comments/send');

    // Response đến sau khi chuyển người không đổi trình soạn của người đang xem.
    await edit(b);await text(b).fill('Nội dung gõ thêm trong lúc gửi');let sent;
    const dispatched=new Promise(done=>{sent=done;});
    await b.route('**/api/learning/teacher/session-comments/send',async route=>{const response=await route.fetch();sent();await new Promise(done=>setTimeout(done,600));await route.fulfill({response});});
    await button(b,'Gửi cho học viên').click();await dispatched;await b.getByRole('button',{name:'Học viên tiếp theo',exact:true}).click();
    await b.locator('#draftStudentName').filter({hasText:'Học viên giả B'}).waitFor();await b.locator('.session-comment-editor textarea:not([disabled])').waitFor();
    assert.equal(await text(b).inputValue(),'');await text(b).fill('Gửi thẳng cho B, không lưu nháp trước');await button(b,'Gửi cho học viên').click();await status(b).filter({hasText:'Đã gửi.'}).waitFor();
    assert.equal((await fixture.service.readComments('1294',fixture.B,{visibleOnly:true}))[0].noteText,'Gửi thẳng cho B, không lưu nháp trước');await b.unroute('**/api/learning/teacher/session-comments/send');

    // Cổng chọn lớp/tên đi thẳng vào tổng quan kể cả không ghi nhớ dài hạn.
    const student=await pageFor();await student.goto(origin+'/progress-log/student.html');await student.locator('#portalClass:not([disabled])').waitFor();await student.locator('#portalClass').selectOption('1294');
    await student.locator('#portalStudent:not([disabled])').waitFor();await student.locator('#portalStudent').selectOption(fixture.A);await student.getByLabel('Ghi nhớ em trên thiết bị này').uncheck();await student.getByRole('button',{name:'Tiếp tục',exact:true}).click();
    await student.locator('#journeyView:not([hidden])').waitFor();await student.locator('#thuyStudentSkills .thuy-four-skills>.card').first().waitFor();
    assert.equal(await student.locator('#journeyView h1').textContent(),'Progress log');assert.equal(await student.getByRole('button',{name:'Buổi học',exact:true}).count(),0);
    assert.equal(await student.locator('#studentUpcoming').getAttribute('data-session-number'),'6');assert.match(await student.locator('#studentUpcoming').innerText(),/Bấm vào đây để bắt đầu làm bài/);
    assert.equal(await student.locator('#journeySessions>.studentSessionCard').count(),12);
    assert.equal(await student.locator('#thuyStudentSkills').getByRole('button',{name:'Xem thêm',exact:true}).count(),1);
    assert.doesNotMatch(await student.locator('#thuyStudentSkills').innerText(),/Nháp sửa|Giữ chữ khi lỗi lưu/u);
    assert.doesNotMatch(await student.locator('#journeyView').innerText(),/buổi xác nhận trong Progress Log|lần tổng kết đã công bố/u);
    assert.equal(await student.evaluate(()=>JSON.parse(localStorage.getItem('izone:student-identity:v1')||'null')?.identity||null),null);
    await student.screenshot({path:resolve(output,'student-1440.png'),fullPage:true});
    await student.setViewportSize({width:1860,height:1000});assert.equal(await student.locator('#journeySessions').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),6);await student.screenshot({path:resolve(output,'student-1860.png'),fullPage:true});
    for(const [width,columns]of [[768,2],[390,1]]){await student.setViewportSize({width,height:1000});assert.equal(await student.locator('#journeySessions').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),columns);assert.equal(await student.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await student.screenshot({path:resolve(output,'student-'+width+'.png'),fullPage:true});}
    await student.setViewportSize({width:1440,height:1000});

    // Ba nhịp polling thật 30 giây; không tăng tốc đồng hồ hoặc tắt cập nhật nền.
    await student.locator('#thuyStudentSkills .thuy-four-skills>.card').first().evaluate(el=>{el.scrollIntoView({behavior:'instant',block:'start'});window.keptCard=el;window.keptGrid=document.querySelector('#journeySessions');window.keptHero=document.querySelector('#studentUpcoming').firstElementChild;window.readScroll=scrollY;const range=document.createRange();range.selectNodeContents(el.querySelector('h3'));getSelection().removeAllRanges();getSelection().addRange(range);});
    const start=fixture.calls.filter(c=>c.path==='/api/learning/student/session-comments').length;
    for(let i=1;i<=3;i++){
      await student.waitForResponse(r=>r.url().includes('/student/session-comments'),{timeout:35000});
      const kept=await student.evaluate(()=>({card:window.keptCard===document.querySelector('#thuyStudentSkills .thuy-four-skills>.card'),grid:window.keptGrid===document.querySelector('#journeySessions'),hero:window.keptHero===document.querySelector('#studentUpcoming').firstElementChild,scroll:scrollY-window.readScroll,selection:getSelection().toString()}));
      assert.deepEqual(kept,{card:true,grid:true,hero:true,scroll:0,selection:'Listening'});
    }
    assert.ok(fixture.calls.filter(c=>c.path==='/api/learning/student/session-comments').length>=start+3);

    await a.reload();await a.getByRole('button',{name:'Hành trình lớp',exact:true}).click();await a.locator('#courseOverview .thuy-skill-tabs').waitFor();
    assert.doesNotMatch(await a.locator('#overviewStatus').innerText(),/Có lịch cần đối chiếu/u);
    await a.locator('#courseOverview').getByRole('button',{name:'Writing',exact:true}).click();assert.deepEqual(await a.locator('#courseOverview th').allTextContents(),['Học viên','Term Test 1','Term Test 2']);
    await a.getByLabel('Sắp xếp kỹ năng').selectOption('test-high-2');assert.match(await a.locator('#courseOverview tbody tr').first().innerText(),/7/u);
    await a.locator('#courseOverview').getByRole('button',{name:'Học viên giả A',exact:true}).click();await a.locator('#journeyDetailContent .thuy-four-skills').waitFor();
    assert.equal(await a.locator('#journeyDetailContent .thuy-four-skills>.card').count(),4);
    const cols=await a.locator('#journeyDetailContent .thuy-four-skills').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);assert.equal(cols,2);
    await a.screenshot({path:resolve(output,'teacher-four-skills-1440.png'),fullPage:true});
    await a.setViewportSize({width:390,height:1000});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await a.screenshot({path:resolve(output,'teacher-four-skills-390.png'),fullPage:true});

    // Xóa chỉ gỡ bản đã gửi; giữ bản nháp của tài khoản khác và nhật ký.
    await b.getByRole('button',{name:'Học viên trước',exact:true}).click();await b.locator('.session-comment-editor textarea:not([disabled])').waitFor();
    await fixture.service.saveSessionCommentDraft({...target,reviewer:{...fixture.reviewer,email:'second@example.test'},noteText:'Nháp người khác còn nguyên',expectedRevision:(await fixture.service.getSessionCommentEditor(target)).comment.revision,expectedDraftRevision:0,operationId:crypto.randomUUID()});
    await button(b,'Lựa chọn khác').click();b.once('dialog',dialog=>dialog.accept());await button(b,'Xóa').click();await status(b).filter({hasText:'Đã xóa nhận xét đã gửi'}).waitFor();
    assert.deepEqual(await fixture.service.readComments('1294',fixture.A,{visibleOnly:true}),[]);assert.equal((await fixture.service.getSessionCommentEditor({...target,reviewer:{...fixture.reviewer,email:'second@example.test'}})).draft.noteText,'Nháp người khác còn nguyên');
    const counts=(await fixture.database.query(`SELECT (SELECT count(*) FROM learning.attempt)::int AS attempts,(SELECT count(*) FROM learning.submission)::int AS submissions,(SELECT count(*) FROM learning.attendance_event)::int AS events,(SELECT count(*) FROM learning.outbox_job)::int AS jobs`)).rows[0];assert.deepEqual(counts,{attempts:0,submissions:0,events:0,jobs:0});
    assert.deepEqual(errors,[]);
    await writeFile(resolve(output,'result.json'),JSON.stringify({status:'passed',browser:browser.version(),polls:3,counts,errors,nativeComments:true,academicResults:'isolated UI fixture'},null,2));
  }catch(error){const last=allPages.at(-1);if(last){await last.screenshot({path:resolve(output,'failure.png'),fullPage:true});console.error(JSON.stringify({url:last.url(),body:(await last.locator('body').innerText()).slice(0,2400),errors,calls:fixture.calls.slice(-7)}));}throw error;
  }finally{for(const c of contexts)await c.close();await browser.close();await fixture.close();}
});

test('Thẻ 24 bổ sung: replay đã cũ, menu/hủy xóa, ba nhịp giáo viên và ảnh mẫu',{timeout:90000},async()=>{
  const fixture=await startThe24Fixture(),browser=await chromium.launch({channel:'chrome',headless:true});
  const output=process.env.THE24_EVIDENCE_DIR||'E:/Codex-Data/progress-the24-implementation-20261102/browser';await mkdir(output,{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort());
  await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-02T12:00:00Z');});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const editor=page.locator('.session-comment-editor'),input=editor.locator('textarea'),button=name=>editor.getByRole('button',{name,exact:true});
  const target={classId:'1294',studentRef:fixture.A,sessionNumber:3,reviewer:fixture.reviewer};
  try{
    await page.goto(fixture.origin+'/progress-log/teacher.html#assignment='+fixture.uid(103));await page.getByRole('button',{name:'Kết quả',exact:true}).click();await page.getByRole('tab',{name:'Nhận xét cá nhân',exact:true}).click();await page.getByRole('row',{name:'Xem bài Học viên giả A',exact:true}).click();await editor.locator('textarea:not([disabled])').waitFor();
    await button('Lựa chọn khác').click();assert.deepEqual(await editor.locator('.comment-menu button').allTextContents(),['Chỉnh sửa','Xóa']);await page.keyboard.press('Escape');assert.equal(await button('Lựa chọn khác').getAttribute('aria-expanded'),'false');assert.equal(await button('Lựa chọn khác').evaluate(el=>el===document.activeElement),true);
    await button('Lựa chọn khác').click();await button('Chỉnh sửa').click();await input.fill('Bản gửi mất phản hồi vẫn được giữ');
    let lose=true;await page.route('**/api/learning/teacher/session-comments/send',async route=>{if(lose){lose=false;await route.fetch();return route.abort('connectionfailed');}return route.continue();});
    await button('Gửi cho học viên').click();await editor.locator('.notice').filter({hasText:/fetch|phản hồi|Failed/u}).waitFor();
    await fixture.service.saveSessionComment({...target,noteText:'Bản hiện hành đã được cập nhật sau đó',expectedRevision:2,operationId:crypto.randomUUID()});
    await button('Gửi cho học viên').click();await editor.locator('.notice').filter({hasText:'bản hiện hành đã thay đổi sau đó'}).waitFor();
    assert.equal(await input.inputValue(),'Bản gửi mất phản hồi vẫn được giữ');assert.equal((await fixture.service.getSessionCommentEditor(target)).comment.revision,3);
    await button('Lựa chọn khác').click();page.once('dialog',dialog=>dialog.dismiss());await button('Xóa').click();assert.equal((await fixture.service.getSessionCommentEditor(target)).comment.visibility,'visible');
    await input.fill('Nội dung đang đọc và gõ qua cập nhật nền');await input.focus();await input.evaluate(el=>{el.setSelectionRange(9,17);window.keptEditor=el;window.keptAnswer=document.querySelector('[data-live-answers]');});
    for(let i=0;i<3;i++){
      await page.waitForResponse(r=>r.url().includes('/teacher/live-drafts'),{timeout:12000});
      assert.deepEqual(await input.evaluate(el=>({same:el===window.keptEditor,answer:window.keptAnswer===document.querySelector('[data-live-answers]'),focus:el===document.activeElement,start:el.selectionStart,end:el.selectionEnd})),{same:true,answer:true,focus:true,start:9,end:17});
    }
    await page.screenshot({path:resolve(output,'teacher-comment-1440.png'),fullPage:true});
    await page.goto(fixture.origin+'/progress-log/student.html');await page.locator('#portalClass:not([disabled])').waitFor();await page.locator('#portalClass').selectOption('1294');await page.locator('#portalStudent:not([disabled])').waitFor();await page.locator('#portalStudent').selectOption(fixture.A);await page.getByRole('button',{name:'Tiếp tục',exact:true}).click();await page.locator('#journeyView:not([hidden])').waitFor();await page.locator('#thuyStudentSkills .thuy-four-skills>.card').first().waitFor();
    for(const [width,cols]of [[1860,6],[1440,4],[768,2],[390,1]]){
      await page.setViewportSize({width,height:1000});assert.equal(await page.locator('#journeySessions').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),cols);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.student-nav').isVisible(),false);await page.screenshot({path:resolve(output,'student-final-'+width+'.png'),fullPage:true});
    }
    fixture.setLesson6Complete(true);await page.reload();await page.locator('#journeyView:not([hidden])').waitFor();assert.match(await page.locator('#studentUpcoming').innerText(),/Xem bài đã nộp/u);assert.equal(await page.locator('#studentUpcoming .button').isEnabled(),true);
    assert.equal(fixture.calls.filter(c=>/\/attempts\/start|\/submissions/u.test(c.path)).length,0);
    await writeFile(resolve(output,'additional-result.json'),JSON.stringify({status:'passed',browser:browser.version(),teacherPolls:3,replayAdvanced:true,deleteCancelled:true,finalWidths:[1860,1440,768,390]},null,2));
  }finally{await context.close();await browser.close();await fixture.close();}
});
