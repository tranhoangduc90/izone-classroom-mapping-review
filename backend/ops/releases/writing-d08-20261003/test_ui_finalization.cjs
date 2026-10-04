// Kiểm ghi receipt khi dọn bài giả lỗi; bridge/server đều giả, không mở Chrome hay gọi hệ thống thật.
// Mỗi test giữ evidence riêng trên C; unknown phải còn trong file và server thử đã đóng.
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {finalizeReceipt}=require('./ui-canary.cjs');

async function fixture(){
 const evidenceDir=path.join('C:/Codex-Data/writing-d08-fix-20261003/ui-finalization-unit',randomUUID());
 await fs.mkdir(evidenceDir,{recursive:true});
 const identity={attempt_id:randomUUID(),marker:'CODEX_D08_fixture'};
 const destination={container:'fixture-only'};let cleanupCalls=0,closed=0;
 const bridge={binding:{destination},cleanup:async()=>{cleanupCalls++;return {status:'passed',...identity,destination,remaining:{attempt:0,marker:0,children:[0,0,0,0,0]}};}};
 const receipt={status:'passed',identity};
 const server={closeAllConnections(){},close(callback){closed++;callback();}};
 const packet={receipt,bridge,identity,scope:'production_fixture',pending:0,server,evidenceDir,errors:[]};
 return {packet,read:async()=>JSON.parse(await fs.readFile(path.join(evidenceDir,'receipt.json'),'utf8')),calls:()=>cleanupCalls,closed:()=>closed};
}

test('cleanup đúng: giữ passed và ghi đủ receipt',async()=>{
 const f=await fixture();await finalizeReceipt(f.packet);const r=await f.read();
 assert.equal(r.status,'passed');assert.equal(r.cleanup.remaining.attempt,0);assert.equal(f.closed(),1);
});
test('cleanup throw: unknown được lưu trước reject, server vẫn đóng',async()=>{
 const f=await fixture();f.packet.bridge.cleanup=async()=>{throw new Error('fixture-cleanup-failed');};
 await assert.rejects(finalizeReceipt(f.packet),/fixture-cleanup-failed/);const r=await f.read();
 assert.equal(r.status,'unknown');assert.equal(r.cleanup.status,'unknown');assert.equal(f.closed(),1);
});
test('pending HTTP: không cleanup và ghi unknown',async()=>{
 const f=await fixture();f.packet.pending=1;await assert.rejects(finalizeReceipt(f.packet),/HTTP/);
 assert.equal(f.calls(),0);assert.equal((await f.read()).status,'unknown');assert.equal(f.closed(),1);
});
test('thiếu cleanup: không biến thành passed',async()=>{
 const f=await fixture();delete f.packet.bridge.cleanup;await assert.rejects(finalizeReceipt(f.packet));
 assert.equal((await f.read()).status,'unknown');assert.equal(f.closed(),1);
});
test('readback cleanup còn child: giữ unknown',async()=>{
 const f=await fixture();const original=f.packet.bridge.cleanup;f.packet.bridge.cleanup=async()=>{const v=await original();v.remaining.children[4]=1;return v;};
 await assert.rejects(finalizeReceipt(f.packet));const r=await f.read();assert.equal(r.status,'unknown');assert.equal(r.cleanup.remaining.children[4],1);
});
test('cleanup sai marker: giữ receipt unknown',async()=>{
 const f=await fixture();const original=f.packet.bridge.cleanup;f.packet.bridge.cleanup=async()=>({...await original(),marker:'other'});
 await assert.rejects(finalizeReceipt(f.packet));assert.equal((await f.read()).status,'unknown');
});
test('business fail trước đó không bị cleanup đạt đổi thành pass',async()=>{
 const f=await fixture();f.packet.receipt.status='failed';await finalizeReceipt(f.packet);assert.equal((await f.read()).status,'failed');
});
test('đóng server lỗi vẫn ghi unknown',async()=>{
 const f=await fixture();f.packet.server.close=callback=>callback(new Error('fixture-close-failed'));
 await assert.rejects(finalizeReceipt(f.packet),/fixture-close-failed/);assert.equal((await f.read()).status,'unknown');
});
