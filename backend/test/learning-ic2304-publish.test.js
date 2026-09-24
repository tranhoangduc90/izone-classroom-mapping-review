import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = new URL('../scripts/publish-ic2304-session2.mjs', import.meta.url);
const safeEnv = { ...process.env, LEARNING_DATABASE_URL: '' };

function run(args = []) {
  return spawnSync(process.execPath, [fileURLToPath(script), ...args], {
    encoding: 'utf8',
    env: safeEnv
  });
}

test('lệnh mặc định chỉ lập kế hoạch, không cần kết nối database', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.classCode, 'IC2304');
  assert.equal(plan.courseCode, '67');
  assert.equal(plan.sessionNumber, 2);
  assert.deepEqual(plan.blocks.map(block => [block.items, block.initialStatus]), [
    [5, 'open'], [4, 'locked']
  ]);
  assert.equal(plan.scoredItems, 0);
  assert.equal(result.stdout.includes('student_name'), false);
});

test('mã khóa sai bị chặn trước mọi kết nối', () => {
  const result = run(['--course-code=bad value']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID_COURSE_CODE/);
});

test('chế độ ghi thiếu kết nối bị chặn trước mọi mutation', () => {
  const result = run(['--apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LEARNING_DATABASE_URL_REQUIRED/);
});
