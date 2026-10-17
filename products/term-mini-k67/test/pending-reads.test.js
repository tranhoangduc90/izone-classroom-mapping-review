import test from 'node:test';
import assert from 'node:assert/strict';
import {createPendingReads,createRequestReads} from '../src/pending-reads.js';
import {createContextGuard} from '../src/context-guard.js';

// Nguồn giả cho phép đổi kết quả/lỗi; kiểm khóa, giới hạn bộ nhớ và tuổi quyền.
test('Dữ liệu chỉ dùng lại trong cùng request và đúng khóa, request mới đọc lại',async()=>{
  const read=createRequestReads(),a={},b={};let calls=0;
  const source=()=>++calls;
  assert.equal(await read(a,'student:A',source),1);
  assert.equal(await read(a,'student:A',source),1);
  assert.equal(await read(a,'student:B',source),2);
  assert.equal(await read(b,'student:A',source),3);
});
test('Vượt số mục chờ vẫn đọc được và không nhập hai khóa khác nhau',async()=>{
  const read=createPendingReads({maxEntries:1});let resolve,calls=0;
  const first=read('A',()=>new Promise(r=>{calls++;resolve=r;}));
  const same=read('A',()=>assert.fail('Không đọc trùng'));
  assert.equal(await read('B',()=>++calls),2);
  resolve('A');assert.equal(await first,'A');assert.equal(await same,'A');
  assert.equal(await read('A',()=>++calls),3);
});
test('Dùng lại timestamp trong request vẫn từ chối khi vượt hạn, không kéo dài quyền',async()=>{
  let now=Date.now(),calls=0;const captured=now,req={};
  const guard=createContextGuard({now:()=>now,pool:{query:async()=>{calls++;return{rows:[{captured_at:new Date(captured)}]};}}});
  const call=()=>new Promise(resolve=>guard(req,{status(n){this.code=n;return this;},json(){resolve(this.code);}},()=>resolve(200)));
  assert.equal(await call(),200);now+=120001;assert.equal(await call(),503);assert.equal(calls,1);
});
