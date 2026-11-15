import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runSpeakingCheckJob } from '../src/speaking-check-worker.js';
import { runPracticeCheckJob } from '../src/speaking-practice-worker.js';
import { speakingCheckView } from '../src/speaking-check-retry.js';
import { readSpeakingShare } from '../src/speaking-share-reader.js';

test('Opening file is rejected once, with the right action for each Speaking check path', async t => {
  const code = 'SHARE_OPENING_ATTACHMENT_ONLY';
  const url = 'https://chatgpt.com/share/00000000-0000-4000-8000-000000000005';
  const opening = { frame: { id: 'u', role: 'user', text: '', fileAttachments: [{ kind: 'file' }] } };
  const reply = { frame: { id: 'a', role: 'assistant' }, source: { markdown: 'Phản hồi.' } };
  let rows = [opening, reply];
  t.mock.method(https, 'get', (_url, _options, callback) => {
    const html = '<!doctype html><script id="octane-conversation-transcript">' + JSON.stringify({ rows }) + '</script>';
    const response = Readable.from([Buffer.from(html)]);
    Object.assign(response, { statusCode: 200, headers: {} });
    callback(response);
    return new EventEmitter();
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  await assert.rejects(readSpeakingShare(url), { code });
  const job = { job_id: 'fixture-job', share_url: url, min_questions: 2 };
  const rejected = input => {
    assert.deepEqual(input, { checkJobId: job.job_id, checkCode: code });
    return { status: 'rejected' };
  };
  const unexpected = () => assert.fail('An unreadable link must not reach analysis or another outcome');
  const service = { rejectCheckJob: rejected, rejectPracticeCheckJob: rejected, failCheckJob: unexpected,
    failPracticeCheckJob: unexpected, completeCheck: unexpected, completePracticeCheck: unexpected };
  for (const part of ['speaking', 'insert_middle', 'story_context', 'story_detail', 'story_outcome',
    'object_intro', 'person_intro', 'how_to_do']) {
    assert.equal(await runSpeakingCheckJob(service, { ...job, part }), 'rejected');
  }
  assert.equal((await runPracticeCheckJob(service, job, { analyze: unexpected })).status, 'rejected');
  for (const [statusKey, action] of [['check_status', 'Mở bài luyện'], ['status', 'Mở bài đã chọn']]) {
    const link = speakingCheckView({ [statusKey]: 'rejected', check_code: code }, null, statusKey);
    assert.equal(link.retryable, true);
    assert.match(link.evidence.checkMessage, /khởi đầu bằng một tệp/);
    assert.ok(link.evidence.checkMessage.includes(action));
    assert.match(link.evidence.checkMessage, /ảnh chụp màn hình/);
  }
  assert.equal(speakingCheckView({ status: 'rejected', check_code: 'SHARE_UNAVAILABLE' }).evidence, undefined);

  rows = [{ frame: { ...opening.frame, text: 'Lời nhắn.' } }, reply];
  assert.equal((await readSpeakingShare(url)).messages.length, 2);
  rows = [{ frame: { ...opening.frame, fileAttachments: [] } }, reply];
  await assert.rejects(readSpeakingShare(url), error => error.code !== code);
});
