import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeLearningSubmission } from '../src/learning-domain.js';
import {
  buildIc2305Writing1Definition,
  buildIc2305Writing1GradingKey,
  IC2305_WRITING1_TEMPLATE
} from '../src/learning-templates/ic2305-entrance-writing1.js';

const definition = buildIc2305Writing1Definition();
const gradingKey = buildIc2305Writing1GradingKey();
const items = definition.blocks.flatMap(block => block.items);
const id = position => items.find(item => item.position === position).itemVersionId;

function responses() {
  return {
    [id(1)]: 'Em khó phần lập luận vì chưa biết cách chứng minh.',
    [id(2)]: 'Cách xác định yêu cầu đề bài.',
    [id(3)]: 'B',
    [id(4)]: ['yêu cầu đề', 'các phần', 'ý tưởng', 'ngôn ngữ', 'chính xác', 'phù hợp', 'đa dạng', 'chính xác'],
    [id(5)]: 'SAI',
    [id(6)]: ['giải thích', 'ví dụ']
  };
}

test('mẫu Writing 1 là buổi 5 phút, có 3 phần và 6 câu', () => {
  assert.equal(definition.formVersionId, IC2305_WRITING1_TEMPLATE.formVersionId);
  assert.equal(definition.title, 'ENTRANCE TICKET • WRITING 1');
  assert.equal(definition.estimatedMinutes, 5);
  assert.deepEqual(definition.blocks.map(block => block.checkpoint), [1, 2, 3]);
  assert.deepEqual(items.map(item => item.position), [1, 2, 3, 4, 5, 6]);
  assert.equal(items.find(item => item.position === 4).interactionConfig.responseCount, 8);
  assert.equal(items.find(item => item.position === 6).interactionConfig.responseCount, 2);
});

test('Writing 1 chỉ chấm hai câu khách quan và không lộ đáp án', () => {
  const result = gradeLearningSubmission({ definition, gradingKey, responses: responses() });
  assert.equal(result.summary.scoreEarned, 2);
  assert.equal(result.summary.maxScore, 2);
  assert.deepEqual([3, 5].map(position => result.items.find(item => item.itemVersionId === id(position)).verdict), [
    'correct', 'correct'
  ]);
  assert.equal(JSON.stringify(definition).includes('expectedOptionId'), false);
});
