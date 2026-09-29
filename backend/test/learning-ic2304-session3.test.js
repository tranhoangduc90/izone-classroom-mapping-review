import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCompleteness, gradeLearningSubmission } from '../src/learning-domain.js';
import { buildIc2304Session2SpeakingDefinition } from '../src/learning-templates/ic2304-session2-speaking.js';
import {
  buildIc2304Session3Definition, buildIc2304Session3GradingKey
} from '../src/learning-templates/ic2304-session3-reading-writing-speaking.js';

const definition = buildIc2304Session3Definition();
const reading = definition.blocks[0];
const writing = definition.blocks[1];
const speaking = definition.blocks[2];
const key = buildIc2304Session3GradingKey(['i', 'ii']);

test('Buổi 3 chỉ có hai đoạn Reading A–B, bảy câu Writing và Speaking buổi 2', () => {
  assert.deepEqual(definition.blocks.map(block => block.items.length), [2, 7, 4]);
  assert.deepEqual(reading.items.map(item => item.prompt), ['Đoạn A', 'Đoạn B']);
  for (const item of reading.items) {
    assert.equal(item.layoutType, 'matching_heading_dropdown');
    assert.equal(item.graderType, 'exact_option');
    assert.equal(item.options.length, 10);
    assert.deepEqual(item.options.map(option => option.id),
      ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']);
  }
  assert.deepEqual(writing.items.map(item => item.prompt), [
    'Body 1 · Idea 1', 'Body 1 · Idea 2', 'Body 1 · Ý chung của đoạn (Topic sentence)',
    'Body 2 · Idea 1', 'Body 2 · Idea 2', 'Body 2 · Ý chung của đoạn (Topic sentence)',
    'Thesis statement của mở bài'
  ]);
  assert.ok(writing.items.every(item => item.graderType === 'none'));
  const prior = buildIc2304Session2SpeakingDefinition().blocks[2];
  assert.deepEqual(speaking.items.map(item => item.prompt), prior.items.map(item => item.prompt));
  assert.deepEqual(speaking.items.map(item => item.options), prior.items.map(item => item.options));
  assert.equal(speaking.items[1].interactionConfig.visibleWhenItemVersionId,
    speaking.items[0].itemVersionId);
  assert.equal(JSON.stringify(definition).includes('expectedOptionId'), false);
});

test('Reading chấm đúng/sai từng đoạn; Writing và Speaking chỉ lưu câu trả lời', () => {
  const responses = Object.fromEntries([
    ...reading.items.map((item, index) => [item.itemVersionId, ['i', 'iv'][index]]),
    ...writing.items.map(item => [item.itemVersionId, 'Ý do học viên tự viết']),
    [speaking.items[0].itemVersionId, ['NO_MAJOR_ISSUE']]
  ]);
  assert.equal(evaluateCompleteness(definition, responses).complete, true);
  const result = gradeLearningSubmission({ definition, gradingKey: key, responses });
  assert.equal(result.summary.maxScore, 2);
  assert.equal(result.summary.scoreEarned, 1);
  assert.deepEqual(result.items.slice(0, 2).map(item => item.verdict),
    ['correct', 'incorrect']);
  assert.deepEqual(result.items.slice(0, 2).map(item => item.expectedAnswer),
    ['i', 'ii']);
  assert.ok(result.items.slice(2).every(item => item.verdict === 'ungraded'));
  assert.equal(evaluateCompleteness(definition, {
    ...responses, [writing.items[6].itemVersionId]: ''
  }).complete, false);
});

test('Khóa chấm chỉ nhận hai heading hợp lệ và lệnh xuất bản mặc định chỉ lập kế hoạch', () => {
  for (const answers of [[], ['i'], ['i', 'wrong'], ['i', 'ii', 'iii']]) {
    assert.throws(() => buildIc2304Session3GradingKey(answers),
      /IC2304_SESSION3_READING_ANSWERS_REQUIRED/);
  }
  const script = fileURLToPath(new URL('../scripts/publish-ic2305-progress-log.mjs', import.meta.url));
  const planned = spawnSync(process.execPath,
    [script, '--form=session3-reading-writing-speaking', '--class=IC2304'],
    { encoding: 'utf8', env: { ...process.env, LEARNING_DATABASE_URL: '',
      IC2304_SESSION3_READING_ANSWERS: '' } });
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.sessionNumber, 3);
  assert.equal(plan.scoredItems, 2);
  assert.equal(plan.answerReleasePolicy, 'immediate');
  const blocked = spawnSync(process.execPath,
    [script, '--form=session3-reading-writing-speaking', '--class=IC2304', '--apply'],
    { encoding: 'utf8', env: { ...process.env, LEARNING_DATABASE_URL: '',
      IC2304_SESSION3_READING_ANSWERS: '' } });
  assert.notEqual(blocked.status, 0);
});

test('Phiếu demo khóa 67 tách Portal và ba phần đều mở trong kế hoạch', () => {
  const script = fileURLToPath(new URL('../scripts/create-ic2304-session3-student-demo.mjs',
    import.meta.url));
  const planned = spawnSync(process.execPath, [script], {
    encoding: 'utf8', env: { ...process.env, LEARNING_DATABASE_URL: '' }
  });
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.session, 3);
  assert.equal(plan.students, 6);
  assert.match(plan.portalAttendance, /disabled for DEMO-67/);
});
