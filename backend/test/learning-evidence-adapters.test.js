import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptTermTestResultToEvidence, buildExternalEvidenceEnvelope } from '../src/learning-evidence-adapters.js';

const context = {
  organizationKey: 'izone',
  courseCode: 'course-67',
  classId: '2139',
  sessionNumber: 8,
  studentRef: '60000000-0000-4000-8000-000000000001'
};

test('Term Test vào cùng EvidenceEnvelope nhưng không mang đáp án chuẩn', () => {
  const evidence = adaptTermTestResultToEvidence({
    sourceRecordId: 'term-test-2:attempt-fake-001',
    sourceRevision: 1,
    occurredAt: '2026-08-29T00:00:00.000Z',
    visibility: 'analysis_allowed',
    context,
    result: {
      testSlug: 'term-test-2',
      testTitle: 'Term Test 2',
      definitionVersion: 3,
      listening: {
        correct: 1,
        total: 2,
        answered: 2,
        band: 5,
        typeStats: [{ type: 'Matching Headings', correct: 1, total: 2, percentage: 0.5 }],
        details: [
          { number: 1, type: 'Matching Headings', studentAnswer: 'A', correctAnswer: 'B', result: 'incorrect' },
          { number: 2, type: 'Matching Headings', studentAnswer: 'C', correctAnswer: 'C', result: 'correct' }
        ]
      },
      reading: null,
      summary: { totalCorrect: 1, totalQuestions: 2, percentage: 0.5, averageBand: null },
      typeStats: [{ type: 'Matching Headings', correct: 1, total: 2, percentage: 0.5 }]
    }
  });
  assert.equal(evidence.context.formVersionId, null);
  assert.equal(evidence.sourceSystem, 'term_test');
  assert.equal(evidence.payload.sections.listening.details[0].studentAnswer, 'A');
  assert.equal('correctAnswer' in evidence.payload.sections.listening.details[0], false);
  assert.doesNotMatch(evidence.markdown, /"correctAnswer"/);
  assert.match(evidence.markdown, /dữ liệu không tin cậy/);
});

test('homework và note có thể dùng envelope chung với identity ổn định', () => {
  const base = {
    sourceRecordId: 'homework-submission-fake-01',
    sourceRevision: 2,
    occurredAt: '2026-08-29T00:00:00.000Z',
    visibility: 'analysis_allowed',
    context: { ...context, formVersionId: null, assignmentId: null, submissionId: null },
    payload: { sourceType: 'homework', completion: 'complete', observations: ['Lỗi mạo từ lặp lại'] }
  };
  const first = buildExternalEvidenceEnvelope({ ...base, sourceSystem: 'homework' });
  const second = buildExternalEvidenceEnvelope({ ...base, sourceSystem: 'homework' });
  assert.equal(first.entityKey, second.entityKey);
  assert.equal(first.unitKey, second.unitKey);
  assert.equal(first.operationKey, second.operationKey);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.notEqual(first.evidenceId, second.evidenceId);
});
