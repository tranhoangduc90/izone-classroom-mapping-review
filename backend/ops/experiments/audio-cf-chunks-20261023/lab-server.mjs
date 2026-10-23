// Máy chủ fixture chỉ nghe loopback: cấp ngữ cảnh/khóa giả để thử vận chuyển.
// Không import API/SQL của học viên, không có start/submit/reset hoặc Portal.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHmac,hkdfSync} from 'node:crypto';
const root=process.env.AUDIO_LAB_EVIDENCE_DIR;if(!root)throw Error('AUDIO_LAB_EVIDENCE_DIR_REQUIRED');
const secrets=JSON.parse(await readFile(root+'/lab-private.json','utf8'));
const assets=JSON.parse(await readFile(root+'/public-assets-verified.json','utf8')).assets;
const sessions=new Map(),contexts=new Map(),base='https://izone-audio-cf-chunks-lab.tranhoangduc90.workers.dev';
const chunkSize=524288;
const json=(res,v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
function key(c){const scope=JSON.stringify([1,c.product,c.classId,c.testId,c.owner,c.sid,c.generation,c.purpose,c.assetHash,c.downloadId]);return Buffer.from(hkdfSync('sha256',Buffer.from(secrets.AUDIO_KEY_SECRET),Buffer.from(c.sid),Buffer.from('izone-audio-parts-v1:'+scope),32));}
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://127.0.0.1:8898');
 if(req.method!=='GET'){json(res,{code:'READ_ONLY_LAB'},405);return;}
 if(u.pathname==='/'){
  const sid=randomBytes(16).toString('hex');sessions.set(sid,{owner:'lab-learner-a',sid:'lab-browser-'+sid});
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Set-Cookie':'lab_session='+sid+'; HttpOnly; SameSite=Strict; Path=/'});res.end(await readFile(root+'/lab.html'));return;
 }
 if(['/client.mjs','/protocol.mjs'].includes(u.pathname)){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(new URL('.'+u.pathname,import.meta.url)));return;}
 const cookie=/(?:^|; )lab_session=([a-f0-9]+)/.exec(req.headers.cookie||''),principal=sessions.get(cookie?.[1]);
 if(!principal){json(res,{code:'LAB_IDENTITY_REQUIRED'},401);return;}
 if(u.pathname==='/api/catalog'){json(res,assets.map(a=>({label:a.label,sha256:a.sha256,byteLength:a.byteLength})));return;}
 if(u.pathname.startsWith('/metadata-audio/')){
  const sha=u.pathname.split('/').at(-1).replace(/\.mp3$/,'');const asset=assets.find(a=>a.sha256===sha);if(!asset){json(res,{code:'NOT_FOUND'},404);return;}
  const b=await readFile(asset.file),range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
  const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),b.length-1):b.length-1;
  if(start>=b.length||start>end){res.writeHead(416);res.end();return;}
  const body=b.subarray(start,end+1);res.writeHead(range?206:200,{'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','Content-Length':body.length,...(range?{'Content-Range':`bytes ${start}-${end}/${b.length}`}:{})});res.end(body);return;
 }
 if(u.pathname==='/api/access'){
  if(u.searchParams.has('owner')&&u.searchParams.get('owner')!==principal.owner){json(res,{code:'OWNER_DENIED'},403);return;}
  const id=u.searchParams.get('asset')||'k56-mini',label=id==='k56-mini'?'K56 · mini-test-k56':id==='k67-sub2'?'substitute-test-2-k67':null;
  const asset=assets.find(a=>a.label===label);if(!asset){json(res,{code:'ASSET_DENIED'},403);return;}
  const mode=u.searchParams.get('context')||'public-mp3';if(!['public-mp3','prepared-private','started-private'].includes(mode)){json(res,{code:'CONTEXT_DENIED'},403);return;}
  const c={product:'audio-cf-chunks-lab',classId:'LAB-ONLY',testId:id,owner:principal.owner,sid:principal.sid,generation:1,purpose:'audio.preload',stage:mode==='started-private'?'started':'prepared',assetHash:asset.sha256,downloadId:'lab-'+randomBytes(8).toString('hex'),exp:Date.now()+600000};
  const b=Buffer.from(JSON.stringify(c)),ticket=b.toString('base64url')+'.'+createHmac('sha256',secrets.AUDIO_TICKET_SECRET).update(b).digest('base64url');
  const contextId=randomBytes(16).toString('hex');contexts.set(contextId,{sid:principal.sid,c,keyAllowed:mode!=='prepared-private'});
  json(res,{contextId,labOnly:true,key:mode==='prepared-private'?null:Array.from(key(c)),manifest:{version:1,byteLength:asset.byteLength,sha256:asset.sha256,chunkSize,chunks:asset.chunks[chunkSize],context:c,ticket,primaryUrl:base+'/parts/'+id,fallbackUrl:asset.url}});return;
 }
 if(u.pathname==='/api/key'){
  const ctx=contexts.get(u.searchParams.get('contextId'));if(!ctx||ctx.sid!==principal.sid){json(res,{code:'OWNER_DENIED'},403);return;}
  if(!ctx.keyAllowed){json(res,{code:'NOT_STARTED'},403);return;}json(res,{key:Array.from(key(ctx.c))});return;
 }
 json(res,{code:'NOT_FOUND'},404);
}catch{json(res,{code:'LAB_ERROR'},500);}});
server.listen(8898,'127.0.0.1',()=>console.log(JSON.stringify({listening:'http://127.0.0.1:8898',labOnly:true,studentDatabaseConnected:false})));
