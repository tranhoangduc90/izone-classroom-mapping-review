import {MAGIC,CHUNK_SIZES,REVISION,encoder,decodeBase64url,deriveAudioKey,partContext} from './protocol.mjs';
import {ASSETS} from './lab-catalog.mjs';

const common={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const signingKeys=new Map(),audioKeys=new Map();
function fail(code,status=403){throw Object.assign(Error(code),{status});}
function reply(value,status=200,headers={}){return Response.json(value,{status,headers:{...common,...headers}});}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
function cors(req,env){
  const origin=req.headers.get('Origin');
  const allowed=JSON.parse(env.LAB_ORIGINS||'[]');
  if(origin&&!allowed.includes(origin))fail('ORIGIN_DENIED');
  return origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Expose-Headers':'Content-Length, X-Audio-Revision, X-Audio-Envelope','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}:{};
}
function alive(env){if(!Number.isFinite(Number(env.LAB_DEADLINE))||Date.now()>=Number(env.LAB_DEADLINE))fail('LAB_EXPIRED',410);}
async function authorized(req,env,asset){
  if(!env.AUDIO_TICKET_SECRET||!env.AUDIO_KEY_SECRET)fail('NOT_CONFIGURED',503);
  const parts=(req.headers.get('Authorization')||'').replace(/^Bearer /,'').split('.');
  if(parts.length!==2||parts[0].length>4096)fail('AUTH_REQUIRED',401);
  let raw,sig,c;
  try{raw=decodeBase64url(parts[0]);sig=decodeBase64url(parts[1]);c=JSON.parse(new TextDecoder().decode(raw));}catch{fail('BAD_TICKET',401);}
  let signing=signingKeys.get(env.AUDIO_TICKET_SECRET);
  if(!signing){signing=await crypto.subtle.importKey('raw',encoder.encode(env.AUDIO_TICKET_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);signingKeys.set(env.AUDIO_TICKET_SECRET,signing);}
  if(!await crypto.subtle.verify('HMAC',signing,sig,raw))fail('BAD_SIGNATURE',401);
  if(!Number.isSafeInteger(c.exp)||c.exp<=Date.now()||c.exp>Date.now()+3600000)fail('EXPIRED',401);
  if(c.product!=='audio-cf-chunks-lab'||c.classId!=='LAB-ONLY'||c.testId!==asset.id||c.assetHash!==asset.sha256||c.generation!==1)fail('SCOPE_DENIED');
  if(!['lab-learner-a','lab-learner-b'].includes(c.owner)||!/^lab-[a-z0-9-]{1,64}$/.test(c.sid)||!/^lab-[a-z0-9-]{1,64}$/.test(c.downloadId))fail('OWNER_DENIED');
  if(c.superseded||c.revoked)fail('REVOKED');
  if(c.purpose==='audio.preload'){if(!['prepared','started'].includes(c.stage))fail('STAGE_DENIED');}
  else if(c.purpose==='audio.main'){if(c.stage!=='started')fail('NOT_STARTED');}
  else if(c.purpose==='audio.review'){if(c.stage!=='submitted')fail('NOT_SUBMITTED');}
  else fail('PURPOSE_DENIED');
  if(c.order==='read_first'&&!c.readingSubmitted)fail('READING_REQUIRED');
  if(await env.AUDIO_LAB.head('cf-chunks-lab/revocations/'+c.sid))fail('REVOKED');
  return c;
}
async function encryptedPart(req,env,asset,size,index,headers){
  const c=await authorized(req,env,asset);
  if(!CHUNK_SIZES.includes(size)||!Number.isSafeInteger(index)||index<0||index>=Math.ceil(asset.byteLength/size))fail('RANGE_DENIED',416);
  const length=Math.min(size,asset.byteLength-index*size);
  if(req.method==='HEAD'){
    const meta=await env.AUDIO_LAB.head(asset.key);
    if(!meta||meta.size!==asset.byteLength)fail('OBJECT_MISMATCH',503);
    return new Response(null,{headers:{...common,...headers,'Content-Length':String(length+33),'X-Audio-Envelope':'IZAP1','X-Audio-Revision':REVISION}});
  }
  const object=await env.AUDIO_LAB.get(asset.key,{range:{offset:index*size,length}});
  if(!object||object.size!==asset.byteLength)fail('OBJECT_MISMATCH',503);
  const plain=await object.arrayBuffer();
  if(plain.byteLength!==length)fail('OBJECT_TRUNCATED',503);
  const scope=keyContextForCache(env,c);let key=audioKeys.get(scope);
  if(!key||key.expiresAt<=Date.now()){
    key={value:await deriveAudioKey(env.AUDIO_KEY_SECRET,c,['encrypt']),expiresAt:c.exp};
    if(audioKeys.size>=128)audioKeys.delete(audioKeys.keys().next().value);
    audioKeys.set(scope,key);
  }
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:partContext(c,size,index,length),tagLength:128},key.value,plain);
  // Giữ ba phần header/IV/cipher riêng để không sao chép thêm toàn bộ buffer.
  // Stream chỉ gồm ciphertext đã hoàn tất AEAD, không mã hóa cả file trong request.
  const body=new ReadableStream({start(controller){controller.enqueue(MAGIC);controller.enqueue(iv);controller.enqueue(new Uint8Array(cipher));controller.close();}});
  const caseId=new URL(req.url).searchParams.get('case')||'';
  if(/^[a-zA-Z0-9-]{1,80}$/.test(caseId))console.log(JSON.stringify({kind:'audio_chunk',caseId,asset:asset.id,chunkSize:size,index,plainBytes:length,wireBytes:length+33,revision:REVISION}));
  return new Response(body,{headers:{...common,...headers,'Content-Type':'application/octet-stream','Content-Length':String(length+33),'X-Audio-Envelope':'IZAP1','X-Audio-Revision':REVISION}});
}
function keyContextForCache(env,c){return JSON.stringify([env.AUDIO_KEY_SECRET,c.product,c.classId,c.testId,c.owner,c.sid,c.generation,c.purpose,c.assetHash,c.downloadId]);}
async function admin(req,env,parts){
  if(!env.LAB_ADMIN_TOKEN||!equal(req.headers.get('Authorization'),'Bearer '+env.LAB_ADMIN_TOKEN))fail('ADMIN_REQUIRED',401);
  if(parts[1]==='revocations'&&req.method==='PUT'&&/^lab-[a-z0-9-]{1,64}$/.test(parts[2]||'')){
    await env.AUDIO_LAB.put('cf-chunks-lab/revocations/'+parts[2],String(Date.now()),{customMetadata:{labOnly:'true'}});return reply({revoked:true});
  }
  if(parts[1]!=='objects'||!ASSETS[parts[2]])fail('NOT_FOUND',404);
  const asset=ASSETS[parts[2]];
  if(req.method==='PUT'){
    if(!asset.uploadable)fail('UPLOAD_DENIED');
    if(Number(req.headers.get('Content-Length'))!==asset.byteLength)fail('SIZE_DENIED',400);
    const old=await env.AUDIO_LAB.head(asset.key);
    if(old){if(old.size===asset.byteLength&&old.customMetadata?.sha256===asset.sha256)return reply({exists:true,size:old.size});fail('IMMUTABLE_OBJECT',409);}
    const stored=await env.AUDIO_LAB.put(asset.key,req.body,{httpMetadata:{contentType:'audio/mpeg'},customMetadata:{sha256:asset.sha256,labOnly:'true'}});
    return reply({stored:true,size:stored.size});
  }
  if(req.method==='GET'){
    const object=await env.AUDIO_LAB.get(asset.key);if(!object)fail('NOT_FOUND',404);
    return new Response(object.body,{headers:{...common,'Content-Length':String(object.size),'Content-Type':'application/octet-stream'}});
  }
  fail('METHOD_DENIED',405);
}
export default {async fetch(req,env){
  let headers={};
  try{
    headers=cors(req,env);const url=new URL(req.url),parts=url.pathname.split('/').filter(Boolean);
    if(url.pathname==='/health')return reply({labOnly:true,revision:REVISION,deadline:Number(env.LAB_DEADLINE),r2Bound:!!env.AUDIO_LAB,assets:Object.keys(ASSETS)},200,headers);
    alive(env);if(!env.AUDIO_LAB)fail('R2_NOT_BOUND',503);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(parts[0]==='lab')return await admin(req,env,parts);
    if(parts[0]!=='parts'||parts.length!==4||!ASSETS[parts[1]])fail('NOT_FOUND',404);
    if(!['GET','HEAD'].includes(req.method))fail('METHOD_DENIED',405);
    if(!/^\d+$/.test(parts[2])||!/^\d+$/.test(parts[3]))fail('RANGE_DENIED',416);
    return await encryptedPart(req,env,ASSETS[parts[1]],Number(parts[2]),Number(parts[3]),headers);
  }catch(error){return reply({code:error.status?error.message:'INTERNAL_ERROR'},error.status||500,headers);}
}};
