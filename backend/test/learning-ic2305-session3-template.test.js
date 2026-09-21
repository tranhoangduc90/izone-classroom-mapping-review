import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFormDefinition } from '../src/learning-contracts.js';
import { evaluateCompleteness, gradeLearningSubmission } from '../src/learning-domain.js';
import {
  buildIc2305Session3Definition,
  buildIc2305Session3GradingKey,
  IC2305_SESSION3_TEMPLATE
} from '../src/learning-templates/ic2305-entrance-listening1-speaking2.js';

const definition = buildIc2305Session3Definition();
const gradingKey = buildIc2305Session3GradingKey();
const items = definition.blocks.flatMap(block => block.items);
const itemAt = position => items.find(item => item.position === position);
const id = position => itemAt(position).itemVersionId;

function completeResponses({ speakingIssue = 'IDEAS', includeOther = false } = {}) {
  const values = {
    [id(1)]: 'B',
    [id(2)]: 'Nhân viên tập luyện thường xuyên hơn',
    [id(3)]: speakingIssue,
    [id(5)]: '',
    [id(6)]: 'C',
    [id(7)]: 'B',
    [id(8)]: ['Trọng âm khác nhau', 'Âm cuối khác nhau'],
    [id(9)]: { correct: 5, total: 6 }
  };
  if (includeOther) values[id(4)] = 'Em thường lặp lại cùng một ý.';
  return values;
}

test('mẫu buổi 3 giữ ba checkpoint, tám câu logic và số câu gốc theo từng phần', () => {
  assert.equal(definition.formVersionId, IC2305_SESSION3_TEMPLATE.formVersionId);
  assert.equal(definition.title, 'ENTRANCE TICKET • LISTENING 1 + SPEAKING 2');
  assert.equal(definition.courseCode, '56');
  assert.deepEqual(definition.blocks.map(block => block.title), [
    'Nhìn lại bài học trước',
    'Buổi học hôm nay · Speaking',
    'Buổi học hôm nay · Listening'
  ]);
  assert.deepEqual(items.map(item => item.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(items.filter(item => item.layoutType !== 'conditional_other_text').map(item => item.displayNumber), [
    '1', '2', '1', '2', '1', '2', '3', '4'
  ]);
  assert.equal(itemAt(4).required, false);
  assert.equal(itemAt(5).required, false);
  assert.equal(itemAt(5).evidenceSource, 'student_reported_teacher_feedback');
  assert.equal(itemAt(8).interactionConfig.responseCount, 2);
  assert.equal(itemAt(9).interactionConfig.max, 6);
});

test('chuỗi lập luận giữ đủ hai đầu và chỉ yêu cầu điền ô giữa', () => {
  const item = itemAt(2);
  assert.equal(item.layoutType, 'reasoning_chain_completion');
  assert.equal(item.interactionConfig.beforeText, 'Các công ty xây dựng phòng gym ngay tại trụ sở làm việc');
  assert.equal(item.interactionConfig.afterText, 'Nhân viên cải thiện sức khỏe thể chất');
  const responses = completeResponses();
  responses[id(2)] = 'Có nội dung bất kỳ';
  assert.equal(evaluateCompleteness(definition, responses).complete, true);
});

test('Vấn đề khác chỉ bắt buộc nêu rõ khi học viên chọn phương án OTHER', () => {
  const withoutOther = completeResponses({ speakingIssue: 'OTHER' });
  const incomplete = evaluateCompleteness(definition, withoutOther);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missingItemVersionIds, [id(4)]);

  const completeOther = evaluateCompleteness(
    definition,
    completeResponses({ speakingIssue: 'OTHER', includeOther: true })
  );
  assert.equal(completeOther.complete, true);

  const ordinaryChoice = completeResponses({ speakingIssue: 'VOCABULARY' });
  assert.equal(evaluateCompleteness(definition, ordinaryChoice).complete, true);

  ordinaryChoice[id(4)] = 'Dữ liệu cũ còn sót lại';
  assert.throws(
    () => evaluateCompleteness(definition, ordinaryChoice),
    error => error.code === 'CONDITIONAL_RESPONSE_NOT_APPLICABLE'
  );
});

test('câu nhận xét của giáo viên không bắt buộc và hai ý 15/50 chỉ cần có nội dung', () => {
  const responses = completeResponses();
  delete responses[id(5)];
  responses[id(8)] = ['Ý thứ nhất', 'Ý thứ hai'];
  assert.equal(evaluateCompleteness(definition, responses).complete, true);

  responses[id(8)] = ['Ý thứ nhất', ''];
  assert.deepEqual(evaluateCompleteness(definition, responses).missingItemVersionIds, [id(8)]);
});

test('chỉ ba câu khách quan được chấm và public definition không lộ đáp án', () => {
  const result = gradeLearningSubmission({
    definition,
    gradingKey,
    responses: completeResponses()
  });
  assert.equal(result.summary.scoreEarned, 3);
  assert.equal(result.summary.maxScore, 3);
  assert.deepEqual([1, 6, 7].map(position =>
    result.items.find(item => item.itemVersionId === id(position)).verdict
  ), ['correct', 'correct', 'correct']);
  assert.equal(JSON.stringify(definition).includes('expectedOptionId'), false);
});

test('schema chặn điều kiện hiển thị tham chiếu sai, ngược thứ tự hoặc sai option', () => {
  const missingDependency = structuredClone(definition);
  missingDependency.blocks[1].items[1].interactionConfig.visibleWhenItemVersionId =
    '56000000-0000-4000-8600-999999999999';
  assert.throws(() => parseFormDefinition(missingDependency));

  const laterDependency = structuredClone(definition);
  laterDependency.blocks[1].items[1].interactionConfig.visibleWhenItemVersionId = id(6);
  assert.throws(() => parseFormDefinition(laterDependency));

  const unknownOption = structuredClone(definition);
  unknownOption.blocks[1].items[1].interactionConfig.visibleWhenValue = 'NOT_AN_OPTION';
  assert.throws(() => parseFormDefinition(unknownOption));
});
