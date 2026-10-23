import {MAGIC,CHUNK_SIZES,partContext,sha256} from './protocol.mjs';

// Nhận metadata đã được bên cấp quyền xác minh và khóa đúng phiên. Tải Cloudflare
// trước, kiểm giải mã/hash rồi mới ghép Blob. Lỗi quyền dừng; lỗi nguồn mới dùng
// Pages. Không bắt đầu, nộp, reset hay thay đồng hồ của bất kỳ bài học nào.
export async function downloadAudio(m,options={}){
  const fetchImpl=options.fetchImpl||fetch,parts=options.parts||new Map();
  if(m.version!==1||!CHUNK_SIZES.includes(m.chunkSize)||!Number.isSafeInteger(m.byteLength)||m.byteLength<1||!/^[a-f0-9]{64}$/.test(m.sha256)||m.context?.assetHash!==m.sha256||m.chunks?.length!==Math.ceil(m.byteLength/m.chunkSize))throw Error('MANIFEST_DENIED');
  const primary=new URL(m.primaryUrl),fallback=new URL(m.fallbackUrl);
  if(primary.origin!=='https://izone-audio-cf-chunks-lab.tranhoangduc90.workers.dev'||!primary.pathname.startsWith('/parts/')||primary.search||primary.hash)throw Error('PRIMARY_DENIED');
  if(fallback.origin!=='https://tranhoangduc90.github.io'||!fallback.pathname.startsWith('/izone-ai-team-pages/term-tests/')||fallback.search||fallback.hash)throw Error('FALLBACK_DENIED');
  if(!m.chunks.every((x,i)=>x.byteLength===Math.min(m.chunkSize,m.byteLength-i*m.chunkSize)&&/^[a-f0-9]{64}$/.test(x.sha256)))throw Error('MANIFEST_DENIED');
  const key=await crypto.subtle.importKey('raw',options.key,{name:'AES-GCM'},false,['decrypt']);
  let next=0,loaded=0,disablePrimary=false,fatal=null,refreshed=false,refreshPromise=null;
  const result=new Array(m.chunks.length),events=[];
  const event=e=>{events.push(e);options.onEvent?.(e);};
  const check=()=>{options.signal?.throwIfAborted();if(fatal)throw fatal;};
  const verify=async(bytes,expected)=>bytes.byteLength===expected.byteLength&&await sha256(bytes)===expected.sha256;
  async function network(url,init,timeout){
    const controller=new AbortController(),abort=()=>controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>controller.abort(),timeout);
    try{check();const response=await fetchImpl(url,{...init,credentials:'omit',signal:controller.signal});const body=new Uint8Array(await response.arrayBuffer());return{response,body};}
    finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  async function cloudflare(i,expected){
    const u=new URL(m.primaryUrl+'/'+m.chunkSize+'/'+i);
    if(options.caseId)u.searchParams.set('case',options.caseId+'-'+i);
    const usedTicket=m.ticket;
    const {response,body}=await network(u,{headers:{Authorization:'Bearer '+usedTicket},cache:'no-store'},options.primaryTimeoutMs||15000);
    event({source:'cloudflare',index:i,status:response.status,wireBytes:body.length});
    if([401,403].includes(response.status)){
      let code;try{code=JSON.parse(new TextDecoder().decode(body)).code;}catch{}
      if(response.status===401&&code==='EXPIRED'&&options.refresh){
        if(usedTicket!==m.ticket)return cloudflare(i,expected);
        if(!refreshed){refreshed=true;refreshPromise=Promise.resolve().then(()=>options.refresh()).then(ticket=>{m={...m,ticket};});}
        if(refreshPromise){await refreshPromise;if(usedTicket!==m.ticket)return cloudflare(i,expected);}
      }
      throw Object.assign(Error('ACCESS_DENIED'),{accessDenied:true,status:response.status});
    }
    if(!response.ok)throw Error('PRIMARY_HTTP_'+response.status);
    if(body.length!==expected.byteLength+33||!MAGIC.every((n,j)=>body[j]===n))throw Error('ENVELOPE_INVALID');
    const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:body.slice(5,17),additionalData:partContext(m.context,m.chunkSize,i,expected.byteLength),tagLength:128},key,body.slice(17)));
    if(!await verify(plain,expected))throw Error('PRIMARY_HASH_MISMATCH');return plain;
  }
  async function pages(i,expected){
    const start=i*m.chunkSize;
    const {response,body}=await network(m.fallbackUrl,{headers:{Range:`bytes=${start}-${start+expected.byteLength-1}`},cache:'default'},options.fallbackTimeoutMs||30000);
    event({source:'pages',index:i,status:response.status,wireBytes:body.length});
    if(!response.ok)throw Error('FALLBACK_HTTP_'+response.status);
    if(response.status===200&&body.length===m.byteLength){
      if(await sha256(body)!==m.sha256)throw Error('FALLBACK_HASH_MISMATCH');
      for(let j=0;j<m.chunks.length;j++)parts.set(m.sha256+':'+m.chunkSize+':'+j,body.slice(j*m.chunkSize,j*m.chunkSize+m.chunks[j].byteLength));
      return body.slice(start,start+expected.byteLength);
    }
    if(!await verify(body,expected))throw Error('FALLBACK_HASH_MISMATCH');return body;
  }
  async function one(i){
    check();const expected=m.chunks[i],id=m.sha256+':'+m.chunkSize+':'+i;
    let bytes=parts.get(id);
    if(bytes&&await verify(bytes,expected))event({source:'cache',index:i,wireBytes:0});
    else{
      bytes=null;parts.delete(id);
      if(!disablePrimary){
        for(let attempt=0;attempt<=(options.primaryRetries??1);attempt++){
          try{bytes=await cloudflare(i,expected);break;}
          catch(error){check();if(error.accessDenied)throw error;event({source:'primary-error',index:i,reason:error.message||error.name});if(attempt===(options.primaryRetries??1))disablePrimary=true;}
        }
      }
      if(!bytes){check();bytes=await pages(i,expected);}
      parts.set(id,bytes);
    }
    check();result[i]=bytes;loaded+=bytes.byteLength;options.onProgress?.({loaded,total:m.byteLength,complete:loaded===m.byteLength});
  }
  async function runner(){while(next<m.chunks.length){check();const i=next++;try{await one(i);}catch(error){fatal=error;throw error;}}}
  const done=await Promise.allSettled([runner(),runner()]);
  const rejected=done.find(x=>x.status==='rejected');if(rejected)throw rejected.reason;
  const blob=new Blob(result,{type:'audio/mpeg'});
  if(blob.size!==m.byteLength||await sha256(await blob.arrayBuffer())!==m.sha256)throw Error('WHOLE_HASH_MISMATCH');
  return{blob,events,parts};
}
