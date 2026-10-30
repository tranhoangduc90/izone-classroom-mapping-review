import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {validateAiImportResult} from '../src/learning-ai-import.js';
const examples=[
 ['mcq','Chọn sở thích\nA. Nghe\nB. Nói','B',[],[{id:'A',label:'Nghe'},{id:'B',label:'Nói'}]],
 ['multi','Chọn sở thích\nA. Nghe\nB. Nói\nC. Đọc','A, C',[],[{id:'A',label:'Nghe'},{id:'B',label:'Nói'},{id:'C',label:'Đọc'}]],
 ['dropdown','Chọn thời điểm\nA. Sáng\nB. Tối','B',[],[{id:'A',label:'Sáng'},{id:'B',label:'Tối'}]],
 ['short_answer','Viết một từ về cảm xúc','vui / hào hứng',['vui','hào hứng'],[]],
 ['gapfill','Hôm nay em cảm thấy ___ sau giờ học.','vui / thoải mái',['vui','thoải mái'],[]],
 ['reflection','Chia sẻ cảm nhận','Em thích trao đổi / thảo luận nhóm.',[],[]],
 ['self_reported_score','Tự ghi số câu đúng trên 10 câu (___/10).','7/10',[],[]]
];
for(const [type,prompt,answer,acceptedAnswers,options]of examples)test('khảo sát '+type+' giữ key tham khảo nguyên văn và không tự chấm',()=>{
 const answerQuote='Đáp án tham khảo: '+answer,explanation='Giảng viên cung cấp mẫu.',sourceQuote=prompt+'\n'+answerQuote+'\nGiải thích: '+explanation;
 const q={sourceQuote,kind:'survey',type,prompt,answer:acceptedAnswers.length?'':answer,answerQuote,acceptedAnswers,options,explanation,...(type==='gapfill'?{before:'Hôm nay em cảm thấy ',after:' sau giờ học.'}:{}),...(type==='self_reported_score'?{total:10}:{})};
 const requestId=randomUUID(),sourceHash=createHash('sha256').update(sourceQuote).digest('hex');
 const result=validateAiImportResult({requestId,sourceHash,questions:[q]},{text:sourceQuote,requestId,sourceHash});
 const item=result.payload.definition.blocks[0].items[0],id=item.itemVersionId,key=result.payload.gradingKey;
 assert.equal(item.kind,'survey');assert.equal(item.graderType,'none');assert.equal(item.maxScore,0);assert.equal(key.items[id],undefined);
 const expected=options.length?answer.split(/,\s*/):acceptedAnswers.length?acceptedAnswers:[answer];
 assert.deepEqual(type==='gapfill'?key.referenceAnswersBySlot?.[id]?.[0]:key.referenceAnswers?.[id],expected);
 assert.equal(key.explanations?.[id],explanation);assert.equal(result.warnings.length,0);
 if(type==='multi')assert.equal(item.interactionConfig.maxSelections,undefined);
 if(type==='self_reported_score')assert.equal(item.interactionConfig.max,10);
});
