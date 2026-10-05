// Payload giả kiểm fence trước bridge; không gọi API và không nhận UUID ngoài fixture.
const test=require('node:test');const assert=require('node:assert/strict');
const {validatePayload}=require('./ui-canary.cjs');
const identity={attempt_id:'00000000-0000-4000-8000-000000000808'};
const payload={attemptToken:identity.attempt_id,action:'draft',task1:'Một',task2:'Hai',baseRevision:0};
test('start/draft đúng UUID và cả hai Tasks được phép',()=>{validatePayload(payload,identity);validatePayload({...payload,action:'start',baseRevision:undefined},identity);});
test('UUID ngoài fixture bị chặn trước bridge',()=>assert.throws(()=>validatePayload({...payload,attemptToken:'00000000-0000-4000-8000-000000000809'},identity)));
test('submit/result/grade không bao giờ qua bridge',()=>{for(const action of ['submit','result','regrade',''])assert.throws(()=>validatePayload({...payload,action},identity));});
test('missing/invalid base bị chặn; không tự lấy version mới',()=>{for(const baseRevision of [undefined,null,-1,1.5,'0',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validatePayload({...payload,baseRevision},identity));});
test('thiếu một Task hoặc sai UUID fixture bị chặn',()=>{assert.throws(()=>validatePayload({...payload,task2:undefined},identity));assert.throws(()=>validatePayload(payload,{attempt_id:'not-uuid'}));});
