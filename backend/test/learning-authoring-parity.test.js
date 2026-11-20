// Đối chiếu các dạng đã duyệt ở demo với validation/chấm thật và chính sách giấu key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateAuthoringPayload} from '../src/learning-form-authoring.js';
import {gradeLearningSubmission,buildStudentQuizResult,evaluateCompleteness} from '../src/learning-domain.js';
function payload(){
 const formVersionId=randomUUID();const make=(layoutType,graderType,interactionType,interactionConfig={})=>({itemFamilyId:randomUUID(),itemVersionId:randomUUID(),position:1,prompt:'Câu thử',interactionType,pedagogicalTypeCode:'practice',layoutType,graderType,maxScore:1,options:[{id:'A',label:'Alpha'},{id:'B',label:'Beta'},{id:'C',label:'Gamma'}],interactionConfig});
 const multi=make('multiple_choice_cards','exact_option_set','multi_choice_group',{maxSelections:3}),matching=make('matching_pairs','exact_sequence','multi_choice_group',{matchingPrompts:['Một','Hai','Ba']}),short=make('plain_prompt','accepted_text','short_text');short.options=[];matching.position=2;short.position=3;
 return {definition:{schemaVersion:'FormDefinitionV1',formVersionId,title:'Phiếu',kind:'mixed',answerReleasePolicy:'hidden',blocks:[{blockId:randomUUID(),checkpoint:1,title:'Phần',items:[multi,matching,short]}]},gradingKey:{schemaVersion:'FormGradingKeyV1',formVersionId,graderVersion:1,groups:{},items:{[multi.itemVersionId]:{graderType:'exact_option_set',expectedOptionIds:['A','C']},[matching.itemVersionId]:{graderType:'exact_sequence',expectedOptionIds:['B','C','A']},[short.itemVersionId]:{graderType:'accepted_text',accepted:['colour','color'],normalization:{}}}}};
}

test('Nháp Thủy giữ phần trống và nội dung đang gõ; duyệt/phát vẫn từ chối cùng dữ liệu',()=>{
 const p=payload(),item=p.definition.blocks[0].items[0];item.prompt='';item.options[0].label='';p.definition.title='';
 p.definition.blocks.push({blockId:randomUUID(),checkpoint:2,title:'',items:[]});
 const saved=validateAuthoringPayload({...p,allowIncomplete:true});
 assert.equal(saved.definition.blocks.length,2);assert.equal(saved.definition.blocks[1].items.length,0);assert.equal(saved.definition.blocks[0].items[0].itemVersionId,item.itemVersionId);assert.equal(saved.definition.title,'');
 assert.throws(()=>validateAuthoringPayload({...p,requireAnswers:true}),/Nháp có trường cần sửa/);
 assert.throws(()=>validateAuthoringPayload({...p,allowIncomplete:true,requireAnswers:true}),/Nháp có trường cần sửa/);
});
test('Nháp chưa hoàn chỉnh vẫn chặn ID trùng, trường lạ và đáp án của câu khác',()=>{
 const p=payload();p.definition.blocks[0].items.push(structuredClone(p.definition.blocks[0].items[0]));
 assert.throws(()=>validateAuthoringPayload({...p,allowIncomplete:true}),/Nháp có trường cần sửa/);
 const q=payload();q.definition.inventedField=true;assert.throws(()=>validateAuthoringPayload({...q,allowIncomplete:true}),/Nháp có trường cần sửa/);
 const r=payload();r.gradingKey.items[randomUUID()]={graderType:'exact_option',expectedOptionId:'A'};assert.throws(()=>validateAuthoringPayload({...r,allowIncomplete:true}),/không tồn tại/);
});
test('Chọn nhiều so tập hợp; nối cặp giữ vị trí; điền từ chấp nhận nhiều cách viết',()=>{
 const p=validateAuthoringPayload({...payload(),requireAnswers:true}),[m,n,t]=p.definition.blocks[0].items;
 const responses={[m.itemVersionId]:['C','A'],[n.itemVersionId]:['B','C','A'],[t.itemVersionId]:'COLOR'};
 const result=gradeLearningSubmission({...p,responses});assert.equal(result.summary.scoreEarned,3);
 assert.equal(buildStudentQuizResult(result,p.definition).items.every(i=>i.expectedAnswer===undefined),true);
 responses[n.itemVersionId]=['C','B','A'];assert.equal(gradeLearningSubmission({...p,responses}).summary.scoreEarned,2);
 responses[n.itemVersionId]=['B','','A'];assert.equal(evaluateCompleteness(p.definition,responses).complete,false);
 responses[m.itemVersionId]=['A','A'];assert.throws(()=>gradeLearningSubmission({...p,responses}),/Checklist/);
});

test('lưu Nối cặp và nhóm ô lịch sử với chế độ rõ, giữ tham khảo riêng khỏi khóa chấm',()=>{
 const p=payload(),[multi,matching,short]=p.definition.blocks[0].items;
 matching.kind='exercise';matching.skillCodes=['general'];
 Object.assign(short,{kind:'exercise',layoutType:'numbered_short_texts',graderType:'accepted_text_sequence',maxScore:2,
   interactionConfig:{responseCount:2,responseLabels:['Một','Hai']},skillCodes:['general']});
 p.gradingKey.items[short.itemVersionId]={graderType:'accepted_text_sequence',acceptedBySlot:[['one'],['two']],normalization:{}};
 p.gradingKey.referenceAnswersBySlot={[short.itemVersionId]:[['gợi ý'],[]]};
 const validated=validateAuthoringPayload({...p,requireAnswers:true});
 assert.deepEqual(validated.gradingKey.referenceAnswersBySlot[short.itemVersionId],[['gợi ý'],[]]);
 matching.kind='survey';matching.graderType='none';matching.maxScore=0;delete p.gradingKey.items[matching.itemVersionId];
 assert.equal(validateAuthoringPayload({...p,requireAnswers:true}).definition.blocks[0].items[1].kind,'survey');
});
test('khảo sát nhiều lựa chọn giữ phương án loại trừ khi không có trần chọn',()=>{
 const p=payload(),item=p.definition.blocks[0].items[0];
 Object.assign(item,{kind:'survey',graderType:'none',maxScore:0,skillCodes:['general'],
   interactionConfig:{exclusiveOptionId:'C'}});
 delete p.gradingKey.items[item.itemVersionId];
 const checked=validateAuthoringPayload({...p,requireAnswers:true});
 assert.doesNotThrow(()=>gradeLearningSubmission({...checked,responses:{[item.itemVersionId]:['A','B']}}));
 assert.throws(()=>gradeLearningSubmission({...checked,responses:{[item.itemVersionId]:['A','C']}}),/Checklist/);
 Object.assign(item,{kind:'exercise',graderType:'exact_option_set',maxScore:1});
 item.interactionConfig.maxSelections=2;
 p.gradingKey.items[item.itemVersionId]={graderType:'exact_option_set',expectedOptionIds:['A','C']};
 assert.throws(()=>validateAuthoringPayload({...p,requireAnswers:true}),error=>error.code==='DRAFT_ANSWER_INVALID');
});
