import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildEvidenceEnvelope,
  buildStudentQuizResult,
  evaluateCompleteness,
  gradeLearningSubmission,
  sha256,
  stableStringify
} from '../src/learning-domain.js';
import { parseFormDefinition } from '../src/learning-contracts.js';

const ids = {
  form: '20000000-0000-4000-8000-000000000001',
  block: '20000000-0000-4000-8000-000000000002',
  reflectionFamily: '20000000-0000-4000-8000-000000000003',
  reflection: '20000000-0000-4000-8000-000000000004',
  completionFamily: '20000000-0000-4000-8000-000000000005',
  completion: '20000000-0000-4000-8000-000000000006',
  choiceFamily: '20000000-0000-4000-8000-000000000007',
  choice: '20000000-0000-4000-8000-000000000008',
  pairFamily1: '20000000-0000-4000-8000-000000000009',
  pair1: '20000000-0000-4000-8000-000000000010',
  pairFamily2: '20000000-0000-4000-8000-000000000011',
  pair2: '20000000-0000-4000-8000-000000000012',
  writingFamily: '20000000-0000-4000-8000-000000000013',
  writing: '20000000-0000-4000-8000-000000000014'
};

function item(overrides) {
  return {
    itemFamilyId: crypto.randomUUID(),
    itemVersionId: crypto.randomUUID(),
    position: 1,
    prompt: 'Câu hỏi kiểm thử',
    helpText: '',
    interactionType: 'short_text',
    pedagogicalTypeCode: 'reflection',
    layoutType: 'plain_prompt',
    graderType: 'none',
    groupId: null,
    required: true,
    maxScore: 0,
    options: [],
    skillCodes: [],
    releasePolicy: 'inherit',
    ...overrides
  };
}

function makeDefinition(answerReleasePolicy = 'hidden') {
  return {
    schemaVersion: 'FormDefinitionV1',
    formVersionId: ids.form,
    title: 'Phiếu kiểm thử',
    kind: 'mixed',
    answerReleasePolicy,
    blocks: [{
      blockId: ids.block,
      checkpoint: 1,
      title: 'Ghi nhanh 1',
      instructions: '',
      items: [
        item({ itemFamilyId: ids.reflectionFamily, itemVersionId: ids.reflection, position: 1 }),
        item({
          itemFamilyId: ids.completionFamily,
          itemVersionId: ids.completion,
          position: 2,
          pedagogicalTypeCode: 'form_completion',
          graderType: 'accepted_text',
          maxScore: 1
        }),
        item({
          itemFamilyId: ids.choiceFamily,
          itemVersionId: ids.choice,
          position: 3,
          interactionType: 'single_choice',
          pedagogicalTypeCode: 'true_false_not_given',
          graderType: 'exact_option',
          maxScore: 1,
          options: ['TRUE', 'FALSE', 'NOT_GIVEN'].map(id => ({ id, label: id.replace('_', ' ') }))
        }),
        item({
          itemFamilyId: ids.pairFamily1,
          itemVersionId: ids.pair1,
          position: 4,
          interactionType: 'multi_choice_group',
          pedagogicalTypeCode: 'multiple_choice',
          graderType: 'unordered_group_slot',
          groupId: 'PAIR_4_5',
          maxScore: 1,
          options: ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, label: id }))
        }),
        item({
          itemFamilyId: ids.pairFamily2,
          itemVersionId: ids.pair2,
          position: 5,
          interactionType: 'multi_choice_group',
          pedagogicalTypeCode: 'multiple_choice',
          graderType: 'unordered_group_slot',
          groupId: 'PAIR_4_5',
          maxScore: 1,
          options: ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, label: id }))
        }),
        item({
          itemFamilyId: ids.writingFamily,
          itemVersionId: ids.writing,
          position: 6,
          interactionType: 'long_text',
          pedagogicalTypeCode: 'writing_task_2',
          graderType: 'rubric_async',
          maxScore: 9
        })
      ]
    }]
  };
}

function makeGradingKey() {
  return {
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: ids.form,
    graderVersion: 1,
    items: {
      [ids.completion]: {
        graderType: 'accepted_text',
        accepted: ['colour', 'blue-green'],
        normalization: {
          unicode: 'NFKC',
          caseInsensitive: true,
          collapseWhitespace: true,
          acceptedWordCountMax: 2
        }
      },
      [ids.choice]: { graderType: 'exact_option', expectedOptionId: 'TRUE' },
      [ids.writing]: { graderType: 'rubric_async', rubricCode: 'ielts_writing_task_2', rubricVersion: 1 }
    },
    groups: {
      PAIR_4_5: { graderType: 'unordered_group_slot', expectedOptionIds: ['A', 'E'] }
    }
  };
}

const completeResponses = {
  [ids.reflection]: 'Em cần xem lại cách chọn heading.',
  [ids.completion]: ' Color ',
  [ids.choice]: 'TRUE',
  [ids.pair1]: 'E',
  [ids.pair2]: 'A',
  [ids.writing]: 'Bài viết giả dùng để kiểm thử hàng đợi.'
};

test('FormDefinitionV1 biểu diễn đủ taxonomy Term Test mà không trộn với interaction', () => {
  const taxonomy = [
    'form_completion', 'note_completion', 'table_completion', 'sentence_completion',
    'summary_completion', 'short_answer', 'multiple_choice', 'matching_headings',
    'matching_features', 'matching_information', 'true_false_not_given',
    'yes_no_not_given', 'map_labelling', 'writing_task_1', 'writing_task_2'
  ];
  for (const [index, pedagogicalTypeCode] of taxonomy.entries()) {
    const interactionType = pedagogicalTypeCode.startsWith('writing') ? 'long_text' : 'short_text';
    const graderType = pedagogicalTypeCode.startsWith('writing') ? 'rubric_async' : 'none';
    const definition = makeDefinition();
    definition.blocks[0].items = [item({
      itemFamilyId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      itemVersionId: `30000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
      position: 1,
      interactionType,
      pedagogicalTypeCode,
      graderType,
      maxScore: graderType === 'none' ? 0 : 9
    })];
    assert.equal(parseFormDefinition(definition).blocks[0].items[0].pedagogicalTypeCode, pedagogicalTypeCode);
  }
});

test('chấm text, choice và choose TWO đảo thứ tự; Writing chuyển sang pending', () => {
  const result = gradeLearningSubmission({
    definition: makeDefinition(),
    gradingKey: makeGradingKey(),
    responses: completeResponses
  });
  assert.equal(result.summary.answered, 6);
  assert.equal(result.summary.scoreEarned, 4);
  assert.equal(result.summary.maxScore, 13);
  assert.equal(result.gradingStatus, 'pending');
  assert.equal(result.items.find(value => value.itemVersionId === ids.completion).verdict, 'correct');
  assert.equal(result.items.find(value => value.itemVersionId === ids.pair1).verdict, 'correct');
  assert.equal(result.items.find(value => value.itemVersionId === ids.pair2).verdict, 'correct');
  assert.equal(result.items.find(value => value.itemVersionId === ids.writing).verdict, 'pending');
});

test('choose TWO không cho một lựa chọn trùng ăn hai điểm', () => {
  const responses = { ...completeResponses, [ids.pair1]: 'A', [ids.pair2]: 'A' };
  const result = gradeLearningSubmission({ definition: makeDefinition(), gradingKey: makeGradingKey(), responses });
  const pair = result.items.filter(value => [ids.pair1, ids.pair2].includes(value.itemVersionId));
  assert.equal(pair.filter(value => value.verdict === 'correct').length, 1);
  assert.equal(pair.reduce((sum, value) => sum + value.scoreEarned, 0), 1);
});

test('completeness phụ thuộc trường bắt buộc, không phụ thuộc điểm hoặc AI', () => {
  const complete = evaluateCompleteness(makeDefinition(), completeResponses);
  const incomplete = evaluateCompleteness(makeDefinition(), { ...completeResponses, [ids.reflection]: '' });
  assert.equal(complete.complete, true);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missingItemVersionIds, [ids.reflection]);
});

test('kết quả tự khai được lưu dạng số có mẫu số cố định, không bị coi là điểm máy chấm', () => {
  const definition = makeDefinition();
  const scoreItem = item({
    itemFamilyId: '31000000-0000-4000-8000-000000000001',
    itemVersionId: '31000000-0000-4000-8000-000000000002',
    interactionType: 'number_score',
    interactionConfig: { min: 0, max: 10, step: 1, unit: 'câu đúng' },
    evidenceSource: 'student_self_report'
  });
  definition.blocks[0].items = [scoreItem];
  const gradingKey = {
    schemaVersion: 'FormGradingKeyV1',
    formVersionId: ids.form,
    graderVersion: 1,
    items: {},
    groups: {}
  };
  const result = gradeLearningSubmission({
    definition,
    gradingKey,
    responses: { [scoreItem.itemVersionId]: { correct: 8, total: 10 } }
  });
  assert.equal(result.items[0].verdict, 'ungraded');
  assert.deepEqual(result.items[0].rawAnswer, { correct: 8, total: 10 });
  assert.equal(result.summary.maxScore, 0);
  assert.throws(
    () => evaluateCompleteness(definition, { [scoreItem.itemVersionId]: { correct: 8, total: 12 } }),
    error => error.code === 'NUMBER_SCORE_INVALID'
  );
});

test('kết quả học viên mặc định không chứa đáp án riêng tư', () => {
  const internal = gradeLearningSubmission({ definition: makeDefinition(), gradingKey: makeGradingKey(), responses: completeResponses });
  const student = buildStudentQuizResult(internal, makeDefinition());
  assert.equal(student.answerRelease, 'hidden');
  assert.equal(Object.hasOwn(student.items[1], 'expectedAnswer'), false);
});

test('EvidenceEnvelope giữ đủ bốn lớp identity và không đưa đáp án chuẩn vào Markdown', () => {
  const result = gradeLearningSubmission({ definition: makeDefinition(), gradingKey: makeGradingKey(), responses: completeResponses });
  const envelope = buildEvidenceEnvelope({
    evidenceId: '40000000-0000-4000-8000-000000000001',
    submissionId: '40000000-0000-4000-8000-000000000002',
    sourceRevision: 1,
    occurredAt: '2026-08-29T10:00:00.000Z',
    ingestedAt: '2026-08-29T10:00:01.000Z',
    organizationKey: 'izone',
    courseCode: 'course-67',
    classId: '2139',
    sessionNumber: 2,
    studentRef: '40000000-0000-4000-8000-000000000003',
    formVersionId: ids.form,
    assignmentId: '40000000-0000-4000-8000-000000000004',
    responses: completeResponses,
    quizResult: result,
    definition: makeDefinition()
  });
  assert.equal(envelope.entityKey, 'student:40000000-0000-4000-8000-000000000003');
  assert.equal(envelope.unitKey, 'submission:40000000-0000-4000-8000-000000000002');
  assert.match(envelope.operationKey, /^grade:/);
  assert.match(envelope.idempotencyKey, /^progress_log:/);
  assert.equal(envelope.markdown.includes('blue-green'), false);
  assert.match(envelope.markdown, /Câu hỏi: Câu hỏi kiểm thử/);
  assert.match(envelope.markdown, /Nguồn nội dung: student_self_report/);
  assert.equal(envelope.contentHash, sha256(stableStringify(envelope.payload)));
});

test('form version mismatch dừng fail-closed trước khi chấm', () => {
  const key = makeGradingKey();
  key.formVersionId = '50000000-0000-4000-8000-000000000001';
  assert.throws(
    () => gradeLearningSubmission({ definition: makeDefinition(), gradingKey: key, responses: completeResponses }),
    error => error.code === 'GRADING_VERSION_MISMATCH'
  );
});
