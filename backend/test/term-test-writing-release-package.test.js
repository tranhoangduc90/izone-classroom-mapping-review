import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const releaseRoot = new URL('../ops/releases/term-test-writing-webhook-4-20260922/', import.meta.url);

test('gói phát hành kế thừa image quyền admin và chỉ thay server wiring', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', releaseRoot), 'utf8');
  assert.match(dockerfile, /^FROM izone-term-test-backend:20260922\.1-admin-access$/m);
  assert.match(dockerfile, /^COPY --chown=node:node src\/server\.js \/app\/src\/server\.js$/m);
  assert(!/^COPY .*term-test-writing-grading\.js/m.test(dockerfile));
  assert(!/^COPY .*term-test-writing-notifier\.js/m.test(dockerfile));
  assert(!/^COPY .*src\/(?:auth|app|sql)\.js/m.test(dockerfile));
  assert.equal((dockerfile.match(/COPY /g) || []).length, 1);
});

test('gói phát hành có image mới riêng và không đổi tên service production', async () => {
  const compose = await readFile(new URL('compose.override.yml', releaseRoot), 'utf8');
  assert.match(compose, /^\s{2}mapping-review-api:$/m);
  assert.match(compose, /image: izone-term-test-backend:20260923\.1-writing-webhook-4/);
  assert.match(compose, /dockerfile: ops\/releases\/term-test-writing-webhook-4-20260922\/Dockerfile/);
});
