// Kiểm thứ tự giữ request của bộ thử; không sửa timeout hoặc đồng hồ API thật.
// Nhận page giả, bảo đảm ACK xong mới nhả đồng hồ và lỗi luôn nhả đồng hồ.
const test=require('node:test');
const assert=require('node:assert/strict');
const {holdBrowserRequest}=require('./ui-canary.cjs');

function page(log) {
  return {
    async evaluate(){log.push('clock_read');return 123;},
    clock:{async pauseAt(value){assert.equal(value,123);log.push('paused');},
      async resume(){log.push('resumed');}}
  };
}

test('request bị giữ chỉ nhả đồng hồ sau khi đã giao ACK',async()=>{
  const log=[];
  const value=await holdBrowserRequest(page(log),async()=>{log.push('released');},
    async()=>{log.push('ack_fulfilled');return 'done';});
  assert.equal(value,'done');
  assert.deepEqual(log,['clock_read','paused','released','ack_fulfilled','resumed']);
});

test('ACK lỗi vẫn nhả đồng hồ và không tự gọi lại request',async()=>{
  const log=[];let sent=0;
  await assert.rejects(holdBrowserRequest(page(log),async()=>{},async()=>{
    sent++;throw new Error('response_unknown');
  }),/response_unknown/);
  assert.equal(sent,1);assert.equal(log.at(-1),'resumed');
});

test('không nhả được request thì giữ lỗi và không gửi sang API',async()=>{
  const log=[];let sent=0;
  await assert.rejects(holdBrowserRequest(page(log),async()=>{
    throw new Error('release_failed');
  },async()=>{sent++;}),/release_failed/);
  assert.equal(sent,0);assert.equal(log.at(-1),'resumed');
});
