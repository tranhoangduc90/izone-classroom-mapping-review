// Mô phỏng phiên bản đổi giữa hai lượt: dừng trước ghi đè; không gọi API thật.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, readInput } from '../ops/production-grading.mjs';
import { Readable } from 'node:stream';
const own={id:'ownK67workflow',name:'K67 · Kiểm bộ chấm'};
const before={...own,active:false,versionId:'original',nodes:[{id:'one',parameters:{url:'old'}}],connections:{},
  settings:{saveDataErrorExecution:'all',saveDataSuccessExecution:'all',saveManualExecutions:true}};
const candidate=structuredClone(before);candidate.nodes[0].parameters.url='new';
test('chỉ sửa baseline còn đúng phiên bản',()=>assert.equal(classify(before,before,candidate,own),'before'));
test('mất ACK nhưng candidate đã đọc lại không cần ghi lần nữa',()=>assert.equal(classify({...candidate,versionId:'updated'},before,candidate,own),'candidate'));
test('cùng nội dung nhưng bản trước đã đổi phiên bản phải kiểm lại',()=>assert.throws(()=>classify({...before,versionId:'changed'},before,candidate,own),/LIVE_CHANGED/));
test('sửa ngoài task không được ghi đè',()=>{const changed=structuredClone(before);changed.connections.other={};assert.throws(()=>classify(changed,before,candidate,own),/LIVE_CHANGED/)});
test('không sửa workflow đang nhận bài hoặc sai ID/tên',()=>{
  for(const patch of [{active:true},{id:'foreign'},{name:'K56'}])assert.throws(()=>classify({...before,...patch},before,candidate,own),/NOT_OWN_INACTIVE/);
});
test('không bỏ việc lưu execution',()=>assert.throws(()=>classify({...before,settings:{}},before,candidate,own),/RETENTION_CHANGED/));
test('không nhận dữ liệu ghim được thêm sau backup',()=>assert.throws(()=>classify({...before,pinData:{one:[{json:{}}]}},before,candidate,own),/PIN_DATA_CHANGED/));
test('JSON lớn giữ nguyên tiếng Việt khi byte UTF-8 bị chia giữa chunks',async()=>{
  const value={code:'// Nhận bài viết và kiểm đúng người học.\n'.repeat(1200)};
  const bytes=Buffer.from(JSON.stringify(value));
  const chunks=Array.from(bytes,byte=>Buffer.from([byte]));
  assert.notEqual(JSON.parse(chunks.map(chunk=>chunk.toString()).join('')).code,value.code);
  assert.deepEqual(await readInput(Readable.from(chunks)),value);
});
