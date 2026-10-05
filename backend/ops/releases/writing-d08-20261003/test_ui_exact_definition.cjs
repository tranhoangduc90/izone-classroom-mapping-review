// Nhận tên giao diện và đồng hồ SQL giả; kiểm đúng đề, thời lượng và từ chối sai lệch.
// Không gọi Chrome, Docker, API hoặc dữ liệu học viên.
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixtureSpec,validateWritingClock}=require('./ui-canary.cjs');
test('Mỗi giao diện dùng đúng đề và thời lượng Writing hiện hành',()=>{
 for(const [client,slug,minutes] of [
  ['shared','term-test-1',40],['k56-shared','term-test-1-k56',55],
  ['k56-mini-shared','mini-test-k56',15],['k56-test2-shared','term-test-2-k56',30]
 ]) assert.deepEqual(fixtureSpec(client),{slug,minutes});
 assert.throws(()=>fixtureSpec('other'));
});
test('Đồng hồ SQL phải có đúng số phút giữa bắt đầu và hạn nộp',()=>{
 for(const minutes of [40,55,15,30]) {
  const startedAt='2026-10-04T10:00:00.000Z';
  const deadlineAt=new Date(Date.parse(startedAt)+minutes*60000).toISOString();
  validateWritingClock({started:true,startedAt,deadlineAt},minutes);
  assert.throws(()=>validateWritingClock({started:true,startedAt,deadlineAt},minutes+1));
 }
});
test('Thiếu giờ, thiếu offset và deadline giả 60 phút phải bị chặn',()=>{
 for(const value of [
  {started:true,startedAt:null,deadlineAt:null},
  {started:true,startedAt:'2026-10-04T10:00:00',deadlineAt:'2026-10-04T10:15:00Z'},
  {started:true,startedAt:'2026-10-04T10:00:00Z',deadlineAt:'2026-10-04T11:00:00Z'},
  {started:false,startedAt:'2026-10-04T10:00:00Z',deadlineAt:null}
 ]) assert.throws(()=>validateWritingClock(value,15));
 validateWritingClock({started:false,startedAt:null,deadlineAt:null},15);
});
