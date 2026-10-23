// Bản dùng trong sản phẩm phải giống module đã kiểm; không cho hai bản âm thầm lệch nhau.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=url=>readFileSync(url,'utf8').replaceAll('\r\n','\n');
assert.equal(source(new URL('../src/submission-status.mjs',import.meta.url)),
  source(new URL('../../../backend/ops/releases/term-mini-submit-20261023/submission-status.mjs',import.meta.url)));
await import('../../../backend/ops/releases/term-mini-submit-20261023/submission-status.test.mjs');
