// Dữ liệu vào: thư mục source ứng viên và các SHA-256 đã đọc từ bản chuẩn.
// Việc chính: kiểm từng file và dấu toàn cây mã trước/sau khi copy vào image.
// Kết quả: chỉ báo dấu đã khớp; không đọc .env hoặc dữ liệu học viên.
// Khi lỗi: thoát khác 0 để Docker không tạo image sai bản đã kiểm thử.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{64}$/;

function listSourceFiles(root) {
  const found = [];
  function walk(folder, relative) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const child = path.join(folder, entry.name);
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('SOURCE_SYMLINK_NOT_ALLOWED');
      if (entry.isDirectory()) walk(child, name);
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(name);
    }
  }
  walk(root, 'src');
  return found.sort();
}

export function sealSourceTree(root) {
  const files = listSourceFiles(root);
  if (files.length === 0) throw new Error('SOURCE_TREE_EMPTY');
  const seal = crypto.createHash('sha256');
  for (const relative of files) {
    const diskPath = path.join(root, ...relative.split('/').slice(1));
    seal.update(relative, 'utf8');
    seal.update(Buffer.from([0]));
    seal.update(fs.readFileSync(diskPath));
    seal.update(Buffer.from([0]));
  }
  return { sha256: seal.digest('hex'), files: files.length };
}

export function verifyFileHash(filename, expected) {
  if (!shaPattern.test(expected)) throw new Error('EXPECTED_FILE_HASH_INVALID');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filename))
    .digest('hex');
  if (actual !== expected) throw new Error('FILE_HASH_MISMATCH');
  return actual;
}

export function verifySourceHash(root, expected) {
  if (!shaPattern.test(expected)) throw new Error('EXPECTED_SOURCE_HASH_INVALID');
  const result = sealSourceTree(root);
  if (result.sha256 !== expected) throw new Error('SOURCE_HASH_MISMATCH');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [root, sourceSha, packagePath, packageSha, lockPath, lockSha] =
      process.argv.slice(2);
    if (!root || !sourceSha || (packagePath && (!packageSha || !lockPath || !lockSha))) {
      throw new Error('VERIFY_ARGUMENTS_INVALID');
    }
    const result = verifySourceHash(root, sourceSha);
    if (packagePath) {
      verifyFileHash(packagePath, packageSha);
      verifyFileHash(lockPath, lockSha);
    }
    process.stdout.write(JSON.stringify({ toolOutcome: 'success',
      sourceSha256: result.sha256, sourceFiles: result.files,
      packageHashesChecked: Boolean(packagePath) }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ toolOutcome: 'failure',
      errorCode: error.message }) + '\n');
    process.exitCode = 2;
  }
}
