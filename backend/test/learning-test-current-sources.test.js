import test from 'node:test';
import assert from 'node:assert/strict';
import {combineLearningTestReaders,createLearningTestSources} from '../src/learning-test-current-sources.js';
const record=(day,ref)=>({testSlug:'term-test-2',completedAt:`2026-10-${day}T10:00:00Z`,resultRef:ref,writing:{status:'ready'}});
function source(rows,detail){const reader=async()=>rows;reader.readStudent=reader;
  reader.readClass=async()=>rows.map(result=>({studentRef:'student-a',result}));
  reader.readWriting=async input=>rows.some(row=>row.resultRef===input.resultRef)?detail||null:null;return reader;}
test('nguồn hiện hành thắng lịch sử; Writing từ chối link bản cũ, đúng chủ và không hồi sinh khi nguồn lỗi',async()=>{
  const legacy=record('06','old'),current=record('28','new'),detail={resultRef:'new',tasks:[{taskNumber:2,score:6}]};
  const reader=combineLearningTestReaders([source([legacy]),source([current],detail)]);
  assert.deepEqual(await reader.readStudent({}),[current]);assert.deepEqual((await reader.readClass({}))[0].result,current);
  assert.equal(await reader.readWriting({testSlug:'term-test-2',resultRef:'old'}),null);
  assert.deepEqual(await reader.readWriting({testSlug:'term-test-2',resultRef:'new'}),detail);
  const broken=source([]);broken.readStudent=async()=>{throw Error('source unavailable');};
  await assert.rejects(()=>combineLearningTestReaders([source([legacy]),broken]).readStudent({}),/source unavailable/);
});
test('nguồn trùng thời điểm có thứ tự xác định; đọc lớp không ghép hai học viên',async()=>{
  const old=record('28','old'),current=record('28','new'),a=source([old]),b=source([current]);
  b.readClass=async()=>[{studentRef:'student-b',result:current}];
  const reader=combineLearningTestReaders([a,b]);assert.deepEqual(await reader({}),[current]);
  const rows=await reader.readClass({});assert.equal(rows.length,2);assert.equal(rows[0].studentRef,'student-a');assert.equal(rows[1].studentRef,'student-b');
});
test('server yêu cầu đủ nguồn K56/K67, pool nhỏ chỉ đọc và định tuyến schema K56',async()=>{
  assert.throws(()=>createLearningTestSources({config:{},legacyPool:{}}),/K56 và K67/);
  const pools=[];
  class Pool{constructor(options){this.options=options;this.queries=[];pools.push(this);}on(){}async query(text){this.queries.push(text);return {rows:[]};}async end(){this.closed=true;}}
  const service=createLearningTestSources({config:{learningTestK56DatabaseUrl:'private-k56',learningTestK67DatabaseUrl:'private-k67'},legacyPool:{query:async()=>({rows:[]})},Pool});
  await service.reader.readStudent({classId:'1294',studentRef:'10000000-0000-4000-8000-000000000001'});
  assert.equal(pools.length,2);assert.match(pools[0].options.options,/default_transaction_read_only=on/);assert.equal(pools[0].options.max,2);
  assert.match(pools[0].queries[0],/assessment_k56.term_test_attempt/);assert.doesNotMatch(pools[0].queries[0],/\bassessment\./);
  assert.match(pools[1].queries[0],/assessment.term_test_attempt/);await service.close();assert.ok(pools.every(pool=>pool.closed));
});
