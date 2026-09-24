import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealSourceTree, verifyFileHash, verifySourceHash } from
  '../ops/releases/k56-class-access-20260924/verify-source-hashes.mjs';

test('dấu source khớp hợp đồng stage và phát hiện một byte bị đổi', () => {
  // Dữ liệu vào: hai module JS giả trong thư mục tạm.
  // Việc chính: tính dấu theo đường dẫn + bytes, rồi thay một file.
  // Kết quả: bản đầu khớp, bản đã đổi bị từ chối trước khi build image.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k56-source-seal-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'nested', 'b.js'), 'export const b = 2;\n');
    const expected = crypto.createHash('sha256')
      .update('src/a.js\0').update('export const a = 1;\n').update('\0')
      .update('src/nested/b.js\0').update('export const b = 2;\n').update('\0')
      .digest('hex');
    assert.deepEqual(sealSourceTree(root), { sha256: expected, files: 2 });
    assert.equal(verifySourceHash(root, expected).files, 2);
    fs.writeFileSync(path.join(root, 'nested', 'b.js'), 'export const b = 3;\n');
    assert.throws(() => verifySourceHash(root, expected), /SOURCE_HASH_MISMATCH/);
    assert.throws(() => verifySourceHash(root, 'wrong'), /EXPECTED_SOURCE_HASH_INVALID/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dấu package/lock chặn image nền sai bản', () => {
  const filename = path.join(os.tmpdir(), `k56-package-seal-${process.pid}.json`);
  try {
    fs.writeFileSync(filename, '{"dependencies":{}}\n');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filename))
      .digest('hex');
    assert.equal(verifyFileHash(filename, hash), hash);
    assert.throws(() => verifyFileHash(filename, '0'.repeat(64)), /FILE_HASH_MISMATCH/);
  } finally {
    fs.rmSync(filename, { force: true });
  }
});
