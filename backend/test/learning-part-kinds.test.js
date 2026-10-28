// Phiếu trộn hai loại phần: khảo sát không chấm, đáp án chỉ đọc từ kết quả nộp thành công.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateAuthoringPayload} from '../src/learning-form-authoring.js';
import {parseFormDefinition} from '../src/learning-contracts.js';
import {gradeLearningSubmission,buildStudentQuizResult} from '../src/learning-domain.js';

function payload(){
  const formVersionId=randomUUID(),make=(position)=>({itemFamilyId:randomUUID(),itemVersionId:randomUUID(),position,
    prompt:'Chọn những phương án phù hợp',interactionType:'multi_choice_group',layoutType:'multiple_choice_cards',
    pedagogicalTypeCode:'practice',graderType:'none',maxScore:0,skillCodes:['general'],
    options:Array.from({length:15},(_,i)=>({id:'o'+i,label:'Phương án '+i})),interactionConfig:{}});
  const exercise=make(1),survey=make(2);exercise.graderType='exact_option_set';exercise.maxScore=1;exercise.interactionConfig.maxSelections=2;
  return {definition:{schemaVersion:'FormDefinitionV1',formVersionId,title:'Phiếu trộn',kind:'mixed',answerReleasePolicy:'hidden',blocks:[
    {blockId:randomUUID(),checkpoint:1,title:'Bài tập',kind:'exercise',items:[exercise]},
    {blockId:randomUUID(),checkpoint:2,title:'Khảo sát',kind:'survey',items:[survey]}]},
    gradingKey:{schemaVersion:'FormGradingKeyV1',formVersionId,graderVersion:1,groups:{},
      items:{[exercise.itemVersionId]:{graderType:'exact_option_set',expectedOptionIds:['o0','o1']}},
      referenceAnswers:{[survey.itemVersionId]:['Nội dung tham khảo do giáo viên nhập']}}};
}
test('R18/R27: phần trộn giữ điểm bài tập, khảo sát chọn hơn mười phương án vẫn không vào mẫu số',()=>{
  const p=validateAuthoringPayload({...payload(),requireAnswers:true}),a=p.definition.blocks[0].items[0],b=p.definition.blocks[1].items[0];
  const result=gradeLearningSubmission({...p,responses:{[a.itemVersionId]:['o1','o0'],[b.itemVersionId]:b.options.map(o=>o.id)}});
  assert.equal(result.summary.maxScore,1);assert.equal(result.summary.scoreEarned,1);
  assert.equal(result.items[1].verdict,'ungraded');assert.equal(result.items[1].maxScore,0);
  const visible=buildStudentQuizResult(result,p.definition);
  assert.equal(visible.items[0].expectedAnswer,undefined);
  assert.deepEqual(visible.items[1].expectedAnswer,['Nội dung tham khảo do giáo viên nhập']);
  assert.throws(()=>gradeLearningSubmission({...p,responses:{[b.itemVersionId]:['o0','o0']}}),/Checklist/);
  assert.throws(()=>gradeLearningSubmission({...p,responses:{[b.itemVersionId]:['unknown']}}),/Checklist/);
});
test('R27: khảo sát không có đáp án không trả khung rỗng hoặc lời giải mồ côi',()=>{
  const p=payload(),b=p.definition.blocks[1].items[0];delete p.gradingKey.referenceAnswers;
  p.gradingKey.explanations={[b.itemVersionId]:'Không hiện khi chưa có đáp án tham khảo'};
  const visible=buildStudentQuizResult(gradeLearningSubmission({...p,responses:{}}),p.definition);
  assert.equal('expectedAnswer' in visible.items[1],false);assert.equal('explanation' in visible.items[1],false);
  assert.equal(visible.items[1].verdict,'ungraded');assert.equal(visible.summary.maxScore,1);
});
test('R19/R21/R24: máy chủ kiểm loại câu, kỹ năng và giới hạn suy từ khóa riêng',()=>{
  const p=payload(),a=p.definition.blocks[0].items[0];a.skillCodes=[];
  assert.throws(()=>validateAuthoringPayload({...p,allowIncomplete:true}),e=>e.code==='DRAFT_SKILL_REQUIRED');
  a.skillCodes=['general'];a.interactionConfig.maxSelections=3;
  assert.throws(()=>validateAuthoringPayload(p),e=>e.code==='DRAFT_SELECTION_LIMIT_MISMATCH');
  a.interactionConfig={};a.interactionType='long_text';a.layoutType='plain_prompt';a.options=[];a.graderType='none';a.maxScore=0;
  assert.throws(()=>validateAuthoringPayload(p),e=>e.code==='DRAFT_PART_TYPE_INVALID');
});
test('R27: sửa payload để chấm khảo sát bị chặn ngay tại schema runtime',()=>{
  const p=payload(),b=p.definition.blocks[1].items[0];b.graderType='exact_option_set';b.maxScore=1;
  assert.throws(()=>parseFormDefinition(p.definition),/Khảo sát/);
});
test('Tương thích: definition cũ không tự có kind hoặc đổi luật chấm',()=>{
  const p=payload();for(const block of p.definition.blocks)delete block.kind;
  const parsed=parseFormDefinition(p.definition);assert.equal('kind' in parsed.blocks[0],false);
  assert.equal(parsed.blocks[0].items[0].graderType,'exact_option_set');
});
