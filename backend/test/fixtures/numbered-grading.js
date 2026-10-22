// Phiếu giả dùng chung cho ca chấm và API; không có dữ liệu lớp thật.
import crypto from 'node:crypto';
export function fixture(){
 const formVersionId=crypto.randomUUID(),items=[4,6,2].map((count,index)=>({
  itemFamilyId:crypto.randomUUID(),itemVersionId:crypto.randomUUID(),position:index+1,
  prompt:'Nhóm ô giả '+(index+1),interactionType:'short_text',layoutType:'numbered_short_texts',
  pedagogicalTypeCode:'sentence_completion',graderType:'accepted_text_sequence',maxScore:count,
  required:true,options:[],skillCodes:['reading'],interactionConfig:{responseCount:count}
 }));
 const definition={schemaVersion:'FormDefinitionV1',formVersionId,title:'Phiếu kiểm giả',kind:'quiz',answerReleasePolicy:'immediate',
  blocks:[{blockId:crypto.randomUUID(),checkpoint:1,title:'Reading',items}]};
 const key={schemaVersion:'FormGradingKeyV1',formVersionId,graderVersion:1,groups:{},items:Object.fromEntries(items.map(item=>[
  item.itemVersionId,{graderType:'accepted_text_sequence',acceptedBySlot:Array.from({length:item.maxScore},(_,slot)=>['Giả '+item.position+' '+slot]),normalization:{caseInsensitive:true,collapseWhitespace:true}}
 ]))};
 return {definition,gradingKey:key,items};
}
