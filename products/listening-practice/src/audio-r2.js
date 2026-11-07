import {readFileSync} from 'node:fs';
import {createHmac,createHash} from 'node:crypto';
const catalog=JSON.parse(readFileSync(new URL('./r2-audio-catalog.json',import.meta.url),'utf8'));
export const R2_HEADER='X-Izone-Audio-Transport';
export const R2_POLICY='r2-direct-v1';
const enc=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const mac=(key,value)=>createHmac('sha256',key).update(value).digest();
function settings(env=process.env){
 if(env.AUDIO_R2_DIRECT_ENABLED!=='true'||!env.AUDIO_R2_DIRECT_CONFIG_FILE)return null;
 try{return JSON.parse(readFileSync(env.AUDIO_R2_DIRECT_CONFIG_FILE,'utf8'));}catch{throw Object.assign(Error('AUDIO_R2_UNAVAILABLE'),{status:503,code:'AUDIO_R2_UNAVAILABLE'});}
}
export function r2Eligible(hash,options={}){
 const c=options.settings??settings(options.env);
 return !!(catalog[hash]&&c?.enabled===true&&Array.isArray(c.assets)&&c.assets.includes(hash));
}
// Called only after the native product route has authorized the exact pinned file.
export function issueR2Download(manifest,{requested,eligible=true,now=new Date(),...options}={}){
 if(requested!==R2_POLICY||!eligible)return undefined;
 const c=options.settings??settings(options.env),asset=catalog[manifest?.sha256];
 if(!r2Eligible(manifest?.sha256,{settings:c,env:options.env}))return undefined;
 if(!asset||manifest.url!==asset.url||manifest.byteLength!==asset.byteLength||manifest.envelopeVersion!=='MP3')throw Object.assign(Error('AUDIO_R2_MANIFEST_DENIED'),{status:403,code:'AUDIO_R2_MANIFEST_DENIED'});
 if(!/^[a-f0-9]{32}$/.test(c.accountId||'')||!c.bucket||!c.accessKeyId||!c.secretAccessKey)throw Object.assign(Error('AUDIO_R2_UNAVAILABLE'),{status:503,code:'AUDIO_R2_UNAVAILABLE'});
 const date=now.toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=day+'/auto/s3/aws4_request';
 const host=c.accountId+'.r2.cloudflarestorage.com',pathname='/'+[c.bucket,...asset.key.split('/')].map(enc).join('/');
 const query=Object.entries({'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':c.accessKeyId+'/'+scope,'X-Amz-Date':date,'X-Amz-Expires':'600','X-Amz-SignedHeaders':'host'}).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>enc(k)+'='+enc(v)).join('&');
 const canonical=['GET',pathname,query,'host:'+host+'\n','host','UNSIGNED-PAYLOAD'].join('\n');
 const stringToSign=['AWS4-HMAC-SHA256',date,scope,createHash('sha256').update(canonical).digest('hex')].join('\n');
 const signing=mac(mac(mac(mac('AWS4'+c.secretAccessKey,day),'auto'),'s3'),'aws4_request');
 return {version:1,policy:R2_POLICY,method:'GET',url:'https://'+host+pathname+'?'+query+'&X-Amz-Signature='+mac(signing,stringToSign).toString('hex'),sha256:asset.sha256,byteLength:asset.byteLength,validForSeconds:600,fallback:'public-pages',chunkSize:524288,chunks:asset.chunks};
}
