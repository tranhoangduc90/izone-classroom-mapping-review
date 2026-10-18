import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSubmission } from '../src/speaking-checker.js';
import { analyzeHowTo } from '../src/speaking-how-to-checker.js';
import { runSpeakingCheckJob } from '../src/speaking-check-worker.js';

// Dữ liệu giả có hai câu mỗi giai đoạn; kiểm ranh giới đọc/AI/worker, không gọi production.
const url = 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111';
const messages = [
  { role: 'assistant', text: 'PHẦN 1: LUYỆN TẬP XÂY DỰNG CÓ HƯỚNG DẪN. How do you keep healthy?' },
  { role: 'user', text: 'I exercise every morning.' },
  { role: 'assistant', text: 'How do you prepare for an exam?' },
  { role: 'user', text: 'I make a study plan.' },
  { role: 'assistant', text: 'PHẦN 2: LUYỆN TẬP TỰ DO. How do you learn vocabulary?' },
  { role: 'user', text: 'I read and keep notes.' },
  { role: 'assistant', text: 'How do you relax?' },
  { role: 'user', text: 'I go for a walk.' }
];
const completed = [
  { stage: 'guided', stageEvidenceMessage: 1, questionMessage: 1, questionText: 'How do you keep healthy?', answerMessage: 2 },
  { stage: 'guided', stageEvidenceMessage: 1, questionMessage: 3, questionText: 'How do you prepare for an exam?', answerMessage: 4 },
  { stage: 'free', stageEvidenceMessage: 5, questionMessage: 5, questionText: 'How do you learn vocabulary?', answerMessage: 6 },
  { stage: 'free', stageEvidenceMessage: 5, questionMessage: 7, questionText: 'How do you relax?', answerMessage: 8 }
];
const input = { section: 'how_to_do', url, minimum: 4 };
const deps = (items = completed, confidence = 0.9) => ({
  readShare: async () => ({ messages, source: 'fixture' }),
  analyzeHowTo: async () => ({ completed: items, confidence })
});

test('hai câu có hướng dẫn và hai câu tự do được nhận qua bộ kiểm chung', async () => {
  const r = await checkSubmission(input, deps());
  assert.equal(r.kind, 'pass'); assert.equal(r.count, 4);
  assert.deepEqual(r.stageCounts, { guided: 2, free: 2 });
  assert.match(r.fingerprint, /^[a-f0-9]{64}$/);
});
test('bốn câu ở một phần không thay được phần còn thiếu', async () => {
  const items = completed.map(x => ({ ...x, stage: 'guided' }));
  const r = await checkSubmission(input, deps(items));
  assert.equal(r.kind, 'blocked'); assert.equal(r.count, 4);
  assert.deepEqual(r.stageCounts, { guided: 4, free: 0 });
});
test('thiếu một câu tự do phải bị từ chối dù có nhiều tin nhắn', async () => {
  assert.equal((await checkSubmission(input, deps(completed.slice(0, 3)))).kind, 'blocked');
});
test('lặp câu không tăng số; dẫn chứng sai giữ chưa xác minh thay vì báo thiếu', async () => {
  const bad = [completed[0], completed[0], completed[1], completed[2],
    { ...completed[3], questionText: 'Invented question' },
    { ...completed[3], answerMessage: 7 },
    { ...completed[3], stageEvidenceMessage: 8 }];
  const r = await checkSubmission(input, deps(bad));
  assert.equal(r.kind, 'error');
  const deduped = await checkSubmission(input, deps([completed[0], completed[0], completed[1], completed[2]]));
  assert.equal(deduped.kind, 'blocked'); assert.equal(deduped.count, 3);
});
test('link riêng tư bị chặn trước đọc hội thoại hoặc AI', async () => {
  let calls = 0;
  const r = await checkSubmission({ ...input, url: url.replace('/share/', '/c/') }, {
    readShare: async () => { calls++; throw Error('SHOULD_NOT_CALL'); }
  });
  assert.equal(r.kind, 'blocked'); assert.equal(calls, 0);
});
test('lỗi đọc, lỗi AI và confidence thấp không tạo kết quả đạt', async () => {
  for (const d of [
    { readShare: async () => { throw Error('HTTP 503'); } },
    { ...deps(), analyzeHowTo: async () => { throw Error('HTTP 429'); } },
    deps(completed, 0.4)
  ]) assert.equal((await checkSubmission(input, d)).kind, 'error');
});
test('worker từ chối bốn câu cùng một phần và giữ đúng job', async () => {
  let saved;
  const service = { completeCheck: async data => { saved = data; return { status: data.qualityPassed ? 'accepted' : 'rejected' }; } };
  const job = { job_id: 'lesson7-job', part: 'how_to_do', share_url: url, min_questions: 4 };
  const result = await runSpeakingCheckJob(service, job, i => checkSubmission(i, deps(completed.map(x => ({ ...x, stage: 'guided' })))));
  assert.equal(result, 'rejected'); assert.equal(saved.checkJobId, 'lesson7-job');
  assert.equal(saved.qualityPassed, false);
});
test('request AI mô tả đúng hai giai đoạn và không yêu cầu nói lại', async () => {
  const original = globalThis.fetch;
  let body;
  try {
    globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ text: JSON.stringify({ completed, confidence: 0.9 }) }) }; };
    await analyzeHowTo(messages);
    assert.match(body.prompt, /guided/); assert.match(body.prompt, /free/);
    assert.match(body.prompt, /Không yêu cầu nói lại/);
    assert.match(body.prompt, /DỮ LIỆU/);
  } finally { globalThis.fetch = original; }
});
