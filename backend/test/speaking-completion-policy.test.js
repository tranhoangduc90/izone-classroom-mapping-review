import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSubmission } from '../src/speaking-checker.js';
import { runSpeakingCheckJob } from '../src/speaking-check-worker.js';
import { COMPLETION_POLICY, validateCompletion, analyzeChatbotCompletion } from '../src/speaking-completion-policy.js';
import { runPracticeCheckJob, analyzePracticeConversation } from '../src/speaking-practice-worker.js';

// Dữ liệu giả tái hiện chatbot kết thúc sớm; kiểm kết quả học viên, không dùng chat riêng tư.
const messages = [
  { role: 'user', text: 'Tôi muốn luyện Speaking.' },
  { role: 'assistant', text: 'What do you like about your hometown?' },
  { role: 'user', text: 'I like the parks.' },
  { role: 'assistant', text: 'Bạn đã hoàn thành buổi luyện. Bạn có muốn luyện thêm không?' }
];
const completion = { confidence: 0.99, completed: true, matched: true,
  message: 4, quote: 'Bạn đã hoàn thành buổi luyện.', scope: 'whole_practice' };
const input = { section: 'freestyle', minimum: 2,
  url: 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111' };

test('chatbot kết thúc sớm vẫn nhận, không nâng giả số câu', async () => {
  const result = await checkSubmission(input, {
    readShare: async () => ({ messages }),
    analyzeCompletion: async () => completion,
    analyze: async () => ({ confidence: 0.99, completed: [] })
  });
  assert.equal(result.kind, 'pass');
  assert.equal(result.acceptanceBasis, 'chatbot_completion');
  assert.ok(result.count < input.minimum);
  assert.equal(result.completionEvidence.message, 4);
});

test('worker chuyển quyền nhận theo chatbot qua API dù số đếm bằng 0', async () => {
  let written;
  const status = await runSpeakingCheckJob({ async completeCheck(value) {
    written = value;
    return { status: value.qualityPassed ? 'accepted' : 'rejected' };
  } }, { job_id: 'job-A', part: 'freestyle', min_questions: 2, share_url: input.url },
  async () => ({ kind: 'pass', count: 0, fingerprint: 'a'.repeat(64),
    acceptanceBasis: 'chatbot_completion', completionEvidence: validateCompletion(messages, completion) }));
  assert.equal(status, 'accepted');
  assert.equal(written.questionCount, 0);
  assert.equal(written.evidence.acceptanceBasis, 'chatbot_completion');
});

test('lời người học, dẫn chứng bịa và ví dụ trích dẫn không thành lời xác nhận', () => {
  assert.throws(() => validateCompletion(messages, { ...completion, message: 3 }));
  assert.throws(() => validateCompletion(messages, { ...completion, quote: 'Bạn đã hoàn thành tất cả.' }));
  assert.throws(() => validateCompletion([{ role: 'assistant', text: '> Bạn đã hoàn thành buổi luyện.' }],
    { ...completion, message: 1 }));
  assert.throws(() => validateCompletion(messages, { ...completion, scope: 'one_step' }));
});

test('chỉ xong một bước và bài sai kỹ năng không được nhận nhờ lời kết thúc', async () => {
  const result = await checkSubmission(input, { readShare: async () => ({ messages }),
    analyzeCompletion: async () => ({ confidence: 0.99, completed: false }),
    analyze: async () => ({ confidence: 0.99, completed: [] }) });
  assert.equal(result.kind, 'blocked');
  const mismatch = await checkSubmission(input, { readShare: async () => ({ messages }),
    analyzeCompletion: async () => ({ ...completion, matched: false }) });
  assert.equal(mismatch.kind, 'error');
});

test('lỗi AI không bị trình bày là học viên thiếu bài', async () => {
  const result = await checkSubmission(input, { readShare: async () => ({ messages }),
    analyzeCompletion: async () => { throw new Error('timeout'); } });
  assert.equal(result.kind, 'error');
});

test('chat dài vẫn giữ lời kết thúc sớm, không đòi đếm đủ trước', async () => {
  const long = [...messages, { role: 'user', text: 'Luyện thêm nhé.' },
    { role: 'assistant', text: 'Optional practice. '.repeat(6000) }];
  const result = await checkSubmission({ ...input, section: 'how_to_do' }, {
    readShare: async () => ({ messages: long }),
    analyze: async () => { throw new Error('SHARE_TOO_LONG'); },
    analyzeCompletion: async () => completion });
  assert.equal(result.kind, 'pass');
  assert.equal(result.count, 0);
  assert.equal(result.countVerified, false);
  assert.equal(result.completionEvidence.message, 4);
});

test('bổ trợ thiếu lượt nói lại vẫn nhận theo lời chatbot, lưu căn cứ', async () => {
  let written;
  const result = await runPracticeCheckJob({ async completePracticeCheck(value) {
    written = value; return { status: 'accepted' };
  } }, { job_id: 'practice-A', exercise_id: 'exercise-A', exercise_title: 'Linking verbs', share_url: input.url }, {
    readShare: async () => ({ messages }), analyze: async () => ({ completed: false }),
    analyzeCompletion: async () => completion });
  assert.equal(result.status, 'accepted');
  assert.equal(written.questionCount, 0);
  assert.equal(written.evidence.policyVersion, COMPLETION_POLICY);
  assert.equal(written.matchedExerciseId, 'exercise-A');
});

test('nhận ra lời kết thúc đảo thứ tự và tiếng Anh để chuyển cho AI phân nghĩa', async () => {
  for (const text of ['Buổi luyện hôm nay đã kết thúc. Bạn có thể nghỉ.', 'The entire practice is complete.']) {
    let calls = 0;
    const result = await analyzeChatbotCompletion([{role:'assistant',text}], 'freestyle', async () => {
      calls++;
      return {ok:true,json:async()=>({text:JSON.stringify({completed:true,matched:true,confidence:0.99,scope:'whole_practice',candidateId:'c1'})})};
    });
    assert.equal(calls, 1); assert.equal(result.quote, text);
    assert.ok(validateCompletion([{role:'assistant',text}],result));
  }
});

test('practice AI không chắc và AI giai đoạn không chắc đều giữ chưa xác minh', async () => {
  await assert.rejects(analyzePracticeConversation(messages,'Linking verbs',async()=>({ok:true,
    json:async()=>({text:JSON.stringify({matched:true,confidence:0.1,questionMessage:2,answerMessage:3,feedbackMessage:4,repeatMessage:5})})})), /PRACTICE_AI_UNCERTAIN/);
  const result = await checkSubmission({...input,section:'insert_middle'}, {
    readShare:async()=>({messages}), analyzeStages:async()=>({confidence:0.1,stages:[]}),
    analyzeCompletion:async()=>({completed:false,confidence:0.99})});
  assert.equal(result.kind,'error');
});

test('xong bước Part 1 rồi giao bước Part 3 không phải xong cả bài', () => {
  const text='Bạn đã hoàn thành 2 câu Part 1. Bây giờ sang Bước 4 luyện Part 3. Hãy trả lời câu hỏi mới.';
  assert.throws(()=>validateCompletion([{role:'assistant',text}],{...completion,message:1,
    quote:'Bạn đã hoàn thành 2 câu Part 1.'}),/COMPLETION_STEP_ONLY/);
});
