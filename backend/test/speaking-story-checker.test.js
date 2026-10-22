import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSubmission } from '../src/speaking-checker.js';
import { validStoryEvidence } from '../src/speaking-story-checker.js';

// Dữ liệu giả kiểm thiếu/đủ bài và dẫn chứng; không đọc Share hoặc gọi AI thật.
const url = 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111';
const contextMessages = [], contexts = [];
for (let i = 0; i < 3; i++) {
  const q = contextMessages.length + 1;
  contextMessages.push({role:'assistant',text:`Describe a time you helped person ${i}.`},
    {role:'user',text:`Last month I was at home helping person ${i} because the deadline was close.`},
    {role:'assistant',text:'Bối cảnh đã rõ hơn. Đây là góp ý cách diễn đạt.'});
  contexts.push({questionMessage:q,questionText:contextMessages[q-1].text,answerMessage:q+1,
    answerQuote:contextMessages[q].text,feedbackMessage:q+2});
}
const sequenceMessages = [], sequence = [];
for (const stage of ['opening','before','during','after']) {
  const q = sequenceMessages.length + 1;
  const quotes = [1,2,3].map(i => `My ${stage} practice sentence number ${i}.`);
  sequenceMessages.push({role:'assistant',text:`Luyện ${stage} với ba cụm từ sau đây.`},
    {role:'user',text:quotes.join('\n')},{role:'assistant',text:'Tôi góp ý ba câu thực hành vừa viết.'});
  sequence.push({stage,questionMessage:q,questionText:sequenceMessages[q-1].text,
    answers:quotes.map(quote=>({message:q+1,quote})),feedbackMessage:q+2});
}
const run = (section,messages,completed,extra={}) => checkSubmission({section,url,minimum:1},{
  readShare:async()=>({messages,source:'fixture'}),
  analyzeStory:async()=>({confidence:0.95,completed}),
  analyzeCompletion:async()=>({completed:false,confidence:0.99}),...extra
});
test('Bối cảnh: ba tình huống có đoạn ghép và góp ý tạo một lượt đầy đủ',async()=>{
  const r=await run('story_context',contextMessages,contexts);
  assert.equal(r.kind,'pass');assert.equal(r.count,1);assert.equal(r.completedTurns.length,3);
});
test('Bối cảnh: hai tình huống chưa đủ, không tự nới thành một câu',async()=>{
  const r=await run('story_context',contextMessages,contexts.slice(0,2));assert.equal(r.kind,'blocked');assert.equal(r.count,0);
});
test('Bối cảnh: cùng câu hỏi ở tin khác không được đếm thành ba tình huống',async()=>{
  const items=contexts.map(item=>({...item,questionText:contexts[0].questionText}));
  const messages=contextMessages.map(m=>({...m}));for(const c of contexts)messages[c.questionMessage-1].text=contexts[0].questionText;
  const r=await run('story_context',messages,items);assert.equal(r.kind,'blocked');
});
test('Trình tự: đủ bốn phần, mỗi phần ba câu có góp ý tạo một lượt đầy đủ',async()=>{
  const r=await run('story_sequence',sequenceMessages,sequence);assert.equal(r.kind,'pass');assert.equal(r.count,1);
});
test('Trình tự: thiếu Mở đầu vẫn chưa hoàn thành toàn chatbot',async()=>{
  const r=await run('story_sequence',sequenceMessages,sequence.slice(1));assert.notEqual(r.kind,'pass');
});
test('Trình tự: thiếu phần Sau chưa đủ lượt',async()=>{
  const r=await run('story_sequence',sequenceMessages,sequence.slice(0,3));assert.equal(r.kind,'blocked');
});
test('Trình tự: chatbot góp ý và giao phần tiếp trong cùng tin vẫn đủ bài',async()=>{
  const messages=[{role:'assistant',text:'Luyện opening với ba cụm từ.'}],items=[];
  let q=1;
  for(const stage of ['opening','before','during','after']){
    const quotes=[1,2,3].map(i=>`My ${stage} complete sentence number ${i}.`);
    const a=messages.length+1;
    messages.push({role:'user',text:quotes.join('\n')});
    const f=messages.length+1;
    messages.push({role:'assistant',text:`Góp ý ${stage}. Tiếp theo luyện phần mới với ba cụm từ.`});
    items.push({stage,questionMessage:q,questionText:messages[q-1].text,answers:quotes.map(quote=>({message:a,quote})),feedbackMessage:f});
    q=f;
  }
  const r=await run('story_sequence',messages,items);assert.equal(r.kind,'pass');assert.equal(r.count,1);
});
test('Trình tự: không nhận câu của chatbot hoặc câu bịa làm bài học viên',()=>{
  const altered=structuredClone(sequence);altered[0].answers[0].message=1;
  assert.throws(()=>validStoryEvidence('story_sequence',sequenceMessages,altered),/EVIDENCE_INVALID/);
  altered[0].answers[0]={message:2,quote:'Câu này hoàn toàn không tồn tại'};
  assert.throws(()=>validStoryEvidence('story_sequence',sequenceMessages,altered),/EVIDENCE_INVALID/);
});
test('Trình tự: ba bản sao cùng câu không là ba câu riêng',()=>{
  const altered=structuredClone(sequence);altered[0].answers.fill(altered[0].answers[0]);
  assert.throws(()=>validStoryEvidence('story_sequence',sequenceMessages,altered),/EVIDENCE_INVALID/);
});
test('Trình tự: đảo phần hoặc lấy góp ý trước bài làm không đạt',()=>{
  assert.throws(()=>validStoryEvidence('story_sequence',sequenceMessages,[sequence[1],sequence[0]]),/EVIDENCE_INVALID/);
  const altered=structuredClone(contexts);altered[0].feedbackMessage=1;
  assert.throws(()=>validStoryEvidence('story_context',contextMessages,altered),/EVIDENCE_INVALID/);
});
test('Lỗi đọc và AI không tạo kết quả accepted',async()=>{
  const read=await run('story_context',[],[],{readShare:async()=>{throw Error('OFFLINE');}});assert.equal(read.kind,'error');
  const ai=await run('story_context',contextMessages,contexts,{analyzeStory:async()=>{throw Error('TIMEOUT');}});assert.equal(ai.kind,'error');
});
test('Lesson 10 kế thừa chính sách chatbot thực sự báo xong cả bài',async()=>{
  const messages=[...contextMessages,{role:'assistant',text:'Chúc mừng bạn đã hoàn thành toàn bộ bài luyện bối cảnh.'}];
  const r=await run('story_context',messages,contexts.slice(0,1),{
    analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:messages.length,quote:messages.at(-1).text})
  });
  assert.equal(r.kind,'pass');assert.equal(r.acceptanceBasis,'chatbot_completion');assert.ok(r.snapshot);
});
test('Lời học viên tự nói xong không cấp quyền công nhận',async()=>{
  const messages=[...contextMessages,{role:'user',text:'Tôi đã hoàn thành toàn bộ bài luyện bối cảnh.'}];
  const r=await run('story_context',messages,contexts.slice(0,1),{
    analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:messages.length,quote:messages.at(-1).text})
  });assert.notEqual(r.kind,'pass');
});
