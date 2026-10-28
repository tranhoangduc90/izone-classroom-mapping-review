import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseFormDefinition} from '../src/learning-contracts.js';
import {validateAuthoringPayload,copyAuthoringPayload} from '../src/learning-form-authoring.js';
import {gradeLearningSubmission,buildStudentQuizResult,stableStringify} from '../src/learning-domain.js';

function fixture(){
 const formVersionId=randomUUID(),blankId=randomUUID(),item=(position,kind)=>({kind,itemFamilyId:randomUUID(),itemVersionId:randomUUID(),position,prompt:'Nội dung giả '+position,
  interactionType:'short_text',layoutType:'numbered_short_texts',pedagogicalTypeCode:'sentence_completion',graderType:kind==='survey'?'none':'accepted_text_sequence',maxScore:kind==='survey'?0:1,
  skillCodes:['general'],options:[],interactionConfig:{responseCount:1,blankIds:[position===1?blankId:randomUUID()],sentenceLines:[{title:'',parts:['at the ','.']}]}});
 const a=item(1,'exercise'),b=item(2,'survey');
 return {definition:{schemaVersion:'FormDefinitionV1',formVersionId,title:'Phiếu trộn từng câu',kind:'mixed',answerReleasePolicy:'hidden',blocks:[{blockId:randomUUID(),kind:'survey',checkpoint:1,title:'Một phần có hai chế độ',items:[a,b]}]},
  gradingKey:{schemaVersion:'FormGradingKeyV1',formVersionId,graderVersion:1,items:{[a.itemVersionId]:{graderType:'accepted_text_sequence',acceptedBySlot:[['moment','instant']]}},groups:{},
   referenceAnswersBySlot:{[b.itemVersionId]:[['reference one','reference two']]},authoringState:{[a.itemVersionId]:{sources:{[blankId]:'moment'},answerRows:{[blankId]:[{id:randomUUID(),value:'moment'},{id:randomUUID(),value:'instant'}]}}}}};
}
test('T15: một phần trộn mode từng câu, chỉ Bài tập vào mẫu số và tham khảo Khảo sát được lọc riêng',()=>{
 const p=validateAuthoringPayload({...fixture(),requireAnswers:true}),[a,b]=p.definition.blocks[0].items;
 const result=gradeLearningSubmission({...p,responses:{[a.itemVersionId]:['instant'],[b.itemVersionId]:['câu trả lời giả']}}),visible=buildStudentQuizResult(result,p.definition);
 assert.equal(result.summary.maxScore,1);assert.equal(result.summary.scoreEarned,1);
 assert.equal(visible.items[0].expectedAnswer,undefined);assert.ok(visible.items[0].slotResults.every(s=>s.expectedAnswer===undefined));
 assert.equal(visible.items[1].verdict,'ungraded');assert.equal(visible.items[1].maxScore,0);
 assert.deepEqual(visible.items[1].referenceSlots[0].expectedAnswer,['reference one','reference two']);
 assert.equal(JSON.stringify(visible).includes('sources'),false);
});
test('T15: copy đổi đủ mã câu, ô và metadata; giữ bản gốc bất biến',()=>{
 const p=fixture(),original=p.definition.blocks[0].items[0],blank=original.interactionConfig.blankIds[0];p.gradingKey.authoringState[original.itemVersionId].exerciseShape=JSON.stringify({blanks:[blank],prompt:'Giữ chữ '+blank});
 const before=stableStringify(p),copy=copyAuthoringPayload(p),a=p.definition.blocks[0].items[0],b=copy.definition.blocks[0].items[0];
 assert.equal(stableStringify(p),before);assert.notEqual(b.itemVersionId,a.itemVersionId);assert.notEqual(b.interactionConfig.blankIds[0],a.interactionConfig.blankIds[0]);
 assert.equal(copy.gradingKey.authoringState[b.itemVersionId].sources[b.interactionConfig.blankIds[0]],'moment');
 const shape=JSON.parse(copy.gradingKey.authoringState[b.itemVersionId].exerciseShape);assert.deepEqual(shape.blanks,b.interactionConfig.blankIds);assert.equal(shape.prompt,'Giữ chữ '+blank);
 assert.notEqual(copy.gradingKey.authoringState[b.itemVersionId].answerRows[b.interactionConfig.blankIds[0]][0].id,p.gradingKey.authoringState[a.itemVersionId].answerRows[a.interactionConfig.blankIds[0]][0].id);
});
test('T15: hàng đáp án trống giữ trong nháp, không được duyệt phát; phiếu cũ không tự thêm mode',()=>{
 const p=fixture(),a=p.definition.blocks[0].items[0];p.gradingKey.authoringState[a.itemVersionId].answerRows[a.interactionConfig.blankIds[0]].push({id:randomUUID(),value:'  '});
 assert.doesNotThrow(()=>validateAuthoringPayload({...p,allowIncomplete:true}));assert.throws(()=>validateAuthoringPayload({...p,requireAnswers:true}));
 const copied=copyAuthoringPayload(p),ca=copied.definition.blocks[0].items[0];assert.equal(copied.gradingKey.authoringState[ca.itemVersionId].answerRows[ca.interactionConfig.blankIds[0]].at(-1).value,'  ');
 const legacy=fixture().definition;for(const block of legacy.blocks){delete block.kind;for(const item of block.items)delete item.kind;}
 const parsed=parseFormDefinition(legacy);assert.equal(parsed.blocks[0].kind,undefined);assert.ok(parsed.blocks[0].items.every(i=>i.kind===undefined));
});
test('T15: nội dung input riêng phải khớp khóa thực chấm, không lưu/xem thử một đáp án khác',()=>{
 const p=fixture(),a=p.definition.blocks[0].items[0];p.gradingKey.authoringState[a.itemVersionId].answerRows[a.interactionConfig.blankIds[0]][0].value='một key khác';
 assert.throws(()=>validateAuthoringPayload({...p,allowIncomplete:true}),/chưa khớp khóa chấm/);assert.throws(()=>validateAuthoringPayload(p),/chưa khớp khóa chấm/);
});
