import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCompleteness, gradeLearningSubmission } from '../src/learning-domain.js';
import { buildIc2304Session2ScoredDefinition } from '../src/learning-templates/ic2304-session2-scored.js';
import { buildIc2304Session2SpeakingDefinition, buildIc2304Session2SpeakingGradingKey
} from '../src/learning-templates/ic2304-session2-speaking.js';

const definition = buildIc2304Session2SpeakingDefinition();
const key = buildIc2304Session2SpeakingGradingKey(['B', 'B', 'B', 'B', 'B']);
const speaking = definition.blocks[2];
const checklist = speaking.items[0];
const [ideas, vocabulary, other] = speaking.items.slice(1);
const scoped = { ...definition, blocks: [speaking] };

test('v3 giữ Listening/Writing và thêm checklist Speaking đúng tám mục', () => {
  const old = buildIc2304Session2ScoredDefinition();
  assert.notEqual(definition.formVersionId, old.formVersionId);
  assert.deepEqual(definition.blocks.slice(0, 2), old.blocks);
  assert.deepEqual(definition.blocks.map(block => block.title),
    ['Listening · Scandinavian Studies', 'Writing', 'Speaking']);
  assert.deepEqual(checklist.options.map(option => option.id), [
    'IDEAS', 'VOCABULARY', 'FLUENCY', 'PRONUNCIATION', 'GRAMMAR',
    'COHERENCE', 'NO_MAJOR_ISSUE', 'OTHER'
  ]);
  assert.equal(checklist.interactionConfig.maxSelections, 2);
  assert.equal(checklist.interactionConfig.exclusiveOptionId, 'NO_MAJOR_ISSUE');
  assert.equal(JSON.stringify(definition).includes('expectedOptionId'), false);
  assert.equal(key.formVersionId, definition.formVersionId);
  assert.equal(Object.keys(key.items).length, 5);
});

test('mục nhập chữ chỉ bắt buộc khi được chọn, Speaking không chấm điểm', () => {
  const selected = { [checklist.itemVersionId]: ['IDEAS', 'VOCABULARY'] };
  const missing = evaluateCompleteness(scoped, selected);
  assert.deepEqual(missing.missingItemVersionIds,
    [ideas.itemVersionId, vocabulary.itemVersionId]);
  const completed = { ...selected, [ideas.itemVersionId]: 'Em thiếu ví dụ',
    [vocabulary.itemVersionId]: 'Em thiếu từ về môi trường' };
  assert.equal(evaluateCompleteness(scoped, completed).complete, true);
  const result = gradeLearningSubmission({ definition: scoped, gradingKey: key,
    responses: completed });
  assert.equal(result.summary.maxScore, 0);
  assert.ok(result.items.every(item => item.verdict === 'ungraded'));
  assert.equal(evaluateCompleteness(scoped, {
    [checklist.itemVersionId]: ['OTHER'], [other.itemVersionId]: 'Nói quá nhanh'
  }).complete, true);
});

test('máy chủ chặn quá hai mục, mục lạ, mục trùng và chọn không-vấn-đề cùng mục khác', () => {
  for (const options of [
    ['IDEAS', 'VOCABULARY', 'GRAMMAR'], ['IDEAS', 'IDEAS'],
    ['IDEAS', 'UNKNOWN'], ['NO_MAJOR_ISSUE', 'GRAMMAR']
  ]) {
    assert.throws(() => evaluateCompleteness(scoped, {
      [checklist.itemVersionId]: options
    }), error => error.code === 'CHECKLIST_SELECTION_INVALID');
  }
  assert.throws(() => evaluateCompleteness(scoped, {
    [checklist.itemVersionId]: ['GRAMMAR'], [ideas.itemVersionId]: 'Ý còn cũ'
  }), error => error.code === 'CONDITIONAL_RESPONSE_NOT_APPLICABLE');
});

test('lệnh nâng cấp chỉ lập kế hoạch khi chưa có quyền ghi', () => {
  const script = fileURLToPath(new URL('../scripts/upgrade-ic2304-session2-speaking.mjs', import.meta.url));
  const env = { ...process.env, LEARNING_DATABASE_URL: '' };
  const planned = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.newFormVersionId, definition.formVersionId);
  assert.equal(plan.requiresNoAttempts, true);
  assert.equal(plan.requiresDistinctApproverOrCourseLead, true);
  const rejected = spawnSync(process.execPath, [script, '--apply'], { encoding: 'utf8', env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /LEARNING_DATABASE_URL_REQUIRED/);
  const unsafeDeletion = spawnSync(process.execPath,
    [script, '--apply', '--remove-single-test-attempt', '--approver=reviewer@example.org'],
    { encoding: 'utf8', env: { ...env, LEARNING_DATABASE_URL: 'postgres://unused/unused' } });
  assert.notEqual(unsafeDeletion.status, 0);
  assert.match(unsafeDeletion.stderr, /TEST_ATTEMPT_BACKUP_HASH_REQUIRED/);
});

test('gói triển khai chỉ gọi canary có thật trong image', () => {
  const canary = fileURLToPath(new URL('../scripts/check-ic2304-release.mjs', import.meta.url));
  const dockerfile = fileURLToPath(new URL('../ops/releases/progress-log-ic2304-session2-20260924/Dockerfile', import.meta.url));
  const deploy = fileURLToPath(new URL('../ops/releases/progress-log-ic2304-session2-20260924/deploy-api.sh', import.meta.url));
  assert.equal(existsSync(canary), true);
  assert.match(readFileSync(dockerfile, 'utf8'), /COPY backend\/scripts\/check-ic2304-release\.mjs \/app\/scripts\/check-ic2304-release\.mjs/);
  assert.match(readFileSync(deploy, 'utf8'), /docker exec "\$old_name" node scripts\/check-ic2304-release\.mjs/);
});
