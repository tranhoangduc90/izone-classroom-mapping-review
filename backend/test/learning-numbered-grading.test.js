// Dữ liệu giả: chấm độc lập từng ô, không gắn đáp án theo thứ tự câu hỏi hoặc lớp khác.
import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeLearningSubmission,buildStudentQuizResult} from '../src/learning-domain.js';
import {validateAuthoringPayload,copyAuthoringPayload} from '../src/learning-form-authoring.js';
import {fixture} from './fixtures/numbered-grading.js';
import {buildQuestionAnalytics} from '../src/learning-question-analytics.js';

test('12 ô: điểm riêng từng vị trí; sai và bỏ trống vẫn giữ mẫu số 12',()=>{
 const f=fixture(),responses={};
 for(const item of f.items)responses[item.itemVersionId]=f.gradingKey.items[item.itemVersionId].acceptedBySlot.map(row=>row[0]);
 responses[f.items[0].itemVersionId][1]='sai';responses[f.items[1].itemVersionId][4]='';
 const result=gradeLearningSubmission({...f,responses});
 assert.equal(result.summary.scoreEarned,10);assert.equal(result.summary.maxScore,12);
 assert.equal(result.items[0].verdict,'partial');assert.equal(result.items[0].scoreEarned,3);
 assert.equal(result.items[1].slotResults[4].answerState,'blank');assert.equal(result.items[1].slotResults[4].verdict,'incorrect');
 assert.equal(result.typeStats[0].total,12);assert.equal(result.typeStats[0].correct,10);
 assert.equal(result.items.flatMap(i=>i.slotResults).length,12);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});
test('Cả nhóm không gửi hoặc 12 ô trắng: nhận 0/12, không rút mẫu số',()=>{
 const f=fixture();
 for(const responses of [{},Object.fromEntries(f.items.map(i=>[i.itemVersionId,Array(i.maxScore).fill('')]))]){
  const r=gradeLearningSubmission({...f,responses});assert.equal(r.summary.scoreEarned,0);assert.equal(r.summary.maxScore,12);
  assert.equal(r.items.flatMap(i=>i.slotResults).filter(s=>s.verdict==='incorrect'&&s.answerState==='blank').length,12);
 }
});
test('Chuẩn hóa chữ hoa, Unicode, khoảng trắng; nhận đáp án thay thế đúng ô, không bỏ dấu',()=>{
 const f=fixture(),item=f.items[2],key=f.gradingKey.items[item.itemVersionId];key.acceptedBySlot=[['Mệnh đề chính','mệnh đề'],['Nội dung']];
 const r=gradeLearningSubmission({...f,responses:{[item.itemVersionId]:['  MỆNH   ĐỀ  '.normalize('NFD'),'noi dung']}});
 assert.equal(r.items[2].scoreEarned,1);assert.equal(r.items[2].slotResults[0].verdict,'correct');assert.equal(r.items[2].slotResults[1].verdict,'incorrect');
});
test('Đảo đáp án hoặc lặp đáp án không ăn điểm của ô khác',()=>{
 const f=fixture(),item=f.items[2],values=f.gradingKey.items[item.itemVersionId].acceptedBySlot.map(a=>a[0]);
 assert.equal(gradeLearningSubmission({...f,responses:{[item.itemVersionId]:values.toReversed()}}).items[2].scoreEarned,0);
 assert.equal(gradeLearningSubmission({...f,responses:{[item.itemVersionId]:[values[0],values[0]]}}).items[2].scoreEarned,1);
});
test('Khóa chấm đủ từng ô mới duyệt; copy giữ đáp án, đổi ID đúng nguồn',()=>{
 const f=fixture();assert.equal(validateAuthoringPayload({...f,requireAnswers:true}).missingAnswers.length,0);
 const copy=copyAuthoringPayload(f);assert.notEqual(copy.definition.formVersionId,f.definition.formVersionId);
 assert.deepEqual(Object.values(copy.gradingKey.items).map(k=>k.acceptedBySlot),Object.values(f.gradingKey.items).map(k=>k.acceptedBySlot));
 f.gradingKey.items[f.items[0].itemVersionId].acceptedBySlot.pop();
 assert.throws(()=>validateAuthoringPayload({...f,requireAnswers:true}),e=>e.code==='DRAFT_ANSWER_INVALID');
 assert.throws(()=>gradeLearningSubmission({...f,responses:{}}),e=>e.code==='GRADING_KEY_MISMATCH');
});
test('Nhóm ô chỉ nhận mảng đúng chiều; phần tử thừa hoặc thiếu không được gắn lệch',()=>{
 const f=fixture(),id=f.items[0].itemVersionId;
 for(const value of ['Giả',['a'],['a','b','c','d','e']])assert.throws(()=>gradeLearningSubmission({...f,responses:{[id]:value}}),e=>e.code==='NUMBERED_TEXT_GROUP_INVALID');
});
test('Nháp đang gõ được lưu, nhưng thiếu đáp án một ô thì chưa duyệt hoặc chấm',()=>{
 const f=fixture();f.gradingKey.items[f.items[0].itemVersionId].acceptedBySlot[0]=[];
 assert.equal(validateAuthoringPayload({...f,allowIncomplete:true}).definition.blocks.length,1);
 assert.throws(()=>validateAuthoringPayload({...f,requireAnswers:true}),e=>e.code==='DRAFT_ANSWER_INVALID');
 assert.throws(()=>gradeLearningSubmission({...f,responses:{}}),e=>e.code==='GRADING_KEY_MISMATCH');
});
test('Ẩn đáp án: không rò key trong kết quả từng ô; mở lại đúng quyền mới hiện',()=>{
 const f=fixture(),internal=gradeLearningSubmission({...f,responses:{}});
 const hidden=buildStudentQuizResult(internal,{...f.definition,answerReleasePolicy:'hidden'});
 assert.equal(JSON.stringify(hidden).includes('Giả 1 0'),false);
 assert.equal(hidden.items[0].slotResults[0].expectedAnswer,undefined);
 const released=buildStudentQuizResult(internal,f.definition);assert.deepEqual(released.items[0].slotResults[0].expectedAnswer,['Giả 1 0']);
});
test('Thống kê giảng viên: nhóm có ô sai/trống được tìm thấy, không gọi là chưa chấm',()=>{
 const f=fixture(),item=f.items[0];
 const students=['correct','partial','incorrect'].map((verdict,index)=>({studentRef:'fake-'+index,submissionId:'sub-'+index,
  gradingStatus:'complete',responseItems:[{itemVersionId:item.itemVersionId,answerState:index===2?'blank':'answered'}],
  gradingItems:[{itemVersionId:item.itemVersionId,verdict}]}));
 const row=buildQuestionAnalytics({assignmentId:'fake',definition:f.definition,students}).items[0];
 assert.equal(row.objective,true);assert.equal(row.gradingUnit,'text_slots');assert.equal(row.counts.correct,1);
 assert.equal(row.counts.incorrect,2);assert.equal(row.counts.pending,0);assert.equal(row.counts.ungraded,0);
});
