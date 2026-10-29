import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {validateAiImportResult,previewAiImport} from '../src/learning-ai-import.js';

const digest=text=>createHash('sha256').update(text).digest('hex');
test('thiếu key vẫn chuyển câu và bỏ đáp án/lời giải AI không xác minh được',()=>{
 const text='Chọn từ phù hợp\nA. apple\nB. book',requestId=randomUUID(),sourceHash=digest(text);
 const preview=validateAiImportResult({requestId,sourceHash,questions:[{sourceQuote:text,type:'mcq',prompt:'Chọn từ phù hợp',options:[{id:'A',label:'apple'},{id:'B',label:'book'}],answer:'B',answerQuote:'Đáp án: B',explanation:'AI đoán lời giải không có trong nguồn'}]},{text,requestId,sourceHash});
 const item=preview.payload.definition.blocks[0].items[0],key=preview.payload.gradingKey;
 assert.equal(item.prompt,'Chọn từ phù hợp');assert.deepEqual(item.options.map(o=>o.label),['apple','book']);
 assert.equal(key.items[item.itemVersionId],undefined);assert.equal(key.explanations?.[item.itemVersionId],undefined);
 assert.equal(key.importReviews[item.itemVersionId].keyStatus,'missing');assert.ok(preview.warnings.length);
});
test('ô điền thiếu key giữ câu và ô, đáp án thay thế/lời giải để trống',()=>{
 const text='Complete: The sky is [___].',requestId=randomUUID(),sourceHash=digest(text);
 const preview=validateAiImportResult({requestId,sourceHash,questions:[{sourceQuote:text,type:'gapfill',prompt:'Complete:',before:'The sky is ',after:'.',acceptedAnswers:['blue'],answerQuote:'Đáp án: blue',explanation:'Invented explanation'}]},{text,requestId,sourceHash});
 const item=preview.payload.definition.blocks[0].items[0],key=preview.payload.gradingKey;
 assert.equal(item.interactionConfig.responseCount,1);assert.equal(item.graderType,'none');
 assert.equal(key.items[item.itemVersionId],undefined);assert.equal(key.explanations?.[item.itemVersionId],undefined);
 assert.equal(key.importReviews[item.itemVersionId].keyStatus,'missing');
});
function responseFor(text,request){
 const body=JSON.parse(request.body),requestId=body.prompt.match(/requestId=([0-9a-f-]+)/u)[1];
 return {requestId,sourceHash:digest(text),questions:[{sourceQuote:text,type:'reflection',prompt:text}]};
}
test('nhập AI yêu cầu đúng Gemini 3.8 Flash và trả model đã dùng',async()=>{
 const text='Em thấy nội dung nào hữu ích nhất?',requests=[];
 const preview=await previewAiImport({text,fetchImpl:async(url,request)=>{
  requests.push({url,body:JSON.parse(request.body)});
  return {ok:true,json:async()=>({modelVersion:'gemini-3.8-flash',text:JSON.stringify(responseFor(text,request))})};
 }});
 assert.equal(requests[0].body.model_id,'gemini-3.8-flash');assert.equal(requests[0].body.thinking_level,'low');
 assert.equal(requests[0].body.product_id,'progress-log-ai-import');
 assert.equal(preview.modelVersion,'gemini-3.8-flash');
});
test('không nhận kết quả mô hình khác hoặc kết quả thiếu model khi yêu cầu Gemini 3.8',async()=>{
 for(const modelVersion of ['gpt-5.6-terra',undefined]){
  const text='Chia sẻ điều em muốn cải thiện';
  await assert.rejects(()=>previewAiImport({text,fetchImpl:async(url,request)=>({ok:true,json:async()=>({modelVersion,text:JSON.stringify(responseFor(text,request))})})}),error=>error.code==='AI_IMPORT_MODEL_MISMATCH');
 }
});
