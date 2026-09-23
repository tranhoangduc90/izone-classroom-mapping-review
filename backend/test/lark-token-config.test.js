import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const worker of ['writing-portal-worker.js', 'lark-replica-worker.js']) {
  test(`${worker} lấy mã Base từ môi trường thay vì nhúng vào source`, async () => {
    const source = await readFile(new URL(`../src/${worker}`, import.meta.url), 'utf8');
    assert.equal(/DEFAULT_BASE_APP_TOKEN\s*=\s*['"][^'"]+['"]/.test(source), false);
    assert.match(source, /required\('LARK_BASE_APP_TOKEN'\)/);
  });
}
