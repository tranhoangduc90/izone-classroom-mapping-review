const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
// A single download normally; verified 512 KiB cache is reused only for retry/reload.
// No timer, owner or exam state is written here. Refresh must repeat native authorization.
export async function downloadDirect(asset,{grant,refresh,fetchImpl=fetch,parts=new Map(),signal,onPart=()=>{},idleMs=6000,maxAttempts=3}={}) {
 signal=AbortSignal.any([signal,AbortSignal.timeout(120000)].filter(Boolean));
 const size=524288; let current=grant,refreshUsed=false;
 const buffers=[];let offset=0,requests=0;
 for(let i=0;i<asset.chunks.length;i++){
  const b=parts.get(asset.sha256+':'+size+':'+i),expected=asset.chunks[i];
  if(!b||b.length!==expected.byteLength||await sha(b)!==expected.sha256)break;
  buffers.push(b);offset+=b.length;
 }
 const validate=()=>{const u=new URL(current.url);if(u.protocol!=='https:'||!u.hostname.endsWith('.r2.cloudflarestorage.com')||u.username||u.password||current.sha256!==asset.sha256||current.byteLength!==asset.byteLength)throw Error('GRANT_DENIED');};
 const renew=async()=>{try{return await refresh();}catch(e){e.accessDenied=true;throw e;}};
 for(let attempt=0;offset<asset.byteLength&&attempt<maxAttempts;attempt++){
  signal?.throwIfAborted();validate();const c=new AbortController(),abort=()=>c.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
  let timer;const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>c.abort(),idleMs);};
  try{
   arm();requests++;const r=await fetchImpl(current.url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal:c.signal,credentials:'omit',cache:'no-store'});
   if([401,403].includes(r.status)){
    await r.body?.cancel();if(!refresh||refreshUsed)throw Error('ACCESS_DENIED');refreshUsed=true;current=await renew();continue;
   }
   if(!r.ok)throw Error('SOURCE_'+r.status);
   if(offset&&r.status===200){buffers.length=0;offset=0;}
   if(r.status===206){const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range')||'');if(!range||+range[1]!==offset||+range[2]!==asset.byteLength-1||+range[3]!==asset.byteLength)throw Error('RANGE_DENIED');}
   else if(r.status!==200)throw Error('RANGE_DENIED');
   const reader=r.body.getReader();let pending=new Uint8Array();
   while(true){arm();const {done,value}=await reader.read();if(done)break;
    const combined=new Uint8Array(pending.length+value.length);combined.set(pending);combined.set(value,pending.length);pending=combined;
    while(offset<asset.byteLength&&pending.length>=asset.chunks[buffers.length].byteLength){
     const i=buffers.length,expected=asset.chunks[i],b=pending.slice(0,expected.byteLength);pending=pending.slice(expected.byteLength);
     if(await sha(b)!==expected.sha256){await reader.cancel();throw Error('HASH_MISMATCH');}
     buffers.push(b);offset+=b.length;const id=asset.sha256+':'+size+':'+i;parts.set(id,b);await onPart(id,b);
    }
    if(pending.length&&offset===asset.byteLength){await reader.cancel();throw Error('SIZE_MISMATCH');}
   }
   if(offset!==asset.byteLength)throw Error('TRUNCATED');
  }catch(e){
   signal?.throwIfAborted();
   if(e.accessDenied||['ACCESS_DENIED','GRANT_DENIED','RANGE_DENIED','HASH_MISMATCH','SIZE_MISMATCH'].includes(e.message)||attempt===maxAttempts-1)throw e;
   // CORS hides expired R2 403: a network failure may need one authorized renewal.
   if(refresh&&!refreshUsed){refreshUsed=true;current=await renew();}
  }finally{clearTimeout(timer);c.abort();signal?.removeEventListener('abort',abort);}
 }
 if(offset!==asset.byteLength)throw Error('INCOMPLETE');
 const blob=new Blob(buffers,{type:'audio/mpeg'});if(await sha(await blob.arrayBuffer())!==asset.sha256)throw Error('WHOLE_HASH_MISMATCH');
 return {blob,requests,parts};
}
