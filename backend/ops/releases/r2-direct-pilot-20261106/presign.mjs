import {createHmac,createHash} from 'node:crypto';
const hex=(key,value)=>createHmac('sha256',key).update(value).digest();
const enc=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
// Backend receives an already authorized, pinned native manifest; no student credentials enter R2.
export function presign({accountId,bucket,key,accessKeyId,secretAccessKey,expires=600,now=new Date(),method='GET'}) {
 if(!/^[a-f0-9]{32}$/.test(accountId)||!bucket||!key||!accessKeyId||!secretAccessKey||!Number.isInteger(expires)||expires<1||expires>7200||method!=='GET')throw Error('SIGNING_CONFIG_DENIED');
 const date=now.toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=day+'/auto/s3/aws4_request',host=accountId+'.r2.cloudflarestorage.com';
 const pathname='/'+[bucket,...key.split('/')].map(enc).join('/');
 const query=Object.entries({'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':accessKeyId+'/'+scope,'X-Amz-Date':date,'X-Amz-Expires':String(expires),'X-Amz-SignedHeaders':'host'}).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>enc(k)+'='+enc(v)).join('&');
 const canonical=[method,pathname,query,'host:'+host+'\n','host','UNSIGNED-PAYLOAD'].join('\n');
 const stringToSign=['AWS4-HMAC-SHA256',date,scope,createHash('sha256').update(canonical).digest('hex')].join('\n');
 const signing=hex(hex(hex(hex('AWS4'+secretAccessKey,day),'auto'),'s3'),'aws4_request');
 return 'https://'+host+pathname+'?'+query+'&X-Amz-Signature='+hex(signing,stringToSign).toString('hex');
}

export async function issueAuthorized({authorize,assets,credentials,expires=600}) {
 const manifest=await authorize();
 const asset=Object.values(assets).find(a=>a.sha256===manifest?.sha256&&a.byteLength===manifest?.byteLength&&a.url===manifest?.url);
 if(!asset||manifest.envelopeVersion!=='MP3')throw Error('NATIVE_MANIFEST_DENIED');
 return {url:presign({...credentials,key:asset.key,expires}),sha256:asset.sha256,byteLength:asset.byteLength};
}
