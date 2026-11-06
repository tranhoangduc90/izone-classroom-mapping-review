import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloadDirect} from './direct.mjs';
import {issueAuthorized} from './presign.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex'),size=524288;
const bytes=Buffer.alloc(size*2+101,7),asset={id:'synthetic',sha256:digest(bytes),byteLength:bytes.length,url:'https://public.example/test.mp3',key:'test.mp3',chunks:[bytes.subarray(0,size),bytes.subarray(size,size*2),bytes.subarray(size*2)].map(b=>({sha256:digest(b),byteLength:b.length}))};
const grant={url:'https://test.r2.cloudflarestorage.com/b/test.mp3?test=synthetic',sha256:asset.sha256,byteLength:asset.byteLength};
const response=(start=0)=>new Response(bytes.subarray(start),{status:start?206:200,headers:start?{'content-range':`bytes ${start}-${bytes.length-1}/${bytes.length}`}:{}});
test('whole file verified in one request',async()=>{let n=0;const r=await downloadDirect(asset,{grant,fetchImpl:async()=>{n++;return response();}});assert.equal(n,1);assert.equal(r.blob.size,bytes.length);});
test('connection drops: retry starts at verified boundary, skips incomplete block',async()=>{let n=0,seen;
 const r=await downloadDirect(asset,{grant,fetchImpl:async(u,o)=>{if(n++===0){let p=0;return new Response(new ReadableStream({pull(c){if(p++===0)c.enqueue(bytes.subarray(0,size+17));else c.error(new TypeError('network lost'));}}));}seen=o.headers.Range;return response(size);}});
 assert.equal(seen,`bytes=${size}-`);assert.equal(r.blob.size,bytes.length);
});
test('reload uses verified cached prefix; corrupt cached block is downloaded again',async()=>{
 const parts=new Map([[asset.sha256+':'+size+':0',bytes.subarray(0,size)],[asset.sha256+':'+size+':1',Buffer.alloc(size,2)]]);let seen;
 await downloadDirect(asset,{grant,parts,fetchImpl:async(u,o)=>{seen=o.headers.Range;return response(size);}});assert.equal(seen,`bytes=${size}-`);
});
test('expiry refresh repeats native authorization once',async()=>{let n=0,renew=0;await downloadDirect(asset,{grant,refresh:async()=>{renew++;return grant;},fetchImpl:async()=>n++===0?new Response(null,{status:403}):response()});assert.equal(renew,1);assert.equal(n,2);});
test('permission revoked at renewal stops without fallback',async()=>{let n=0;await assert.rejects(downloadDirect(asset,{grant,refresh:async()=>{throw Error('NATIVE_REVOKED');},fetchImpl:async()=>{n++;return new Response(null,{status:403});}}),/NATIVE_REVOKED/);assert.equal(n,1);});
test('persistent 403 stops after one renewal',async()=>{let n=0;await assert.rejects(downloadDirect(asset,{grant,refresh:async()=>grant,fetchImpl:async()=>{n++;return new Response(null,{status:403});}}),/ACCESS_DENIED/);assert.equal(n,2);});
test('CORS expiry error can renew once, then stops',async()=>{let n=0;await assert.rejects(downloadDirect(asset,{grant,refresh:async()=>grant,fetchImpl:async()=>{n++;throw new TypeError('Failed to fetch');}}),/Failed to fetch/);assert.equal(n,3);});
test('changed identity abort does not request a fresh grant',async()=>{const c=new AbortController();let renew=0;c.abort();await assert.rejects(downloadDirect(asset,{grant,signal:c.signal,refresh:async()=>{renew++;return grant;}}));assert.equal(renew,0);});
test('corrupted network bytes fail without playing',async()=>{await assert.rejects(downloadDirect(asset,{grant,fetchImpl:async()=>new Response(Buffer.alloc(bytes.length,1))}),/HASH_MISMATCH/);});
test('wrong resume range is rejected',async()=>{const parts=new Map([[asset.sha256+':'+size+':0',bytes.subarray(0,size)]]);await assert.rejects(downloadDirect(asset,{grant,parts,fetchImpl:async()=>new Response(bytes.subarray(size),{status:206,headers:{'content-range':`bytes 0-${bytes.length-1}/${bytes.length}`}})}),/RANGE_DENIED/);});
test('pinned native manifest required; deny precedes signing',async()=>{
 await assert.rejects(issueAuthorized({authorize:async()=>{throw Error('NATIVE_DENIED');},assets:{asset}}),/NATIVE_DENIED/);
 for(const patch of [{sha256:'0'.repeat(64)},{envelopeVersion:'IZTT1'},{url:'https://wrong.example/test.mp3'},{byteLength:1}])await assert.rejects(issueAuthorized({authorize:async()=>({...asset,envelopeVersion:'MP3',...patch}),assets:{asset}}),/NATIVE_MANIFEST_DENIED/);
});
