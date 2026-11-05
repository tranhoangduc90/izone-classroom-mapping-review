import {createHash} from 'node:crypto';
const origin='https://tranhoangduc90.github.io';
const manifestURL=origin+'/izone-ai-team-pages/progress-log/release.json';
export function createFrontendReleaseReader({fetcher=fetch,now=Date.now,storage}={}){
 let active=null,pending=null,nextCheck=0,restored=false;
 async function verify(){
  if(!restored){restored=true;try{const saved=await storage?.read();if(/^[a-f0-9]{16}$/.test(saved?.version))active={version:saved.version};}catch{/* Retry the public package; no student data is involved. */}}
  const response=await fetcher(manifestURL+'?check='+Math.floor(now()/60000),{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Release manifest unavailable');
  const raw=await response.text();if(raw.length>200000)throw Error('Release manifest too large');
  const release=JSON.parse(raw),version=release.version;
  if(!/^[a-f0-9]{16}$/.test(version)||!Array.isArray(release.assets)||release.assets.length<6||release.assets.length>500)throw Error('Invalid release');
  if(active?.version===version)return;
  const prefix='/izone-ai-team-pages/progress-log/releases/'+version+'/';
  const paths=new Set(release.assets.map(a=>a.path));
  if(paths.size!==release.assets.length||!['index.html','thuy.html','teacher.html','teacher-thuy.html','student.html','journey.html'].every(entry=>paths.has(prefix+'progress-log/'+entry)))throw Error('Incomplete entry package');
  if(release.assets.reduce((n,a)=>n+a.bytes,0)>15000000)throw Error('Release too large');
  const assets=[...release.assets];
  await Promise.all(Array.from({length:6},async()=>{while(assets.length){
   const item=assets.pop();if(!item.path?.startsWith(prefix)||/\.\.|[?#\\]/.test(item.path)||!/^([a-f0-9]{64})$/.test(item.sha256)||!Number.isInteger(item.bytes)||item.bytes<0||item.bytes>5000000)throw Error('Invalid asset');
   const result=await fetcher(origin+item.path,{redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!result.ok||Number(result.headers.get('content-length'))>5000000)throw Error('Missing asset');
   const data=Buffer.from(await result.arrayBuffer());if(data.length!==item.bytes||createHash('sha256').update(data).digest('hex')!==item.sha256)throw Error('Asset hash mismatch');
  }}));
  if(storage)await storage.write({version});active={version};
 }
 return ()=>{
  if(!pending&&now()>=nextCheck){nextCheck=now()+60000;pending=verify().catch(()=>{}).finally(()=>{pending=null;});}
  return active;
 };
}
