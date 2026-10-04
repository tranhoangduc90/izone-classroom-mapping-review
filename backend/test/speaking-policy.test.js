import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSubmission } from '../src/speaking-checker.js';
import { analyzePracticeConversation } from '../src/speaking-practice-worker.js';

// Dữ liệu giả nhận vào là chu trình hỏi–trả lời–góp ý–trả lời lại.
// Kiểm chính sách mới và giữ ngưỡng riêng; lỗi hiển thị trong runner Node.
function conversation(count) {
  const messages = [], completed = [];
  for (let i = 0; i < count; i++) {
    const questionMessage = messages.push({ role: 'assistant', text: 'What do you enjoy?' });
    const answerMessage = messages.push({ role: 'user', text: 'I typed this answer with a typo.' });
    const feedbackMessage = messages.push({ role: 'assistant', text: 'Please improve your answer.' });
    const repeatMessage = messages.push({ role: 'user', text: 'I enjoy reading because it helps me relax.' });
    completed.push({ questionMessage, answerMessage, feedbackMessage, repeatMessage });
  }
  return { messages, completed };
}
const url = 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111';
function deps(c) { return { readShare: async () => c, analyze: async () => ({ completed: c.completed,
  confidence: 0.95, typingEvidence: [{ quote: 'I typed this answer', reason: 'typed' }] }) }; }
test('Freestyle nhận một câu khi assignment cấu hình minimum=1', async () => {
  const c=conversation(1);
  const result=await checkSubmission({ section:'freestyle',url,minimum:1 },deps(c));
  assert.equal(result.kind,'pass'); assert.equal(result.count,1);
});
test('giữ ngưỡng riêng hai và ba câu khi cấu hình yêu cầu', async () => {
  const c=conversation(1);
  for (const minimum of [2,3]) assert.equal((await checkSubmission({section:'freestyle',url,minimum},deps(c))).kind,'blocked');
  assert.equal((await checkSubmission({section:'speaking',url},deps(c))).kind,'blocked');
});
test('không đòi nói bằng giọng nói dù có bằng chứng gõ chữ cũ', async () => {
  const c=conversation(3);
  const result=await checkSubmission({section:'speaking',url},deps(c));
  assert.equal(result.kind,'pass'); assert.deepEqual(result.typingEvidence,[]);
});
test('một câu vẫn phải có bước trả lời lại sau góp ý', async () => {
  const c=conversation(1); c.messages.pop();
  assert.equal((await checkSubmission({section:'freestyle',url,minimum:1},deps(c))).kind,'blocked');
});
test('prompt bài bổ trợ không yêu cầu AI xác định nói hay gõ', async () => {
  let prompt;
  const c=conversation(1);
  const result=await analyzePracticeConversation(c.messages,'Luyện câu trả lời', async (_url,options) => {
    prompt=JSON.parse(options.body).prompt;
    return {ok:true,json:async()=>({text:JSON.stringify({confidence:.95,matched:true,...c.completed[0]})})};
  });
  assert.equal(result.completed,true);
  assert.doesNotMatch(prompt,/typingEvidence|lỗi gõ|dấu hiệu gõ/i);
});
