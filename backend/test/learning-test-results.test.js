import assert from 'node:assert/strict';
import test from 'node:test';
import { createLearningTestResultReader } from '../src/learning-test-results.js';

const studentRef = '21000000-0000-4000-8000-000000000003';
const input = { classId: '990000567', studentRef, testSlugs: ['term-test-2'] };

test('Journey đọc Listening/Reading khi Test hoàn tất; Writing cập nhật khi điểm cuối sẵn sàng', async () => {
  const calls = [];
  let writingScore = null;
  const reader = createLearningTestResultReader({ pool: { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [{ test_slug: 'term-test-2', title: 'Term Test 2',
      result_json: { listening: { correct: 30, total: 40, band: 7 },
        reading: { correct: 28, total: 40, band: 6.5 },
        secretAnswer: 'không được đưa ra' },
      completed_at: new Date('2026-09-20T12:00:00Z'),
      writing_submitted_at: new Date('2026-09-21T12:00:00Z'),
      writing_score: writingScore }] };
  } } });
  const pending = (await reader(input))[0];
  assert.deepEqual(pending.listening, { correct: 30, total: 40, band: 7 });
  assert.deepEqual(pending.reading, { correct: 28, total: 40, band: 6.5 });
  assert.deepEqual(pending.writing, { status: 'pending', score: null });
  assert.doesNotMatch(JSON.stringify(pending), /secretAnswer|không được đưa ra/u);
  writingScore = '6.5';
  const ready = (await reader(input))[0];
  assert.deepEqual(ready.writing, { status: 'ready', score: 6.5 });
  assert.deepEqual(calls[0].params, ['990000567', studentRef, ['term-test-2']]);
  assert.match(calls[0].sql, /count\(DISTINCT erp_student_contact_id\) = 1/u);
  assert.match(calls[0].sql, /final.status = 'ready'/u);
  assert.match(calls[0].sql, /attempt.completed_at IS NOT NULL/u);
});

test('Journey không nhận kết quả khác bài hoặc đầu vào định danh sai', async () => {
  const reader = createLearningTestResultReader({ pool: { async query() {
    return { rows: [{ test_slug: 'term-test-1', title: 'Sai bài', result_json: {},
      completed_at: new Date(), writing_score: null }] };
  } } });
  await assert.rejects(() => reader(input), /TEST_RESULT_ROW_INVALID/u);
  await assert.rejects(() => reader({ ...input, studentRef: 'không hợp lệ' }),
    /TEST_RESULT_INPUT_INVALID/u);
});

test('O04: đọc kết quả cả lớp chỉ gọi DB một lần và vẫn tách học viên/điểm Writing muộn',async()=>{
  const student2='21000000-0000-4000-8000-000000000004';
  let calls=0;
  const reader=createLearningTestResultReader({pool:{async query(sql,params){
    calls+=1;assert.deepEqual(params[1],[studentRef,student2]);
    assert.match(sql,/requested_student\.student_ref/u);
    return {rows:[studentRef,student2].map((ref,index)=>({student_ref:ref,test_slug:'term-test-2',title:'Term Test 2',
      result_json:{reading:{correct:20+index,total:40}},completed_at:new Date('2026-10-01T01:00:00Z'),
      writing_submitted_at:new Date('2026-10-01T01:00:00Z'),writing_score:index?6:null}))};
  }}});
  const results=await reader.readClass({...input,studentRefs:[studentRef,student2]});
  assert.equal(calls,1);assert.equal(results[0].studentRef,studentRef);
  assert.equal(results[0].result.writing.status,'pending');assert.equal(results[1].result.writing.score,6);
  await assert.rejects(()=>reader.readClass({...input,studentRefs:[studentRef,studentRef]}),/INPUT_INVALID/u);
});
