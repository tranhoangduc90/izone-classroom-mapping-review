import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import express from 'express';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';

// Kiểm trình duyệt với API/SQL thật tại local; chỉ Google và học viên dùng dữ liệu giả, không gọi production.
const [playwrightRoot,pagesRoot,artifactDir,mode]=process.argv.slice(2);
const crossSite=mode?.startsWith('cross-site');
if(!artifactDir)throw new Error('Usage: teacher-session-browser-check.mjs playwrightRoot pagesRoot artifactDir');
const require=createRequire(path.join(playwrightRoot,'package.json')),{chromium}=require('playwright');
await mkdir(artifactDir,{recursive:true});
const state=await fixture();
// Fixture HTTP tối thiểu không có cấu trúc lời giải cho trình duyệt; bổ sung dữ liệu giả đầy đủ.
const paragraph={runs:[{text:'Fixture explanation'}]};
await state.pool.query('UPDATE listening_practice.content SET explanations=$1',[{entries:Object.fromEntries(
 Array.from({length:10},(_,i)=>[21+i,{number:21+i,answer:['A'],kind:'flowchart',prompt:paragraph,reason:[paragraph],evidence:[paragraph],paragraph:'Fixture'}]))}]);
const started=await state.begin();
const submitted=await state.service.submit({token:state.token,attemptId:started.attempts.at(-1).id,
 lease:started.lease,snapshot:state.draft(),method:'manual',operationId:uuid()});
const submissionId=submitted.attempts.at(-1).submissionId;
let origin;const origins=[];
const app=createApp({pool:state.pool,service:state.service,origins,googleClientId:'fixture-google-client',
 verifyGoogle:async()=>({email:'teacher@example.test',sub:'google-fixture',email_verified:true}),
 adminKey:secret(),teacherCookiePath:crossSite?'/listening-practice-api/api':'/api'});
let apiOrigin;
if(crossSite){
 app.get('/listening-practice/config.js',(req,res)=>res.type('text/javascript').send(`window.LISTENING_CONFIG={apiBase:'${apiOrigin}/listening-practice-api/api'};`));
}
app.use(express.static(pagesRoot));
const server=crossSite?createServer({key:await readFile(path.resolve(artifactDir,'../tls/key.pem')),
 cert:await readFile(path.resolve(artifactDir,'../tls/cert.pem'))},(req,res)=>{
 if(req.url.startsWith('/listening-practice-api/'))req.url=req.url.slice('/listening-practice-api'.length);app(req,res);
}):app;
const listening=crossSite?server.listen(0,'127.0.0.1'):app.listen(0,'127.0.0.1');
await new Promise(resolve=>listening.once('listening',resolve));
origin=`${crossSite?'https':'http'}://127.0.0.1:${listening.address().port}`;
origins.push(origin);
const pageOrigin=crossSite?`https://listening-pages.example.test:${listening.address().port}`:origin;
apiOrigin=crossSite?`https://listening-api.example.invalid:${listening.address().port}`:origin;
origins.push(pageOrigin);
const url=`${pageOrigin}/listening-practice/teacher.html#submission=${submissionId}`;
const browser=await chromium.launch({channel:'msedge',headless:true,args:crossSite?
 ['--host-resolver-rules=MAP listening-pages.example.test 127.0.0.1, MAP listening-api.example.invalid 127.0.0.1','--no-proxy-server']:[]}),checks=[],errors=[];
async function newContext(options={}){
 const context=await browser.newContext({ignoreHTTPSErrors:crossSite,viewport:mode?.includes('mobile')?{width:390,height:844}:{width:1440,height:1000},...options});
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 await context.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:`
 window.google={accounts:{id:{initialize(options){this.callback=options.callback;},
 renderButton(element){const button=document.createElement('button');button.textContent='Google kiểm thử';
 button.onclick=()=>this.callback({credential:'valid-google-fixture'});element.append(button);},disableAutoSelect(){}}}};
 `}));
 return context;
}
function check(name,condition){assert.ok(condition,name);checks.push(name);}
async function result(page){await page.getByRole('heading',{name:'Lịch sử làm bài',exact:true}).waitFor();}
try{
 const context=await newContext(),page=await context.newPage();
 await page.goto(url);await page.locator('#teacher-remember').waitFor();
 check('Ghi nhớ mặc định được chọn',await page.locator('#teacher-remember').isChecked());
 await page.getByRole('button',{name:'Google kiểm thử',exact:true}).click();await result(page);
 check('Không lưu token mới trong bộ nhớ JavaScript',await page.evaluate(()=>!sessionStorage.getItem('listening-teacher-token')));
 const next=await context.newPage();await next.goto(url);await result(next);
 check('Tab mới tự mở bản chỉ đọc',await next.locator('#google-signin').count()===0);
 await next.reload();await result(next);check('Tải lại giữ phiên',true);
 await next.screenshot({path:path.join(artifactDir,'teacher-restored.png'),fullPage:true});
 const saved=await context.storageState();
 await writeFile(path.join(artifactDir,'cookie-metadata.json'),JSON.stringify(saved.cookies.map(({name,domain,path,secure,httpOnly,sameSite,partitionKey,expires})=>({name,domain,path,secure,httpOnly,sameSite,partitionKey,expires})),null,2),'utf8');
 check('Cookie dài hạn không phải cookie theo phiên',saved.cookies.some(cookie=>cookie.name==='listening_teacher'&&cookie.httpOnly&&cookie.expires>Date.now()/1000+89*86400));
 if(crossSite)check('Cookie khác site có Secure, SameSite=None, phân vùng và đúng đường công khai',saved.cookies.some(cookie=>cookie.name==='listening_teacher'&&cookie.secure&&cookie.sameSite==='None'&&cookie.partitionKey&&cookie.path==='/listening-practice-api/api'));
 await context.close();
 const reopened=await newContext({storageState:saved}),restored=await reopened.newPage();
 await restored.goto(url);await result(restored);check('Mở lại bằng cookie đã lưu vẫn vào thẳng',true);
 const sibling=await reopened.newPage();await sibling.goto(url);await result(sibling);
 await restored.getByRole('button',{name:'Đăng xuất',exact:true}).click();
 await restored.locator('#teacher-remember').waitFor();await sibling.locator('#teacher-remember').waitFor();
 check('Đăng xuất xóa kết quả và trả cả hai tab về đăng nhập',await sibling.locator('.history').count()===0);
 await restored.locator('#teacher-remember').uncheck();
 await restored.getByRole('button',{name:'Google kiểm thử',exact:true}).click();await result(restored);
 check('Bỏ ghi nhớ tạo cookie theo phiên',(await reopened.cookies()).some(cookie=>cookie.name==='listening_teacher'&&cookie.expires===-1));
 state.setTeacher(false);await restored.reload();
 await restored.getByRole('button',{name:'Đăng xuất và đổi tài khoản',exact:true}).waitFor();
 check('Sai quyền lớp có cách đổi tài khoản, không bị kẹt',await restored.locator('.history').count()===0);
 await restored.getByRole('button',{name:'Đăng xuất và đổi tài khoản',exact:true}).click();
 await restored.locator('#teacher-remember').waitFor();state.setTeacher(true);
 await restored.getByRole('button',{name:'Google kiểm thử',exact:true}).click();await result(restored);
 check('Đổi tài khoản sau lỗi quyền mở lại được kết quả',true);
 await state.pool.query("UPDATE listening_practice.teacher_session SET expires_at=now()-interval '1 second'");
 await restored.reload();await restored.locator('#teacher-remember').waitFor();check('Hết hạn trở về đăng nhập, không mở kết quả cũ',await restored.locator('.history').count()===0);
 await reopened.close();check('Không có lỗi JavaScript',errors.length===0);
 await writeFile(path.join(artifactDir,'browser-results.json'),JSON.stringify({status:'passed',checks,errors,crossSite,scope:'Local browser + real Listening SQL/HTTP; Google fixture only; HTTPS test domains route to local API'},null,2),'utf8');
 console.log(JSON.stringify({status:'passed',checks:checks.length,artifactDir}));
}catch(error){
 const page=browser.contexts().flatMap(context=>context.pages())[0];
 const screen=page?await page.locator('body').innerText():'';
 if(page)await page.screenshot({path:path.join(artifactDir,'failure.png'),fullPage:true});
 await writeFile(path.join(artifactDir,'browser-results.json'),JSON.stringify({status:'failed',checks,errors,error:error.message,screen},null,2),'utf8');throw error;
}
finally{await browser.close();await new Promise(resolve=>listening.close(resolve));await state.close();}
