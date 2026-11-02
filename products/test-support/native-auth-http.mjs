// Native Node HTTP headers retain Set-Cookie arrays for the unmodified auth assertions.
import http from 'node:http';
const servers=new Map();
export function request(app){
 if(!servers.has(app))servers.set(app,new Promise(resolve=>{const server=http.createServer(app).listen(0,'127.0.0.1',()=>resolve(server));}));
 const create=(method,path)=>{
  const headers={};let body,pending;
  const chain={set(key,value){headers[key]=value;return chain;},send(value){body=value;return chain;},then(resolve,reject){
   pending??=(async()=>{const server=await servers.get(app);return new Promise((yes,no)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})}},res=>{
     let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('error',no);res.on('end',()=>{try{yes({status:res.statusCode,headers:res.headers,text,body:res.headers['content-type']?.includes('json')?JSON.parse(text):{}});}catch(error){no(error);}});
    });req.on('error',no);req.setTimeout(10000,()=>req.destroy(Error('NATIVE_AUTH_HTTP_TIMEOUT')));req.end(body===undefined?undefined:JSON.stringify(body));
   });})();return pending.then(resolve,reject);
  }};return chain;
 };
 return{get:path=>create('GET',path),post:path=>create('POST',path),delete:path=>create('DELETE',path)};
}
export async function closeNativeAuthHttp(){for(const pending of servers.values()){const server=await pending;await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});}servers.clear();}
