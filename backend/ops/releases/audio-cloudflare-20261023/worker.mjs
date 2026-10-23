import {ASSETS} from './catalog.mjs';
import {MAGIC,encoder,decodeBase64url,deriveAudioKey,partContext} from './protocol.mjs';

// All catalog entries already have a public Pages copy. This endpoint supplies
// transport keys, never student identity, exam permission or session keys.
export const REVISION='audio-cf-public-parts-20261023-v1';
const SIZE=524288,TTL=600000,common={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const keys=new Map();
function fail(code,status=403){throw Object.assign(Error(code),{status});}
function reply(value,status=200,headers={}){return Response.json(value,{status,headers:{...common,...headers}});}
function b64(bytes){return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
async function signer(env){
  if(!env.AUDIO_TICKET_SECRET||!env.AUDIO_KEY_SECRET)fail('NOT_CONFIGURED',503);
  return crypto.subtle.importKey('raw',encoder.encode(env.AUDIO_TICKET_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
function scope(asset,id){return {product:'public-mp3-v1',classId:'public',testId:asset.id,owner:'public',sid:id,generation:1,purpose:'audio.public',assetHash:asset.sha256,downloadId:id};}
async function access(asset,id,env){
  const context=scope(asset,id),c={...context,exp:Date.now()+TTL};
  const raw=encoder.encode(JSON.stringify(c)),signature=await crypto.subtle.sign('HMAC',await signer(env),raw);
  // Export a separately derived raw transport key. No persistent client key.
  const material=await crypto.subtle.importKey('raw',encoder.encode(env.AUDIO_KEY_SECRET),'HKDF',false,['deriveBits']);
  const {keyContext}=await import('./protocol.mjs');
  const rawKey=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:encoder.encode(c.sid),info:encoder.encode('izone-audio-parts-v1:'+keyContext(c))},material,256);
  return {version:1,policy:'public-mp3-v1',context,expiresAt:c.exp,ticket:b64(raw)+'.'+b64(signature),key:b64(rawKey)};
}
async function authorize(req,asset,env){
  const token=/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(req.headers.get('Authorization')||'');
  if(!token||token[1].length>2048)fail('AUTH_REQUIRED',401);
  let c,raw,sig;try{raw=decodeBase64url(token[1]);sig=decodeBase64url(token[2]);c=JSON.parse(new TextDecoder().decode(raw));}catch{fail('BAD_TICKET',401);}
  if(!await crypto.subtle.verify('HMAC',await signer(env),sig,raw))fail('BAD_SIGNATURE',401);
  if(!Number.isSafeInteger(c.exp)||c.exp<=Date.now()||c.exp>Date.now()+TTL)fail('EXPIRED',401);
  if(!/^[a-f0-9-]{36}$/.test(c.downloadId||''))fail('SCOPE_DENIED');
  const expected=scope(asset,c.downloadId);
  if(Object.keys(expected).some(k=>c[k]!==expected[k]))fail('SCOPE_DENIED');
  return c;
}
export default {async fetch(req,env){
  let cors={};
  try{
    const origin=req.headers.get('Origin'),origins=JSON.parse(env.AUDIO_ORIGINS||'[]');
    if(origin&&!origins.includes(origin))fail('ORIGIN_DENIED');
    if(origin)cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Authorization','Access-Control-Max-Age':'600','Access-Control-Expose-Headers':'Content-Length, X-Audio-Revision'};
    const url=new URL(req.url),p=url.pathname.split('/').filter(Boolean);
    if(url.pathname==='/health')return reply({revision:REVISION,policy:'public-mp3-v1',chunkSize:SIZE,assets:Object.keys(ASSETS).length,enabled:env.AUDIO_ENABLED==='true',deadline:Number(env.STAGE_DEADLINE)||null},200,cors);
    if(env.AUDIO_ENABLED!=='true')fail('SOURCE_DISABLED',503);
    if(env.STAGE_DEADLINE&&Date.now()>=Number(env.STAGE_DEADLINE))fail('STAGE_EXPIRED',503);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(!['GET','HEAD'].includes(req.method))fail('METHOD_DENIED',405);
    const asset=ASSETS[p[1]];
    if(!asset)fail('NOT_FOUND',404);
    if(p[0]==='access'&&p.length===3&&req.method==='GET'){
      if(!/^[a-f0-9-]{36}$/.test(p[2]))fail('INVALID_DOWNLOAD',400);
      return reply(await access(asset,p[2],env),200,cors);
    }
    if(p[0]!=='parts'||p.length!==4||p[2]!==String(SIZE)||!/^\d+$/.test(p[3]))fail('NOT_FOUND',404);
    const c=await authorize(req,asset,env),index=Number(p[3]);
    if(!Number.isSafeInteger(index)||index<0||index>=asset.chunks.length)fail('RANGE_DENIED',416);
    const length=asset.chunks[index].byteLength,headers={...common,...cors,'Content-Type':'application/octet-stream','Content-Length':String(length+33),'X-Audio-Revision':REVISION};
    if(req.method==='HEAD')return new Response(null,{headers});
    const object=await env.AUDIO.get(asset.key,{range:{offset:index*SIZE,length}});
    if(!object||object.size!==asset.byteLength)fail('OBJECT_MISMATCH',503);
    const plain=await object.arrayBuffer();if(plain.byteLength!==length)fail('OBJECT_TRUNCATED',503);
    const cacheId=env.AUDIO_KEY_SECRET+':'+c.downloadId+':'+asset.sha256;
    let key=keys.get(cacheId);
    if(!key||key.exp<=Date.now()){
      key={value:await deriveAudioKey(env.AUDIO_KEY_SECRET,c,['encrypt']),exp:c.exp};
      if(keys.size>=128)keys.delete(keys.keys().next().value);keys.set(cacheId,key);
    }
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:partContext(c,SIZE,index,length),tagLength:128},key.value,plain);
    const body=new ReadableStream({start(out){out.enqueue(MAGIC);out.enqueue(iv);out.enqueue(new Uint8Array(cipher));out.close();}});
    // Catalog identifier only: no URL query, identity, token, key or cookie.
    console.log(JSON.stringify({kind:'audio_chunk',asset:asset.id,index,plainBytes:length,wireBytes:length+33,revision:REVISION}));
    return new Response(body,{headers});
  }catch(error){return reply({code:error.status?error.message:'INTERNAL_ERROR'},error.status||500,cors);}
}};
