import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildStudentQuizResult, gradeLearningSubmission } from '../src/learning-domain.js';
import {
  buildIc2304Session2ScoredDefinition,
  buildIc2304Session2ScoredGradingKey
} from '../src/learning-templates/ic2304-session2-scored.js';
import { buildIc2304Session2Definition } from '../src/learning-templates/ic2304-session2-listening-writing.js';

const definition = buildIc2304Session2ScoredDefinition();
const sampleAnswers = ['B', 'B', 'B', 'B', 'B'];
const key = buildIc2304Session2ScoredGradingKey(sampleAnswers);
const listening = definition.blocks[0].items;

test('version chấm Listening không đổi câu Writing hoặc làm lộ đáp án trong form công khai', () => {
  const old = buildIc2304Session2Definition();
  assert.notEqual(definition.formVersionId, old.formVersionId);
  assert.deepEqual(definition.blocks[1].items.map(item => item.prompt),
    old.blocks[1].items.map(item => item.prompt));
  assert.deepEqual(listening.map(item => item.displayNumber), ['21', '22', '23', '24', '25']);
  assert.ok(listening.every(item => item.graderType === 'exact_option' && item.maxScore === 1));
  assert.ok(definition.blocks[1].items.every(item => item.graderType === 'none'));
  assert.equal(JSON.stringify(definition).includes('expectedOptionId'), false);
  assert.equal(definition.answerReleasePolicy, 'immediate');
});

test('khóa mẫu riêng chấm đúng 21–25 và chỉ trả đáp án sau khi chấm', () => {
  const responses = Object.fromEntries(listening.map((item, index) => [
    item.itemVersionId, ['A', 'B', 'A', 'A', 'B'][index]
  ]));
  const result = gradeLearningSubmission({
    definition: { ...definition, blocks: [definition.blocks[0]] }, gradingKey: key, responses
  });
  assert.deepEqual(result.items.map(item => item.verdict),
    ['incorrect', 'correct', 'incorrect', 'incorrect', 'correct']);
  assert.deepEqual(result.items.map(item => item.expectedAnswer), sampleAnswers);
  assert.equal(result.summary.scoreEarned, 2);
  assert.equal(result.summary.maxScore, 5);
  assert.equal(buildStudentQuizResult(result, { ...definition, blocks: [definition.blocks[0]] }).answerRelease,
    'released');
});

test('thiếu khóa riêng hoặc khóa sai định dạng không tạo được grader', () => {
  assert.throws(() => buildIc2304Session2ScoredGradingKey(), /IC2304_PRIVATE_ANSWER_IDS_REQUIRED/);
  assert.throws(() => buildIc2304Session2ScoredGradingKey(['A']), /IC2304_PRIVATE_ANSWER_IDS_REQUIRED/);
});

test('lệnh chuyển version mặc định chỉ hiện kế hoạch và đòi người duyệt thứ hai khi ghi', () => {
  const script = fileURLToPath(new URL('../scripts/upgrade-ic2304-session2-listening.mjs', import.meta.url));
  const env = { ...process.env, LEARNING_DATABASE_URL: '' };
  const planned = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).scoredItems, 5);
  assert.equal(planned.stdout.includes('expectedOptionId'), false);
  const rejected = spawnSync(process.execPath, [script, '--apply'], { encoding: 'utf8', env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /LEARNING_DATABASE_URL_REQUIRED/);
});
