// Nguồn giả kiểm AI có đối chiếu nguyên văn, không đoán key và không tự thay nháp.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {validateAiImportResult,previewAiImport} from '../src/learning-ai-import.js';
const text='Chọn từ phù hợp\nA. apple\nB. book\nĐáp án: B';
const requestId=randomUUID(),sourceHash=createHash('sha256').update(text).digest('hex');
const question={sourceQuote:text,type:'mcq',prompt:'Chọn từ phù hợp',options:[{id:'A',label:'apple'},{id:'B',label:'book'}],answer:'B',answerQuote:'Đáp án: B'};
const context={text,requestId,sourceHash};
test('AI chỉ chuyển nội dung có sẵn; khóa đáp án ở payload nháp riêng',()=>{
 const preview=validateAiImportResult({requestId,sourceHash,questions:[{...question,total:''}]},context);
 assert.equal(preview.engine,'ai');assert.equal(preview.rows.length,1);assert.deepEqual(preview.warnings,[]);
 const item=preview.payload.definition.blocks[0].items[0];assert.equal(preview.payload.gradingKey.items[item.itemVersionId].expectedOptionId,'B');
 assert.ok(!JSON.stringify(preview.payload.definition).includes('expectedOptionId'));
 const missing=validateAiImportResult({requestId,sourceHash,questions:[{...question,answer:'',answerQuote:''}]},context);
 assert.equal(missing.missingAnswers.length,1);assert.equal(missing.warnings.length,1);
});
test('AI chặn key đoán, phương án mới, quote trùng và kết quả lệch nguồn/yêu cầu',()=>{
 for(const mutation of [{answer:'A',answerQuote:'Đáp án: A'},{options:[{id:'A',label:'newly invented'}]},
  {sourceQuote:'Not present'}])assert.throws(()=>validateAiImportResult({requestId,sourceHash,questions:[{...question,...mutation}]},context));
 assert.throws(()=>validateAiImportResult({requestId:randomUUID(),sourceHash,questions:[question]},context),e=>e.code==='AI_IMPORT_SOURCE_MISMATCH');
 assert.throws(()=>validateAiImportResult({requestId,sourceHash,questions:[question,question]},context),e=>e.code==='AI_IMPORT_UNGROUNDED');
});
test('Phần nguồn chưa chuyển còn hiển thị, kể cả Unicode; lỗi dịch vụ không thay bằng bộ đoán key',async()=>{
 const remaining='📘 Nội dung còn thiếu\n'+text,hash=createHash('sha256').update(remaining).digest('hex');
 const data=validateAiImportResult({requestId,sourceHash:hash,questions:[question]},{...context,sourceHash:hash,text:remaining});
 assert.equal(data.unmappedText,'📘 Nội dung còn thiếu');
 await assert.rejects(()=>previewAiImport({text,fetchImpl:async()=>{throw Error('network')}}),e=>e.code==='AI_IMPORT_UNAVAILABLE');
 await assert.rejects(()=>previewAiImport({text:'x'.repeat(20001)}),e=>e.code==='AI_IMPORT_TOO_LARGE');
});
test('Một ô trống giữ đúng phần chữ trước/sau, không tự thêm ô để đủ cấu trúc',()=>{
 const source='Complete: The sky is [___].',hash=createHash('sha256').update(source).digest('hex');
 const preview=validateAiImportResult({requestId,sourceHash:hash,questions:[{sourceQuote:source,type:'gapfill',prompt:'Complete:',before:'The sky is ',after:'.'}]},
  {text:source,requestId,sourceHash:hash});
 const item=preview.payload.definition.blocks[0].items[0];assert.equal(item.interactionConfig.responseCount,1);assert.equal(item.graderType,'none');
});
