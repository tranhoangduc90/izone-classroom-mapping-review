// Bản dùng trong sản phẩm phải giống module đã kiểm; không cho hai bản âm thầm lệch nhau.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
assert.equal(readFileSync(new URL('../src/submission-status.mjs',import.meta.url),'utf8'),
  readFileSync(new URL('../../../backend/ops/releases/term-mini-submit-20261023/submission-status.mjs',import.meta.url),'utf8'));
await import('../../../backend/ops/releases/term-mini-submit-20261023/submission-status.test.mjs');
