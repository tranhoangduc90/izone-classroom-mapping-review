import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSubmission } from '../src/speaking-checker.js';

// Fixture độc lập với checker: tám lượt theo prompt gốc, không gọi Share/AI/Docs thật.
// Kiểm ranh giới dispatch → dẫn chứng → kết quả; không chứng minh độ chính xác AI thật.
const stages=['slow_down','zoom_in','action_emotion','emotion_action','chain_three','beat_four','beat_five','chain_five'];
const messages=[], completed=[];
for (const [i,stage] of stages.entries()) {
  const q=messages.length+1;
  messages.push({role:'assistant',text:`Luyện bước ${stage} cho câu chuyện nhận tin bất ngờ.`},
    {role:'user',text:`Câu trả lời thực hành bước ${i+1}: tôi mở thư, tay run lên và mỉm cười vì kết quả tốt.`},
    {role:'assistant',text:`Góp ý cho bước ${stage}: hãy làm rõ chi tiết này.`});
  completed.push({stage,questionMessage:q,questionText:messages[q-1].text,answerMessage:q+1,answerQuote:messages[q].text,feedbackMessage:q+2});
}
const run=(items=completed,chat=messages,extra={})=>checkSubmission({section:'story_detail',minimum:1,url:'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111'}, {
  readShare:async()=>({messages:chat,source:'fixture'}),
  analyzeStoryDetail:async()=>({confidence:0.95,completed:items}),
  analyzeCompletion:async()=>({completed:false,confidence:0.99}),...extra
});
test('Diễn biến: một chủ đề đủ tám bước và đoạn năm nhịp là một lượt, không bắt thử thách thêm',async()=>{
  const r=await run();assert.equal(r.kind,'pass');assert.equal(r.count,1);assert.equal(r.completedTurns.length,8);assert.ok(r.snapshot);
});
test('Diễn biến: thiếu bất kỳ bước bắt buộc nào chưa đạt',async()=>{
  for(let i=0;i<completed.length;i++){const r=await run(completed.filter((_,j)=>j!==i));assert.notEqual(r.kind,'pass',stages[i]);}
});
test('Diễn biến: sai vai trò, dẫn chứng bịa, bước trùng và đảo thứ tự không tạo accepted',async()=>{
  for(const mutate of [x=>{x[0].answerMessage=1;},x=>{x[0].answerQuote='Dẫn chứng này không có trong hội thoại';},x=>{x[1]=x[0];},x=>{[x[0],x[1]]=[x[1],x[0]];}]){
    const items=structuredClone(completed);mutate(items);assert.notEqual((await run(items)).kind,'pass');
  }
});
test('Diễn biến: cùng tin chatbot góp ý và giao bước kế tiếp vẫn hợp lệ',async()=>{
  const chat=[{role:'assistant',text:'Luyện bước đầu tiên cho chủ đề nhận tin bất ngờ.'}],items=[];let q=1;
  for(const stage of stages){const a=chat.length+1;chat.push({role:'user',text:`Tôi luyện bước ${stage} với câu trả lời của mình.`});const f=chat.length+1;chat.push({role:'assistant',text:`Góp ý ${stage}. Hãy tiếp tục sang bước tiếp theo.`});items.push({stage,questionMessage:q,questionText:chat[q-1].text,answerMessage:a,answerQuote:chat[a-1].text,feedbackMessage:f});q=f;}
  assert.equal((await run(items,chat)).kind,'pass');
});
test('Diễn biến: lỗi đọc, AI lỗi hoặc thiếu tin cậy là error, không kết luận học viên thiếu',async()=>{
  for(const extra of [{readShare:async()=>{throw Error('OFFLINE');}},{analyzeStoryDetail:async()=>{throw Error('AI_TIMEOUT');}},{analyzeStoryDetail:async()=>({confidence:0.2,completed})}])assert.equal((await run(completed,messages,extra)).kind,'error');
});
test('Diễn biến: kế thừa lời chatbot xác nhận hoàn thành cả bài, không nhận lời tự khai',async()=>{
  for(const role of ['assistant','user']){
    const chat=[...messages,{role,text:'Chúc mừng bạn đã hoàn thành toàn bộ buổi luyện diễn biến chi tiết.'}];
    const r=await run(completed.slice(0,1),chat,{analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:chat.length,quote:chat.at(-1).text})});
    assert.equal(r.kind==='pass',role==='assistant');
  }
});
