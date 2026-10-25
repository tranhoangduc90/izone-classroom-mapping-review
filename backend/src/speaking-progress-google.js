import {readFileSync} from 'node:fs';

function loadCredentials(file){
  try{
    const data=JSON.parse(readFileSync(file,'utf8'));
    const keys=['clientId','clientSecret','refreshToken'];
    if(keys.some(k=>typeof data[k]!=='string'||!data[k].trim()))throw new Error();
    return Object.fromEntries(keys.map(k=>[k,data[k]]));
  }catch{throw new Error('DOC_PROGRESS_GOOGLE_CONFIG_INVALID');}
}

// Fixed Google endpoints, same authorized account; separate from the read-only opening adapter.
export function createSpeakingProgressGoogle({credentialFile,credentials,call=fetch}) {
  const auth=credentials||loadCredentials(credentialFile);let token,refreshing;
  async function access(){
    if(token?.until>Date.now()+60000)return token.value;
    if(!refreshing)refreshing=(async()=>{
      const response=await call('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),
        headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:auth.clientId,client_secret:auth.clientSecret,refresh_token:auth.refreshToken})});
      const data=await response.json();if(!response.ok||!data.access_token||!Number.isFinite(Number(data.expires_in)))throw new Error('DOC_GOOGLE_AUTH_UNAVAILABLE');
      token={value:data.access_token,until:Date.now()+Number(data.expires_in)*1000};return token.value;
    })().finally(()=>{refreshing=null;});
    return refreshing;
  }
  async function request(id,body){
    if(!/^[A-Za-z0-9_-]{5,120}$/.test(id))throw new Error('DOC_IDENTITY_MISMATCH');
    for(let n=0;n<2;n++){
      const value=await access();
      const response=await call('https://docs.googleapis.com/v1/documents/'+encodeURIComponent(id)+(body?':batchUpdate':'?includeTabsContent=true'),
        {method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+value,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      if(response.status===401&&n===0){if(token?.value===value)token=null;continue;}
      if(!response.ok)throw new Error('DOC_HTTP_'+response.status);
      return response.json();
    }
    throw new Error('DOC_GOOGLE_AUTH_UNAVAILABLE');
  }
  return {get:id=>request(id),write:(id,body)=>request(id,body)};
}
