// Kiểm chín trang Pages thật sau phát hành: cấu hình, CSP, tài nguyên, console,
// và GET roster qua backend mới. Không chọn học viên, đăng nhập hay tạo lượt thi.
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire('file:///C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const base='https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/';
const api='https://ducizone.ddns.net:18869/term-mini-k67-api';
const output='E:/Codex-Data/k67-backend-separation-20261006/pages-live';
const routes=['','teacher/','term-test-1/','term-test-2/','mini-test-lesson-5/',
  'term-test-1-computer-based/','term-test-2-computer-based/','mini-test-lesson-5-computer-based/','term-test-1-listening-retake/'];
const result={outcome:'unknown',observedAt:new Date().toISOString(),routes:[],googleDiagnostics:[]};
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  for(const route of routes){
    const context=await browser.newContext({viewport:{width:1360,height:860}});const page=await context.newPage();
    const errors=[],failures=[];const consoleErrors=[],anonymousAuth=[];
    page.on('response',r=>{
      if(r.status()===401&&[api+'/api/auth/session',api+'/api/auth/me'].includes(r.url()))anonymousAuth.push(r.url());
    });
    page.on('pageerror',e=>errors.push(e.name+':'+e.message));
    page.on('requestfailed',r=>failures.push({url:r.url().split('?')[0],error:r.failure()?.errorText}));
    page.on('console',m=>{if(m.type()==='error')consoleErrors.push({text:m.text(),url:m.location().url});});
    const response=await page.goto(base+route+'?class=CODEXDEMO806',{waitUntil:'domcontentloaded',timeout:45000});
    assert.equal(response.status(),200);
    // Chụp cấu trúc trang đã tải trước khi đọc trạng thái JavaScript trên trang.
    const snapshot=await page.content();
    await writeFile(output+'/'+(route.replaceAll('/','-')||'landing')+'.html',snapshot,'utf8');
    await page.waitForFunction(()=>window.TERM_TEST_APP_CONFIG?.API_BASE_URL,{timeout:15000});
    const state=await page.evaluate(async()=>{
      const config=window.TERM_TEST_APP_CONFIG;
      const csp=document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content;
      const response=await fetch(config.API_BASE_URL+'/api/term-tests/roster?class=CODEXDEMO806&test=term-test-1');
      const roster=await response.json();
      return {api:config.API_BASE_URL,auth:config.AUTH_MODE,csp,rosterHttp:response.status,rosterOk:roster.ok,
        students:roster.students?.length,title:document.title};
    });
    assert.equal(state.api,api);assert.equal(state.auth,'google');assert.match(state.csp,/https:\/\/ducizone\.ddns\.net:18869/);
    assert.equal(state.rosterHttp,200);assert.equal(state.rosterOk,true);
    assert.equal(errors.length,0,JSON.stringify(errors));
    const ownFailures=failures.filter(r=>!r.url.startsWith('https://accounts.google.com/'));
    assert.equal(ownFailures.length,0,JSON.stringify(ownFailures));
    // Phiên trình duyệt sạch chưa đăng nhập: 401 ở đúng endpoint auth là kết quả dự kiến.
    const ownConsole=consoleErrors.filter(r=>!r.url.startsWith('https://accounts.google.com/')
      &&!(anonymousAuth.includes(r.url)&&r.text==='Failed to load resource: the server responded with a status of 401 (Unauthorized)'));
    assert.equal(ownConsole.length,0,JSON.stringify(ownConsole));
    result.googleDiagnostics.push(...failures.filter(r=>r.url.startsWith('https://accounts.google.com/')),
      ...consoleErrors.filter(r=>r.url.startsWith('https://accounts.google.com/')));
    await page.screenshot({path:output+'/'+(route.replaceAll('/','-')||'landing')+'.png',fullPage:true});
    result.routes.push({route,...state,anonymousAuth,pageErrors:errors.length,ownNetworkFailures:ownFailures.length,ownConsoleErrors:ownConsole.length});
    await context.close();
  }
  result.outcome='success';
}catch(error){result.outcome='failure';result.error=error.name+':'+error.message;process.exitCode=1;}
finally{await browser.close();}
const receipt=output+'/verification-'+randomUUID()+'.json';await writeFile(receipt,JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify({outcome:result.outcome,routes:result.routes.length,googleDiagnostics:result.googleDiagnostics.length,error:result.error??null,receipt}));
