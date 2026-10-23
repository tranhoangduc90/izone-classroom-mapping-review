// Kiểm giao thức/đổi nguồn bằng file chuẩn và crypto Node độc lập. R2 giả chỉ
// chứng minh hợp đồng local; CPU và object R2 thật có bộ kiểm remote riêng.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHmac,hkdfSync,createHash,createDecipheriv} from 'node:crypto';
import worker from './worker.mjs';
import {downloadAudio} from './client.mjs';
import {ASSETS} from './lab-catalog.mjs';

const evidence=process.env.AUDIO_LAB_EVIDENCE_DIR;
if(!evidence)throw Error('AUDIO_LAB_EVIDENCE_DIR_REQUIRED');
const records=JSON.parse(await readFile(evidence+'/public-assets-verified.json','utf8')).assets;
const asset=ASSETS['k56-mini'],record=records.find(x=>x.sha256===asset.sha256);
const bytes=await readFile(record.file),origin='https://izone-audio-cf-chunks-lab.tranhoangduc90.workers.dev';
function claims(overrides={}){return{product:'audio-cf-chunks-lab',classId:'LAB-ONLY',testId:asset.id,owner:'lab-learner-a',sid:'lab-unit-a',generation:1,purpose:'audio.preload',stage:'prepared',assetHash:asset.sha256,downloadId:'lab-download-a',exp:Date.now()+600000,...overrides};}
function sign(c,secret){const b=Buffer.from(JSON.stringify(c));return b.toString('base64url')+'.'+createHmac('sha256',secret).update(b).digest('base64url');}
function independentKey(secret,c){const scope=JSON.stringify([1,c.product,c.classId,c.testId,c.owner,c.sid,c.generation,c.purpose,c.assetHash,c.downloadId]);return Buffer.from(hkdfSync('sha256',Buffer.from(secret),Buffer.from(c.sid),Buffer.from('izone-audio-parts-v1:'+scope),32));}
function independentAAD(c,size,index,len){const scope=JSON.stringify([1,c.product,c.classId,c.testId,c.owner,c.sid,c.generation,c.purpose,c.assetHash,c.downloadId]);return Buffer.from(JSON.stringify([scope,size,index,index*size,len]));}
function setup(){
 const entries=new Map([[asset.key,{bytes,customMetadata:{sha256:asset.sha256}}]]);const calls=[];
 const env={LAB_DEADLINE:String(Date.now()+3600000),LAB_ORIGINS:JSON.stringify(['http://127.0.0.1:8898','https://tranhoangduc90.github.io']),AUDIO_TICKET_SECRET:randomBytes(32).toString('hex'),AUDIO_KEY_SECRET:randomBytes(32).toString('hex'),LAB_ADMIN_TOKEN:randomBytes(32).toString('hex'),AUDIO_LAB:{
  async head(key){calls.push(['head',key]);const v=entries.get(key);return v?{size:v.bytes.length,customMetadata:v.customMetadata}:null;},
  async get(key,options){calls.push(['get',key]);const v=entries.get(key);if(!v)return null;const selected=options?.range?v.bytes.subarray(options.range.offset,options.range.offset+options.range.length):v.bytes;return{size:v.bytes.length,arrayBuffer:async()=>new Uint8Array(selected).buffer,body:new Blob([selected]).stream()};},
  async put(key,value,options){const b=Buffer.from(await new Response(value).arrayBuffer());entries.set(key,{bytes:b,customMetadata:options?.customMetadata});return{size:b.length};}
 }};
 return{env,calls,entries};
}
function request(c,env,size=1048576,index=0,options={}){return new Request(origin+'/parts/'+asset.id+'/'+size+'/'+index,{headers:{Authorization:'Bearer '+sign(c,env.AUDIO_TICKET_SECRET),...(options.headers||{})},method:options.method||'GET'});}
function manifest(c,env,size=1048576){return{version:1,byteLength:asset.byteLength,sha256:asset.sha256,context:c,chunkSize:size,chunks:record.chunks[size],primaryUrl:origin+'/parts/'+asset.id,fallbackUrl:record.url,ticket:sign(c,env.AUDIO_TICKET_SECRET)};}
function transport(env,handler){const requests=[];const fetchImpl=async(url,init={})=>{
 const u=new URL(url);requests.push({origin:u.origin,index:Number(u.pathname.split('/').at(-1)),headers:Object.fromEntries(new Headers(init.headers))});
 const overridden=await handler?.(u,init);if(overridden)return overridden;
 if(u.origin===origin)return worker.fetch(new Request(u,init),env);
 assert.equal(new Headers(init.headers).has('Authorization'),false);assert.equal(init.credentials,'omit');
 const match=/bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('Range'));assert.ok(match);
 return new Response(bytes.subarray(Number(match[1]),Number(match[2])+1),{status:206});
 };return{fetchImpl,requests};}

test('Worker parts: all candidate sizes decrypt independently and keep same bytes',async()=>{
 const {env}=setup(),c=claims();
 for(const size of [524288,1048576,2097152])for(const index of [0,Math.ceil(bytes.length/size)-1]){
  const r=await worker.fetch(request(c,env,size,index),env);assert.equal(r.status,200);const b=Buffer.from(await r.arrayBuffer());
  const expected=bytes.subarray(index*size,Math.min(bytes.length,(index+1)*size));assert.equal(b.length,expected.length+33);assert.equal(b.subarray(0,5).toString(),'IZAP1');
  const d=createDecipheriv('aes-256-gcm',independentKey(env.AUDIO_KEY_SECRET,c),b.subarray(5,17));d.setAAD(independentAAD(c,size,index,expected.length));d.setAuthTag(b.subarray(-16));
  assert.deepEqual(Buffer.concat([d.update(b.subarray(17,-16)),d.final()]),expected);
 }
});
test('Worker uses fresh nonce, other session key and changed chunk AAD cannot decrypt',async()=>{
 const {env}=setup(),c=claims();const a=Buffer.from(await(await worker.fetch(request(c,env),env)).arrayBuffer()),b=Buffer.from(await(await worker.fetch(request(c,env),env)).arrayBuffer());assert.notDeepEqual(a.subarray(5,17),b.subarray(5,17));
 for(const [ctx,index]of [[claims({sid:'lab-unit-b'}),0],[c,1]]){
  const d=createDecipheriv('aes-256-gcm',independentKey(env.AUDIO_KEY_SECRET,ctx),a.subarray(5,17));d.setAAD(independentAAD(ctx,1048576,index,1048576));d.setAuthTag(a.subarray(-16));assert.throws(()=>Buffer.concat([d.update(a.subarray(17,-16)),d.final()]));
 }
});
for(const [name,change,status]of [
 ['expired',{exp:Date.now()-1},401],['wrong product',{product:'other'},403],['wrong class',{classId:'OTHER'},403],['wrong test',{testId:'k67-sub2'},403],['wrong hash',{assetHash:'a'.repeat(64)},403],['wrong generation',{generation:2},403],['wrong owner',{owner:'other'},403],['superseded',{superseded:true},403],['main before start',{purpose:'audio.main',stage:'prepared'},403],['review before submit',{purpose:'audio.review',stage:'started'},403],['read first not submitted',{order:'read_first',readingSubmitted:false},403]
])test('Worker denies '+name+' before reading R2',async()=>{const {env,calls}=setup();const r=await worker.fetch(request(claims(change),env),env);assert.equal(r.status,status);assert.equal(calls.length,0);});
test('Worker denies invalid signature and forbidden origin before R2',async()=>{
 const {env,calls}=setup(),c=claims();const invalid=request(c,{...env,AUDIO_TICKET_SECRET:'other-secret'});assert.equal((await worker.fetch(invalid,env)).status,401);
 assert.equal((await worker.fetch(request(c,env,1048576,0,{headers:{Origin:'https://other.example'}}),env)).status,403);assert.equal(calls.length,0);
});
test('Worker dynamic lab revocation invalidates the same live ticket',async()=>{
 const {env}=setup(),c=claims();assert.equal((await worker.fetch(request(c,env),env)).status,200);
 const r=await worker.fetch(new Request(origin+'/lab/revocations/'+c.sid,{method:'PUT',headers:{Authorization:'Bearer '+env.LAB_ADMIN_TOKEN}}),env);assert.equal(r.status,200);assert.equal((await worker.fetch(request(c,env),env)).status,403);
});
test('HEAD, invalid part and preflight have correct semantics',async()=>{
 const {env}=setup(),c=claims();const head=await worker.fetch(request(c,env,1048576,0,{method:'HEAD'}),env);assert.equal(head.status,200);assert.equal(head.headers.get('Content-Length'),String(1048576+33));assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await worker.fetch(request(c,env,1048576,999),env)).status,416);
 const pre=await worker.fetch(new Request(origin+'/parts/k56-mini/1048576/0',{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:8898'}}),env);assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Origin'),'http://127.0.0.1:8898');
});
test('Cloudflare primary produces full correct MP3 at all candidate sizes, no Pages request',async()=>{
 const {env}=setup(),c=claims(),t=transport(env);for(const size of [524288,1048576,2097152]){const result=await downloadAudio(manifest(c,env,size),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c)});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);}assert.equal(t.requests.filter(r=>r.origin!==origin).length,0);
});
test('Worker CPU/transport failure falls back to Pages with no credentials',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,u=>u.origin===origin?new Response('1102',{status:500}):null);const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);assert.ok(result.events.some(x=>x.source==='pages'));
});
test('Last part fails: preserves verified Cloudflare parts and progress counts once',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,u=>u.origin===origin&&u.pathname.endsWith('/2')?new Response('cut',{status:503}):null),progress=[];
 const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0,onProgress:x=>progress.push(x.loaded)});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);assert.equal(result.events.filter(x=>x.source==='pages').length,1);assert.equal(progress.at(-1),bytes.length);assert.ok(progress.every((x,i)=>!i||x>progress[i-1]));
});
for(const status of [401,403])test('Access '+status+' cannot be bypassed using Pages',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,u=>u.origin===origin?Response.json({code:'REVOKED'},{status}):null);
 await assert.rejects(downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c)}),/ACCESS_DENIED/);assert.equal(t.requests.filter(x=>x.origin!==origin).length,0);
});
test('Expired credential refreshes once through issuer and keeps existing key',async()=>{
 const {env}=setup(),c=claims({exp:Date.now()-10}),t=transport(env);let n=0;
 const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),refresh:async()=>{n++;return sign({...c,exp:Date.now()+600000},env.AUDIO_TICKET_SECRET);}});assert.equal(n,1);assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);
});
test('Tampered cipher is rejected, verified fallback still succeeds',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,async u=>{if(u.origin!==origin)return;const response=await worker.fetch(request(c,env,1048576,Number(u.pathname.split('/').at(-1))),env);const b=new Uint8Array(await response.arrayBuffer());b[100]^=1;return new Response(b);});
 const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);assert.ok(result.events.some(x=>x.source==='primary-error'));
});
test('Both sources or fallback hash fail: no Blob is returned',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,u=>u.origin===origin?new Response('error',{status:500}):new Response(new Uint8Array(10),{status:206}));
 await assert.rejects(downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0}),/FALLBACK_HASH_MISMATCH/);
});
test('User cancellation never starts fallback',async()=>{
 const {env}=setup(),c=claims(),t=transport(env),a=new AbortController();a.abort();await assert.rejects(downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),signal:a.signal}));assert.equal(t.requests.length,0);
});
test('Cached public parts are verified; bad cache is reloaded, complete cache uses no network',async()=>{
 const {env}=setup(),c=claims(),t=transport(env),parts=new Map([[asset.sha256+':1048576:0',new Uint8Array(1048576)]]);const first=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),parts});assert.deepEqual(Buffer.from(await first.blob.arrayBuffer()),bytes);
 const second=await downloadAudio(manifest(c,env),{fetchImpl:async()=>{throw Error('NO_NETWORK_EXPECTED');},key:independentKey(env.AUDIO_KEY_SECRET,c),parts});assert.equal(second.events.filter(x=>x.source==='cache').length,3);
});
test('Pages returning full 200 rather than Range still yields correct file',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,u=>u.origin===origin?new Response('offline',{status:503}):new Response(bytes));const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);
});
test('Technical quota response 429 falls back, authentication denial does not',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,u=>u.origin===origin?new Response('quota',{status:429}):null);const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);assert.ok(result.events.some(x=>x.source==='pages'));
});
test('HTTP 200 cut in middle cannot be treated as downloaded audio',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,async u=>{if(u.origin!==origin)return;const r=await worker.fetch(request(c,env,1048576,Number(u.pathname.split('/').at(-1))),env);const b=new Uint8Array(await r.arrayBuffer());return new Response(b.slice(0,-1));});const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);assert.ok(result.events.some(x=>x.source==='primary-error'));
});
test('Primary timeout falls back without cancelling the student operation',async()=>{
 const {env}=setup(),c=claims(),t=transport(env,(u,init)=>u.origin===origin?new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Timeout','AbortError')),{once:true})):null);const result=await downloadAudio(manifest(c,env),{fetchImpl:t.fetchImpl,key:independentKey(env.AUDIO_KEY_SECRET,c),primaryRetries:0,primaryTimeoutMs:5});assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);assert.ok(result.events.some(x=>x.source==='pages'));
});
