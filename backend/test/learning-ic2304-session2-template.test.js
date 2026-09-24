import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCompleteness, gradeLearningSubmission } from '../src/learning-domain.js';
import {
  buildIc2304Session2Definition,
  buildIc2304Session2GradingKey,
  IC2304_SESSION2_TEMPLATE
} from '../src/learning-templates/ic2304-session2-listening-writing.js';

const definition = buildIc2304Session2Definition();
const gradingKey = buildIc2304Session2GradingKey();
const listening = definition.blocks[0].items;
const writing = definition.blocks[1].items;
const items = [...listening, ...writing];

test('IC2304 Buổi 2 có đúng hai phần, năm câu Listening và bốn câu Writing', () => {
  assert.equal(definition.title, IC2304_SESSION2_TEMPLATE.title);
  assert.equal(definition.formVersionId, gradingKey.formVersionId);
  assert.deepEqual(definition.blocks.map(block => block.checkpoint), [1, 2]);
  assert.deepEqual(definition.blocks.map(block => block.title), [
    'Listening · Scandinavian Studies', 'Writing'
  ]);
  assert.deepEqual(listening.map(item => item.displayNumber), ['21', '22', '23', '24', '25']);
  assert.deepEqual(writing.map(item => item.displayNumber), ['1', '2', '3', '4']);
  assert.deepEqual(items.map(item => item.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(items.every(item => item.required));
  assert.ok(listening.every(item => item.interactionType === 'single_choice'));
  assert.ok(writing.every(item => item.interactionType === 'long_text'));
});

test('Listening giữ lựa chọn A/B/C nhưng chưa có đáp án hoặc điểm tự động', () => {
  for (const item of listening) {
    assert.deepEqual(item.options.map(option => option.id), ['A', 'B', 'C']);
    assert.equal(item.graderType, 'none');
    assert.equal(item.maxScore, 0);
  }
  assert.equal(listening[0].prompt,
    'James chose to take Scandinavian Studies because when he was a child');
  assert.deepEqual(listening[0].options.map(option => option.label), [
    'he was often taken to Denmark.',
    'his mother spoke to him in Danish.',
    'a number of Danish people visited his family.'
  ]);
  assert.equal(listening[4].options[2].label,
    'a study of the social background to the literature.');
  assert.deepEqual(gradingKey.items, {});
  assert.equal(JSON.stringify(definition).includes('expectedOptionId'), false);
});

test('Writing bắt đầu ở Agree và mỗi câu dừng tại dấu hỏi chấm đầu tiên', () => {
  assert.ok(writing[0].prompt.startsWith('Với quan điểm Agree:\nGiả sử có nội dung sau:'));
  assert.ok(writing[0].prompt.endsWith('=> XXX có thể là những gì?'));
  assert.equal(writing[1].prompt,
    'Với quan điểm Disagree:\n“Tăng giá đồ ăn gây béo” liệu có khả thi?');
  assert.equal(writing[2].prompt,
    'Kể cả có tăng giá được, liệu có thật là nạn béo phì sẽ được giải quyết?');
  assert.ok(writing[3].prompt.endsWith('vẫn không đáng làm) không?'));
  assert.ok(writing.every(item => item.prompt.split('?').length === 2));
  const visibleText = JSON.stringify(definition);
  for (const excluded of [
    'Đề bài yêu cầu làm điều gì',
    'Bạn có thể trả lời riêng rẽ',
    'Có điều gì khiến biện pháp này khó thực hiện',
    'Với mỗi kịch bản phía trên',
    'Có những người nào liên quan',
    'Tố chất năng lực'
  ]) {
    assert.equal(visibleText.includes(excluded), false, excluded);
  }
});

test('Chỉ đủ chín câu mới hoàn thành; mọi câu không bị chấm đúng sai', () => {
  const responses = Object.fromEntries(items.map((item, index) => [
    item.itemVersionId,
    index < 5 ? 'A' : 'Một ý do học viên tự viết.'
  ]));
  assert.deepEqual(evaluateCompleteness(definition, responses), {
    complete: true,
    missingItemVersionIds: []
  });
  const incomplete = { ...responses };
  delete incomplete[writing[3].itemVersionId];
  assert.deepEqual(evaluateCompleteness(definition, incomplete), {
    complete: false,
    missingItemVersionIds: [writing[3].itemVersionId]
  });
  const result = gradeLearningSubmission({ definition, gradingKey, responses });
  assert.equal(result.summary.answered, 9);
  assert.equal(result.summary.maxScore, 0);
  assert.ok(result.items.every(item => item.verdict === 'ungraded'));
});
