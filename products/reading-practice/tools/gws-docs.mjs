import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

// Adapter kiểm thử Docs thật bằng profile gws đã có; không xuất OAuth hoặc nội dung học viên ra log.
export function gwsDocs(cliPath){
 async function call(method,params,body){
  const args=[cliPath,'docs','documents',method,'--params',JSON.stringify(params),...(body?['--json',JSON.stringify(body)]:[])];
  const {stdout}=await exec(process.execPath,args,{timeout:20000,maxBuffer:2*1024*1024,windowsHide:true});
  const value=JSON.parse(stdout);if(value.error){const error=new Error('Google Docs failed');error.code='DOC_RETRY';throw error;}return value;
 }
 return{read:documentId=>call('get',{documentId,includeTabsContent:true}),write:(documentId,plan)=>call('batchUpdate',{documentId},{requests:plan.requests,writeControl:{requiredRevisionId:plan.revisionId}})};
}
