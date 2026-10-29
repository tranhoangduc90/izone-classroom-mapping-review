import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import * as importer from '../src/learning-ai-import.js';
const {validateAiImportResult,previewAiImport,aiImportAttemptTimeouts}=importer;
const digest=text=>createHash('sha256').update(text).digest('hex');
function validate(questions){const text=questions.map(q=>q.sourceQuote).join('\n\n'),requestId=randomUUID(),sourceHash=digest(text);return validateAiImportResult({requestId,sourceHash,questions},{text,requestId,sourceHash});}
function reply(text,request,change={}){const prompt=JSON.parse(request.body).prompt,requestId=prompt.match(/requestId=([0-9a-f-]+)/u)[1];return {ok:true,json:async()=>({modelVersion:'gemini-3.8-flash',text:JSON.stringify({requestId,sourceHash:digest(text),questions:[{sourceQuote:text,kind:'survey',type:'reflection',prompt:text}],...change})})};}
test('chế độ từng câu độc lập với key: bài tập thiếu key vẫn là bài tập, khảo sát nhiều chọn không giới hạn hai',()=>{
 const result=validate([
  {sourceQuote:'Chọn hai từ chỉ màu\nA. red\nB. blue\nC. book',kind:'exercise',type:'multi',prompt:'Chọn hai từ chỉ màu',options:[{id:'A',label:'red'},{id:'B',label:'blue'},{id:'C',label:'book'}]},
  {sourceQuote:'Em muốn luyện những gì?\nA. Nghe\nB. Nói\nC. Đọc\nD. Viết',kind:'survey',type:'multi',prompt:'Em muốn luyện những gì?',options:[{id:'A',label:'Nghe'},{id:'B',label:'Nói'},{id:'C',label:'Đọc'},{id:'D',label:'Viết'}]},
  {sourceQuote:'Liệt kê các từ chỉ màu.',kind:'exercise',type:'short_answer',prompt:'Liệt kê các từ chỉ màu.'}
 ]);
 const [exercise,survey,open]=result.payload.definition.blocks[0].items,key=result.payload.gradingKey;
 assert.equal(exercise.kind,'exercise');assert.equal(exercise.graderType,'exact_option_set');assert.equal(key.items[exercise.itemVersionId],undefined);
 assert.equal(survey.kind,'survey');assert.equal(survey.layoutType,'multiple_choice_cards');assert.equal(survey.interactionConfig.maxSelections,4);assert.equal(survey.graderType,'none');assert.equal(key.importReviews?.[survey.itemVersionId],undefined);
 assert.equal(open.kind,'exercise');assert.equal(open.graderType,'accepted_text');assert.equal(result.warnings.length,2);
});
test('nhiều đáp án lấy đúng tập key nguồn; khóa chọn bằng số key, câu một chọn không đổi',()=>{
 const result=validate([{sourceQuote:'Chọn màu\nA. red\nB. blue\nC. book\nĐáp án: A, B',kind:'exercise',type:'multi',prompt:'Chọn màu',options:[{id:'A',label:'red'},{id:'B',label:'blue'},{id:'C',label:'book'}],answer:'A, B',answerQuote:'Đáp án: A, B'},
 {sourceQuote:'Chọn từ\nA. red\nB. book\nĐáp án: B',kind:'exercise',type:'mcq',prompt:'Chọn từ',options:[{id:'A',label:'red'},{id:'B',label:'book'}],answer:'B',answerQuote:'Đáp án: B'}]);
 const [multi,single]=result.payload.definition.blocks[0].items,key=result.payload.gradingKey;
 assert.deepEqual(key.items[multi.itemVersionId].expectedOptionIds,['A','B']);assert.equal(multi.interactionConfig.maxSelections,2);
 assert.equal(single.interactionType,'single_choice');assert.equal(key.items[single.itemVersionId].expectedOptionId,'B');
});
test('thiếu mode là schema lỗi, không suy khảo sát chỉ vì thiếu key',()=>{assert.throws(()=>validate([{sourceQuote:'Câu gốc',type:'reflection',prompt:'Câu gốc'}]),e=>e.code==='AI_IMPORT_INVALID');});
test('JSON/schema lỗi tự gọi lại, attempt mới nhưng cùng nguồn; chỉ nhận kết quả hợp lệ lần hai',async()=>{
 for(const first of ['invalid-json','invalid-schema']){
  const text='Em muốn cải thiện gì?',requests=[];
  const result=await previewAiImport({text,fetchImpl:async(url,request)=>{requests.push(JSON.parse(request.body));if(requests.length===1)return {ok:true,json:async()=>({modelVersion:'gemini-3.8-flash',text:first==='invalid-json'?'{broken':JSON.stringify({questions:[]})})};return reply(text,request);}});
  assert.equal(requests.length,2);assert.notEqual(requests[0].request_id,requests[1].request_id);assert.equal(result.attempts,2);assert.equal(result.sourceHash,digest(text));assert.equal(result.rows.length,1);
 }
});
test('mạng/timeout/lỗi HTTP 5xx thử lại; nguồn sai danh tính không được nhận',async()=>{
 for(const first of ['network','timeout','http']){
  let calls=0;const text='Chia sẻ mục tiêu';const result=await previewAiImport({text,fetchImpl:async(url,request)=>{calls++;if(calls===1){if(first==='http')return {ok:false,status:503};const e=new Error('transport');e.name=first==='timeout'?'TimeoutError':'TypeError';throw e;}return reply(text,request);}});assert.equal(calls,2);assert.equal(result.rows.length,1);
 }
 const text='Chia sẻ';let calls=0;await assert.rejects(()=>previewAiImport({text,fetchImpl:async(url,request)=>{calls++;return reply(text,request,{requestId:randomUUID()});}}),e=>e.code==='AI_IMPORT_SOURCE_MISMATCH');assert.equal(calls,2);
});
test('sau hai lỗi báo rõ và không đổi payload đầu vào; lỗi HTTP 4xx không thử vô ích',async()=>{
 const definition={blocks:[]},gradingKey={items:{}},before=JSON.stringify({definition,gradingKey});let calls=0;
 await assert.rejects(()=>previewAiImport({text:'Câu nguồn',definition,gradingKey,fetchImpl:async()=>{calls++;throw new Error('network');}}),e=>e.code==='AI_IMPORT_UNAVAILABLE'&&/2 lần/u.test(e.message)&&/giữ nguyên/u.test(e.message));assert.equal(calls,2);assert.equal(JSON.stringify({definition,gradingKey}),before);
 calls=0;await assert.rejects(()=>previewAiImport({text:'Câu nguồn',fetchImpl:async()=>{calls++;return {ok:false,status:403};}}));assert.equal(calls,1);
});
test('bài dài được tăng ngân sách hữu hạn; quá giới hạn không gọi AI',async()=>{
 assert.deepEqual(aiImportAttemptTimeouts(2000),[45000,90000]);assert.deepEqual(aiImportAttemptTimeouts(20000),[90000,180000]);
 let calls=0;await assert.rejects(()=>previewAiImport({text:'x'.repeat(60001),fetchImpl:async()=>{calls++;}}),e=>e.code==='AI_IMPORT_TOO_LARGE');assert.equal(calls,0);
});
test('hai lượt đồng thời trả đảo thứ tự vẫn giữ đúng nguồn, mã lô và câu riêng',async()=>{
 const pending=new Map(),texts=['Mục tiêu riêng của nguồn A','Cảm nhận riêng của nguồn B'];
 const fetchImpl=(url,request)=>new Promise(resolve=>{const text=texts.find(t=>JSON.parse(request.body).prompt.endsWith(t));pending.set(text,{request,resolve});});
 const tasks=texts.map(text=>previewAiImport({text,fetchImpl}));
 for(const text of [...texts].reverse()){const {request,resolve}=pending.get(text);resolve(reply(text,request));}
 const results=await Promise.all(tasks);for(const [i,result]of results.entries()){assert.equal(result.sourceHash,digest(texts[i]));assert.equal(result.payload.definition.blocks[0].items[0].prompt,texts[i]);}assert.notEqual(results[0].requestId,results[1].requestId);
});
test('thời gian chờ thực gắn đúng ngân sách cho mỗi lần và bài dài không bị cắt ở 20000',async t=>{
 const budgets=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 const text=' '.repeat(20000)+'Câu khảo sát';let calls=0;
 const result=await previewAiImport({text,fetchImpl:async(url,request)=>{calls++;if(calls===1)throw Error('network');const answer=reply(text,request);const data=await answer.json();const raw=JSON.parse(data.text);raw.questions[0].prompt='Câu khảo sát';return {ok:true,json:async()=>({...data,text:JSON.stringify(raw)})};}});
 assert.deepEqual(budgets,[90000,180000]);assert.equal(result.rows.length,1);assert.equal(result.sourceHash,digest(text));
});
