import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStudentQuizResult, evaluateCompleteness, gradeLearningSubmission
} from '../src/learning-domain.js';
import {
  buildIc2305Session4Definition, buildIc2305Session4GradingKey
} from '../src/learning-templates/ic2305-session4-listening1-speaking2.js';

const definition = buildIc2305Session4Definition();
const key = buildIc2305Session4GradingKey();
const items = definition.blocks.flatMap(block => block.items);
const id = number => items[number - 1].itemVersionId;

function responses(speaking = 'FLUENCY') {
  return {
    [id(1)]: 'Em đã hiểu cách dự đoán từ cần nghe.',
    [id(2)]: ['số lượng từ', 'loại từ', 'từ khóa'],
    [id(3)]: ['số', 'tên riêng', 'thuật ngữ'],
    [id(4)]: 'FALSE',
    [id(5)]: { correct: 4, total: 6 },
    [id(6)]: { correct: 5, total: 7 },
    [id(7)]: speaking,
    ...(speaking === 'OTHER' ? { [id(8)]: 'Em còn khó ở phần giữ nhịp nói.' } : {})
  };
}

test('Buổi 4 có hai phần, các ô Listening và mức tự báo cáo đúng tài liệu', () => {
  assert.equal(definition.title, 'Buổi 4 - Listening 1 + Speaking 2');
  assert.deepEqual(definition.blocks.map(block => block.checkpoint), [1, 2]);
  assert.equal(items.length, 8);
  assert.deepEqual(items[1].interactionConfig.sentenceLines.map(line => line.title),
    ['Bước 1:', 'Bước 2:', 'Bước 3:', 'Bước 4:']);
  assert.deepEqual([items[4].interactionConfig.max, items[5].interactionConfig.max], [6, 7]);
  assert.deepEqual(items[6].options.map(option => option.id),
    ['IDEAS', 'VOCABULARY', 'FLUENCY', 'PRONUNCIATION', 'GRAMMAR', 'COHERENCE', 'NO_MAJOR_ISSUE', 'OTHER']);
  assert.equal(evaluateCompleteness(definition, responses()).complete, true);
  assert.equal(evaluateCompleteness(definition, responses('OTHER')).complete, true);
  const missingOther = responses('OTHER');
  delete missingOther[id(8)];
  assert.equal(evaluateCompleteness(definition, missingOther).complete, false);
});

test('đáp án tô vàng chỉ nằm trong khóa riêng và không hiện cho học viên', () => {
  assert.deepEqual(key.referenceAnswers[id(2)],
    ['số lượng từ', 'loại từ/số hoặc chữ', 'keywords/từ khóa']);
  assert.deepEqual(key.referenceAnswers[id(3)],
    ['số', 'tên riêng', 'từ chuyên ngành/thuật ngữ/terminology']);
  assert.equal(key.items[id(4)].expectedOptionId, 'FALSE');
  const publicJson = JSON.stringify(definition);
  assert.equal(publicJson.includes('referenceAnswers'), false);
  assert.equal(publicJson.includes('expectedOptionId'), false);
  const grade = gradeLearningSubmission({ definition, gradingKey: key, responses: responses() });
  assert.equal(grade.summary.maxScore, 1);
  assert.equal(grade.summary.scoreEarned, 1);
  const student = buildStudentQuizResult(grade, definition);
  assert.equal(student.answerRelease, 'hidden');
  assert.equal(student.items.some(item => Object.hasOwn(item, 'expectedAnswer')), false);
});
