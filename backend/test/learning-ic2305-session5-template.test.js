import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStudentQuizResult, evaluateCompleteness, gradeLearningSubmission
} from '../src/learning-domain.js';
import {
  buildIc2305Session5Definition, buildIc2305Session5GradingKey
} from '../src/learning-templates/ic2305-session5-reading-writing-speaking.js';

const definition = buildIc2305Session5Definition();
const key = buildIc2305Session5GradingKey();
const items = definition.blocks.flatMap(block => block.items);
const id = number => items[number - 1].itemVersionId;

function responses(speaking = 'FLUENCY') {
  return {
    [id(1)]: 'Em hiểu cách tìm từ khóa.',
    [id(2)]: 'B',
    [id(3)]: 'C',
    [id(4)]: 'C',
    [id(5)]: 'B',
    [id(6)]: ['Dùng từ chỉ khả năng', 'Giới hạn phạm vi khẳng định'],
    [id(7)]: speaking,
    ...(speaking === 'OTHER' ? { [id(8)]: 'Em chưa kiểm soát tốc độ nói.' } : {})
  };
}

test('Buổi 5 giữ hai phần, bảy câu gốc và các lựa chọn trong tài liệu', () => {
  assert.equal(definition.title, 'Buổi 5 - Reading, Writing và Speaking');
  assert.deepEqual(definition.blocks.map(block => block.checkpoint), [1, 2]);
  assert.deepEqual(definition.blocks.map(block => block.items.length), [3, 5]);
  assert.deepEqual(items.filter(item => item.layoutType !== 'conditional_other_text')
    .map(item => item.displayNumber), ['1', '2', '3', '1', '2', '3', '4']);
  assert.equal(items[0].prompt,
    'Em thấy nội dung nào trong buổi học trước hữu ích nhất đối với việc học hoặc làm bài của mình? Hãy nêu rõ kiến thức đó là gì.');
  assert.deepEqual(items[1].options.map(option => option.label), [
    'Vì từ đó dài, dễ thấy hơi các từ ngắn',
    'Vì từ đó khó bị paraphrase',
    'Vì từ đó chắc chắn sẽ xuất hiện y hệt trong bài đọc'
  ]);
  assert.deepEqual(items[3].options.map(option => option.label), [
    'Giảm lượng khí thải độc hại ra môi trường.',
    'Người dân được vận động cơ thể nhiều hơn.',
    'Giảm nguy cơ mắc các bệnh về tim mạch.'
  ]);
  assert.equal(items[5].interactionConfig.responseCount, 2);
  assert.deepEqual(items[5].interactionConfig.responseLabels, ['Kỹ thuật 1', 'Kỹ thuật 2']);
  assert.equal(items[6].options.length, 8);
  assert.equal(items[7].interactionConfig.visibleWhenValue, 'OTHER');
});

test('Câu tự luận không chấm; chỉ bốn câu kiến thức nhận điểm', () => {
  const grade = gradeLearningSubmission({ definition, gradingKey: key, responses: responses() });
  assert.equal(grade.summary.maxScore, 4);
  assert.equal(grade.summary.scoreEarned, 4);
  for (const number of [1, 6, 7, 8]) {
    assert.equal(items[number - 1].graderType, 'none');
    assert.equal(items[number - 1].maxScore, 0);
    assert.equal(grade.items[number - 1].verdict, 'ungraded');
    assert.equal(Object.hasOwn(key.items, id(number)), false);
  }
  const student = buildStudentQuizResult(grade, definition);
  assert.equal(student.answerRelease, 'hidden');
  assert.equal(student.items.some(item => Object.hasOwn(item, 'expectedAnswer')), false);
  assert.equal(JSON.stringify(definition).includes('expectedOptionId'), false);
});

test('Hai kỹ thuật Hedging và chi tiết Vấn đề khác được kiểm đủ khi cần', () => {
  assert.equal(evaluateCompleteness(definition, responses()).complete, true);
  assert.equal(evaluateCompleteness(definition, responses('OTHER')).complete, true);
  const oneTechnique = responses();
  oneTechnique[id(6)] = ['Dùng từ chỉ khả năng', ''];
  assert.equal(evaluateCompleteness(definition, oneTechnique).complete, false);
  const missingOther = responses('OTHER');
  delete missingOther[id(8)];
  assert.equal(evaluateCompleteness(definition, missingOther).complete, false);
});
