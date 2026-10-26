import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSubmission } from '../src/speaking-checker.js';

// Dữ liệu giả theo tám mốc thực hành của chatbot nguồn. Không gọi AI/Share/Docs.
const stages = ['guided_1','guided_2','guided_3','semi_free_1','semi_free_2','semi_free_3','free_story','free_ending'];
const messages = [], completed = [];
for (const [i,stage] of stages.entries()) {
  const q = messages.length + 1;
  messages.push({role:'assistant',text:`Tình huống ${stage}: hãy tự tìm bài học và cầu nối của bạn.`});
  if (i < 6) messages.push({role:'user',text:`Ý tưởng ${i}: tôi nhận ra việc chuẩn bị và lắng nghe rất cần thiết.`});
  const a = messages.length + 1;
  messages.push({role:'user',text:`Phần thực hành ${i}: tôi đã thất bại. Vì đã bỏ qua lời khuyên, tôi hiểu giá trị của sự chuẩn bị.`},
    {role:'assistant',text:`Góp ý phần ${stage}: cầu nối của bạn đã giải thích được nguyên nhân.`});
  completed.push({stage,questionMessage:q,questionText:messages[q-1].text,answerMessage:a,answerQuote:messages[a-1].text,feedbackMessage:a+1,
    ...(i<6?{reasonMessage:q+1,reasonQuote:messages[q].text}:{})});
}
const run = (items=completed,chat=messages,extra={}) => checkSubmission({section:'story_outcome',minimum:1,url:'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111'}, {
  readShare:async()=>({messages:chat,source:'fixture'}),
  analyzeStoryOutcome:async()=>({confidence:0.95,completed:items}),
  analyzeCompletion:async()=>({completed:false,confidence:0.99}),...extra
});

test('Kết cục: đủ ba có hướng dẫn, ba bán tự do và Part 2 là một lượt; không bắt đề thêm',async()=>{
  const r=await run();assert.equal(r.kind,'pass');assert.equal(r.count,1);assert.equal(r.completedTurns.length,8);assert.ok(r.snapshot);
});
test('Kết cục: thiếu bất kỳ mốc bắt buộc nào chưa đạt',async()=>{
  for(let i=0;i<8;i++)assert.notEqual((await run(completed.filter((_,j)=>j!==i))).kind,'pass',stages[i]);
});
test('Kết cục: không nhận dẫn chứng bịa, sai vai trò, thiếu cầu nối, trùng hoặc đảo mốc',async()=>{
  for(const mutate of [x=>{x[0].answerMessage=1;},x=>{x[0].reasonQuote='Nội dung không tồn tại';},x=>{delete x[0].reasonMessage;},
    x=>{x[0].answerQuote='Đoạn kết không tồn tại';},x=>{x[1]=x[0];},x=>{[x[0],x[1]]=[x[1],x[0]];}]){
    const items=structuredClone(completed);mutate(items);assert.notEqual((await run(items)).kind,'pass');
  }
});
test('Kết cục: AI lỗi, thiếu tin cậy và Share lỗi là chưa xác minh',async()=>{
  for(const extra of [{readShare:async()=>{throw Error('OFFLINE');}},{analyzeStoryOutcome:async()=>{throw Error('TIMEOUT');}},
    {analyzeStoryOutcome:async()=>({confidence:0.2,completed})}])assert.equal((await run(completed,messages,extra)).kind,'error');
});
test('Kết cục: chatbot thực sự xác nhận hoàn tất toàn bài thì kế thừa đường công nhận chung',async()=>{
  for(const role of ['assistant','user']){
    const chat=[...messages,{role,text:'Chúc mừng bạn đã hoàn thành toàn bộ buổi luyện tập Kết cục và ý nghĩa. Bạn có muốn thử thêm đề khác không?'}];
    const r=await run(completed.slice(0,1),chat,{analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:chat.length,quote:chat.at(-1).text})});
    assert.equal(r.kind==='pass',role==='assistant');
  }
});
test('Kết cục: lời báo xong bước giữa rồi giao Part 2 chưa hoàn tất toàn bài',async()=>{
  const chat=[...messages.slice(0,4),{role:'assistant',text:'Bạn đã hoàn thành ba câu có hướng dẫn. Bây giờ chúng ta sang phần bán tự do và Part 2.'}];
  const r=await run([],chat,{analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'intermediate_step',message:chat.length,quote:chat.at(-1).text})});
  assert.notEqual(r.kind,'pass');
});
test('Kết cục: giữ hội thoại trên 80.000 ký tự trong snapshot chung 160.000',async()=>{
  const chat=[{role:'user',text:'Ngữ cảnh dài '.repeat(7500)},...messages];
  const shifted=completed.map(x=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,k.endsWith('Message')?v+1:v])));
  const r=await run(shifted,chat);assert.equal(r.kind,'pass');assert.ok(r.snapshot.messages[0].text.length>80000);
});
