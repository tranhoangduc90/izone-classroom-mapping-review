// Kiểm miếng vá hẹp dùng đúng snapshot, giữ mọi thay đổi runtime đang có.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { identityRuntimePatch } from '../scripts/prepare-student-identity-runtime.mjs';
const original = Buffer.from("// Mã live riêng\r\nimport express from 'express';\r\nfunction app(){\r\n  const preserved='sửa mới của Linh';\r\n  app.get('/api/term-tests/roster', limiter, oldHandler);\r\n}\r\n");
const expectedSha = createHash('sha256').update(original).digest('hex');
for (const family of ['mapping', 'k56', 'k67']) test(`Vá ${family}: giữ đúng source cũ và middleware riêng`, () => {
  const result = identityRuntimePatch({ source: original, expectedSha, family });
  assert.equal(result.code.toString('utf8').slice(result.importLine.length).replace(result.mount, ''), original.toString('utf8'));
  assert.equal(result.code.toString('utf8').includes('requireContext'), family === 'k67');
  assert.equal(result.code.toString('utf8').includes('k56: true'), family === 'k56');
});
test('Không ráp khi snapshot đổi, thiếu điểm gắn hoặc đã thêm module', () => {
  assert.throws(() => identityRuntimePatch({ source: Buffer.concat([original, Buffer.from('x')]), expectedSha, family: 'k56' }), /LIVE_SOURCE_CHANGED/);
  const absent = Buffer.from('import x from "x";');
  assert.throws(() => identityRuntimePatch({ source: absent, expectedSha: createHash('sha256').update(absent).digest('hex'), family: 'mapping' }), /ROSTER_ANCHOR_NOT_UNIQUE/);
  const already = Buffer.from("import {x} from './student-identity.js';\n" + original);
  assert.throws(() => identityRuntimePatch({ source: already, expectedSha: createHash('sha256').update(already).digest('hex'), family: 'mapping' }), /IDENTITY_ALREADY_MOUNTED/);
});
