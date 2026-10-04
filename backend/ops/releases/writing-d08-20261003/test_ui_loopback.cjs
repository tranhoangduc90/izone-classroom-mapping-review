// Cổng đã bận phải chuyển cổng; lỗi khác giữ nguyên, không bỏ guard trình duyệt.
const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {randomInt}=require('node:crypto');
const {listenLoopback}=require('./ui-canary.cjs');
const close=server=>new Promise(resolve=>server.close(resolve));
test('Real localhost server uses high browser-safe port and retries occupied owned port',async()=>{
 const busy=createServer((_,response)=>response.end('busy'));
 const subject=createServer((_,response)=>response.end('owned fixture'));
 try {
  const busyPort=await listenLoopback(busy);let choices=0;
  const port=await listenLoopback(subject,()=>++choices===1?busyPort:randomInt(49152,65536));
  assert.ok(port>=49152&&port<=65535);assert.notEqual(port,busyPort);assert.ok(choices>=2);
  const response=await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(3000)});
  assert.equal(await response.text(),'owned fixture');
 }finally{if(subject.listening)await close(subject);if(busy.listening)await close(busy);}
});
test('Unsafe port is rejected before listening',async()=>{
 const server=createServer();await assert.rejects(listenLoopback(server,()=>4045));assert.equal(server.listening,false);
});
