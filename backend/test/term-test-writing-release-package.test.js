import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const releaseRoot = new URL('../ops/releases/term-test-writing-webhook-4-20260922/', import.meta.url);

test('gói phát hành kế thừa image quyền admin và chỉ thay ba file hàng chấm', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', releaseRoot), 'utf8');
  assert.match(dockerfile, /^FROM izone-term-test-backend:20260922\.1-admin-access$/m);
  for (const file of ['src/server.js', 'src/term-test-writing-grading.js', 'src/term-test-writing-notifier.js']) {
    assert.match(dockerfile, new RegExp(file.replaceAll('.', '\\.')));
  }
  for (const protectedFile of ['src/auth.js', 'src/app.js', 'src/sql.js']) {
    assert(!dockerfile.includes(protectedFile));
  }
  assert.equal((dockerfile.match(/COPY /g) || []).length, 1);
});

test('gói phát hành có image mới riêng và không đổi tên service production', async () => {
  const compose = await readFile(new URL('compose.override.yml', releaseRoot), 'utf8');
  assert.match(compose, /^\s{2}mapping-review-api:$/m);
  assert.match(compose, /image: izone-term-test-backend:20260922\.2-writing-webhook-4/);
  assert.match(compose, /dockerfile: ops\/releases\/term-test-writing-webhook-4-20260922\/Dockerfile/);
});
