import assert from 'node:assert/strict';
import test from 'node:test';
import { percentile } from '../scripts/learning-load-benchmark.mjs';

test('percentile dùng nearest-rank cho tiêu chí p95', () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([1, 5, 2, 4, 3], 0.5), 3);
  assert.equal(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.95), 95);
});
