// Kiểm Chrome thật trên trang lab loopback và nguồn R2/Pages thật. Chỉ chặn
// request của browser thử để gây lỗi; không sửa Worker/API production.
import {createRequire} from 'node:module';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const modules=process.env.PLAYWRIGHT_MODULES;if(!modules)throw Error('PLAYWRIGHT_MODULES_REQUIRED');
const require=createRequire(modules+'/playwright/package.json');const {chromium}=require('playwright');
const out=process.env.AUDIO_LAB_EVIDENCE_DIR;if(!out)throw Error('AUDIO_LAB_EVIDENCE_DIR_REQUIRED');
await mkdir(out+'/output/playwright',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
const cf='izone-audio-cf-chunks-lab.tranhoangduc90.workers.dev',pages='tranhoangduc90.github.io';
async function scenario(name,configure,expected){
 const context=await browser.newContext(),page=await context.newPage(),requests=[],pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 page.on('request',r=>{const u=new URL(r.url());if([cf,pages].includes(u.hostname))requests.push({origin:u.origin,path:u.pathname,method:r.method()});});
 if(configure)await configure(page,context);
 await page.goto('http://127.0.0.1:8898/');
 if(name==='largest-primary')await page.locator('#asset').selectOption('k67-sub2');
 await page.locator('#load').click();
 if(name==='user-cancel')await page.locator('#cancel').click();
 await page.waitForFunction(()=>window.labResult!==null,{},{timeout:90000});
 const result=await page.evaluate(()=>window.labResult);await expected(result,requests,page,context);assert.deepEqual(pageErrors,[]);
 await page.screenshot({path:out+'/output/playwright/'+name+'.png',fullPage:true});
 results.push({name,passed:true,result,network:requests,pageErrors});
 await writeFile(out+'/browser-results.json',JSON.stringify({results},null,2));console.log(JSON.stringify({name,passed:true,...result}));await context.close();
}
try{
 await scenario('primary',null,async(r,q,p)=>{
  assert.equal(r.passed,true);assert.equal(r.pagesParts,0);assert.equal(r.cloudflareParts,5);assert.equal(r.chunkSize,524288);assert.equal(q.filter(x=>x.origin.includes(pages)).length,0);assert.ok(r.duration>0);
  await p.locator('#play').click();await p.waitForFunction(()=>document.querySelector('audio').currentTime>0.2);await p.locator('audio').evaluate(el=>el.pause());
 });
 await scenario('worker-offline',p=>p.route('https://'+cf+'/**',route=>route.abort('failed')),async(r,q)=>{assert.equal(r.passed,true);assert.equal(r.cloudflareParts,0);assert.ok(r.pagesParts>0);assert.ok(q.some(x=>x.origin.includes(pages)));});
 await scenario('partial-fallback',p=>p.route('https://'+cf+'/**',route=>new URL(route.request().url()).pathname.endsWith('/4')?route.abort('failed'):route.continue()),async(r)=>{assert.equal(r.passed,true);assert.equal(r.cloudflareParts,4);assert.equal(r.pagesParts,1);});
 await scenario('access-denied',p=>p.route('https://'+cf+'/**',route=>route.fulfill({status:403,headers:{'Access-Control-Allow-Origin':'http://127.0.0.1:8898','Content-Type':'application/json'},body:JSON.stringify({code:'REVOKED'})})),async(r,q)=>{assert.equal(r.passed,false);assert.equal(r.error,'ACCESS_DENIED');assert.equal(q.filter(x=>x.origin.includes(pages)).length,0);});
 await scenario('user-cancel',p=>p.route('https://'+cf+'/**',()=>new Promise(resolve=>setTimeout(resolve,15000))),async(r,q)=>{assert.equal(r.passed,false);assert.equal(q.filter(x=>x.origin.includes(pages)).length,0);});
 await scenario('largest-primary',null,async(r,q)=>{assert.equal(r.passed,true);assert.equal(r.bytes,41881391);assert.equal(r.cloudflareParts,80);assert.equal(r.chunkSize,524288);assert.equal(r.pagesParts,0);assert.ok(r.duration>0);});
 const context=await browser.newContext(),page=await context.newPage();await page.goto('http://127.0.0.1:8898/');
 const prepared=await(await context.request.get('http://127.0.0.1:8898/api/access?context=prepared-private')).json();assert.equal(prepared.key,null);
 assert.equal((await context.request.get('http://127.0.0.1:8898/api/key?contextId='+prepared.contextId)).status(),403);
 const started=await(await context.request.get('http://127.0.0.1:8898/api/access?context=started-private')).json();assert.equal(started.key.length,32);
 assert.equal((await context.request.get('http://127.0.0.1:8898/api/access?owner=lab-learner-b')).status(),403);
 const other=await browser.newContext();const otherPage=await other.newPage();await otherPage.goto('http://127.0.0.1:8898/');assert.equal((await other.request.get('http://127.0.0.1:8898/api/key?contextId='+started.contextId)).status(),403);await other.close();
 results.push({name:'fixture-key-gating-and-owner',passed:true,nativeProductionAuthTested:false});
 const audioMetadata=await page.evaluate(async()=>{
  const catalog=await(await fetch('/api/catalog')).json(),records=[];
  for(const item of catalog){const audio=new Audio();audio.preload='metadata';audio.src='/metadata-audio/'+item.sha256+'.mp3';await new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=()=>reject(Error('DECODE_FAILED:'+item.label));audio.load();});records.push({...item,duration:audio.duration});audio.removeAttribute('src');audio.load();}
  return records;
 });assert.equal(audioMetadata.length,12);assert.ok(audioMetadata.every(x=>Number.isFinite(x.duration)&&x.duration>0));
 await writeFile(out+'/audio-metadata.json',JSON.stringify(audioMetadata,null,2));results.push({name:'12-real-mp3-decode-metadata',passed:true,assets:audioMetadata.length});await context.close();
 await writeFile(out+'/browser-results.json',JSON.stringify({passed:true,results},null,2));console.log(JSON.stringify({browserChecks:results.length,passed:true}));
}finally{await browser.close();}
