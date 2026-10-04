// Giả lỗi/hang khi đóng Chrome: ghi unknown và giữ fixture, không gửi cleanup.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {closeContexts,finalizeReceipt}=require('./ui-canary.cjs');
test('Close error/hang returns unknown closing state, still attempts browser close',async()=>{
 let browserClosed=false;
 const result=await closeContexts([{tracing:{stop:async()=>{}},close:async()=>{throw Error('close failed');}},
 {tracing:{stop:async()=>{}},close:()=>new Promise(()=>{})}],{close:async()=>{browserClosed=true;}},'unused',10);
 assert.equal(browserClosed,true);assert.equal(result.closed,false);assert.equal(result.errors.length,2);
});
test('Unclosed contexts persist unknown receipt and block cleanup',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'d08-close-'));let cleanup=0;
 const receipt={status:'passed'};
 try {
  await assert.rejects(finalizeReceipt({receipt,bridge:{cleanup:async()=>{cleanup++;}},identity:{},scope:'offline_actual_sql',
    pending:0,server:null,evidenceDir:folder,errors:[],contextsClosed:false}),/Chrome chưa đóng/);
  const saved=JSON.parse(await fs.readFile(path.join(folder,'receipt.json'),'utf8'));
  assert.equal(cleanup,0);assert.equal(saved.status,'unknown');assert.equal(saved.contexts_closed,false);
 }finally{await fs.rm(folder,{recursive:true});}
});
