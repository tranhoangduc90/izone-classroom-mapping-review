import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStudentQuizResult,
  evaluateCompleteness,
  gradeLearningSubmission
} from '../src/learning-domain.js';
import {
  buildIc2305EntranceDefinition,
  buildIc2305EntranceGradingKey,
  IC2305_ENTRANCE_TEMPLATE
} from '../src/learning-templates/ic2305-entrance-reading1-listening1.js';
import { createLearningService } from '../src/learning-service.js';

const definition = buildIc2305EntranceDefinition();
const gradingKey = buildIc2305EntranceGradingKey();
const items = definition.blocks.flatMap(block => block.items);
const id = position => items.find(item => item.position === position).itemVersionId;

function completeResponses() {
  return {
    [id(1)]: 'Em khó ở phần phân biệt FALSE và NOT GIVEN vì chưa xác định được phạm vi thông tin.',
    [id(2)]: 'Cách dùng deciding keywords giúp em kiểm tra bằng chứng nhanh hơn.',
    [id(3)]: 'C',
    [id(4)]: 'B',
    [id(5)]: ['Trọng âm khác nhau', 'Âm cuối khác nhau'],
    [id(6)]: ['Tên riêng', 'Số', 'Ngày tháng'],
    [id(7)]: 'SAI',
    [id(8)]: ['Từ tuyệt đối', 'So sánh']
  };
}

test('mẫu IC2305 giữ đúng 3 phần, 8 câu và thời lượng 5 phút', () => {
  assert.equal(definition.formVersionId, IC2305_ENTRANCE_TEMPLATE.formVersionId);
  assert.equal(definition.estimatedMinutes, 5);
  assert.deepEqual(definition.blocks.map(block => block.checkpoint), [1, 2, 3]);
  assert.deepEqual(items.map(item => item.position), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([5, 6, 8].map(position => items.find(item => item.position === position).interactionConfig.responseCount), [2, 3, 2]);
});

test('ba câu khách quan chấm đúng nhưng đáp án không xuất hiện trong definition công khai', () => {
  const responses = completeResponses();
  const result = gradeLearningSubmission({ definition, gradingKey, responses });
  assert.equal(result.summary.scoreEarned, 3);
  assert.equal(result.summary.maxScore, 3);
  assert.deepEqual([3, 4, 7].map(position => result.items.find(item => item.itemVersionId === id(position)).verdict), [
    'correct', 'correct', 'correct'
  ]);
  const publicJson = JSON.stringify(definition);
  assert.equal(publicJson.includes('expectedOptionId'), false);
  const studentResult = buildStudentQuizResult(result, definition);
  assert.equal(studentResult.answerRelease, 'hidden');
  assert.equal(studentResult.items.some(item => Object.hasOwn(item, 'expectedAnswer')), false);
});

test('nhóm ô đánh số chỉ hoàn tất khi mọi ô đều có nội dung', () => {
  const responses = completeResponses();
  responses[id(5)] = ['Có trọng âm', ''];
  const incomplete = evaluateCompleteness(definition, responses);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missingItemVersionIds, [id(5)]);
  responses[id(5)] = ['Có trọng âm'];
  assert.throws(
    () => evaluateCompleteness(definition, responses),
    error => error.code === 'NUMBERED_TEXT_GROUP_INVALID'
  );
});

test('câu trả lời dạng mảng bị từ chối ở câu text thường để tránh lệch contract', () => {
  const responses = completeResponses();
  responses[id(1)] = ['không hợp lệ'];
  assert.throws(
    () => evaluateCompleteness(definition, responses),
    error => error.code === 'RESPONSE_TYPE_MISMATCH'
  );
});

test('live dashboard chỉ trả verdict cho GV, không chuyển expectedAnswer xuống trình duyệt', async () => {
  const service = createLearningService({
    pool: {
      async query() {
        return {
          rowCount: 1,
          rows: [{
            assignment_id: '57000000-0000-4000-8000-000000000001',
            generated_at: '2026-09-16T00:00:00.000Z',
            students: [{
              studentRef: '57000000-0000-4000-8100-000000000001',
              gradingResult: {
                schemaVersion: 'QuizResultV1',
                items: [{ itemVersionId: id(3), verdict: 'correct', expectedAnswer: 'C' }]
              }
            }]
          }]
        };
      }
    }
  });
  const live = await service.getTeacherLiveDrafts({
    assignmentId: '57000000-0000-4000-8000-000000000001',
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false }
  });
  assert.equal(live.students[0].gradingResult.items[0].verdict, 'correct');
  assert.equal(Object.hasOwn(live.students[0].gradingResult.items[0], 'expectedAnswer'), false);
});
