// Built-in HTTP client for isolated native tests; sends every request through the real Express server.
import http from 'node:http';
const servers=new Map();
export function request(app,{timeoutMs=10000}={}) {
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('NATIVE_HTTP_TIMEOUT_INVALID');
 if(!servers.has(app))servers.set(app,new Promise(resolve=>{const server=http.createServer(app).listen(0,'127.0.0.1',()=>resolve(server));}));
 const create=(method,path)=>{
  const headers={},params=new URLSearchParams();let body,pending;
  const chain={set(key,value){headers[key]=value;return chain;},query(value){for(const [k,v] of Object.entries(value))params.set(k,v);return chain;},send(value){body=value;return chain;},
   then(resolve,reject){pending??=(async()=>{const server=await servers.get(app);const query=params.size?(path.includes('?')?'&':'?')+params:'';
    const response=await fetch('http://127.0.0.1:'+server.address().port+path+query,{method,headers:{...headers,...(body!==undefined?{ 'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeoutMs)});
    const text=await response.text(),isJson=response.headers.get('content-type')?.includes('json');return{status:response.status,body:isJson?JSON.parse(text):{},text,headers:Object.fromEntries(response.headers)};})();return pending.then(resolve,reject);}};
  return chain;
 };
 return{get:path=>create('GET',path),post:path=>create('POST',path)};
}
export async function closeNativeHttp(){for(const pending of servers.values()){const server=await pending;await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});}servers.clear();}
