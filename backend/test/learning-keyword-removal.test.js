// Dạng gạch chân đã bị gỡ: chặn tạo/nhập mới, giữ khả năng đọc dữ liệu lịch sử.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AUTHORING_TYPES,validateAuthoringPayload} from '../src/learning-form-authoring.js';
import {parseFormDefinition} from '../src/learning-contracts.js';
import {gradeLearningSubmission} from '../src/learning-domain.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
const fixture=()=>{const version=randomUUID(),id=randomUUID();return {definition:{schemaVersion:'FormDefinitionV1',formVersionId:version,title:'Lịch sử giả',kind:'mixed',blocks:[{blockId:randomUUID(),checkpoint:1,title:'Phần cũ',items:[{itemFamilyId:randomUUID(),itemVersionId:id,position:1,prompt:'Câu cũ',interactionType:'multi_choice_group',layoutType:'keyword_selection',pedagogicalTypeCode:'keyword_identification',graderType:'none',maxScore:0,required:true,skillCodes:['listening'],options:[{id:'w1',label:'same'},{id:'w2',label:'same'}],interactionConfig:{maxSelections:2}}]}]},gradingKey:{schemaVersion:'FormGradingKeyV1',formVersionId:version,graderVersion:1,items:{},groups:{}}};};
test('Không còn Gạch chân từ khóa trong danh mục và không nhận nháp mới',()=>{
 assert.equal(AUTHORING_TYPES.some(t=>t.code==='keyword_selection'),false);
 for(const allowIncomplete of [false,true])assert.throws(()=>validateAuthoringPayload({...fixture(),allowIncomplete}),e=>e.code==='DRAFT_TYPE_NOT_ALLOWED');
});
test('API tạo nháp từ khóa bị từ chối trước mọi lần ghi',async()=>{
 let queries=0;const service=createLearningFormDraftService({pool:{connect(){queries++;throw Error('Không được ghi');}}});
 await assert.rejects(service.create({classId:'1294',sessionNumber:11,operationId:randomUUID(),...fixture(),reviewer:{email:'owner@example.invalid'}}),e=>e.code==='DRAFT_TYPE_NOT_ALLOWED');assert.equal(queries,0);
});
test('Hồ sơ cũ vẫn đọc nguyên ID từ trùng chữ và không biến thành điểm chấm',()=>{
 const p=fixture(),definition=parseFormDefinition(p.definition),item=definition.blocks[0].items[0];
 const result=gradeLearningSubmission({...p,responses:{[item.itemVersionId]:['w2']}});
 assert.deepEqual(result.items[0].rawAnswer,['w2']);assert.equal(result.items[0].verdict,'ungraded');assert.equal(result.summary.maxScore,0);
});
