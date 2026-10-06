// Nhận bảng ID/credential đích đã chuẩn bị, ghim source rồi xuất bộ n8n K67 inactive.
// Chỉ ghi thư mục private mới trên E; không gọi n8n/AI/Portal hoặc ghi đè bản có sẵn.
// Lỗi giữ thư mục chưa hoàn tất và in mã; không dùng candidate khi thiếu manifest complete.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildGradingBundle, loadPinnedWorkflows } from '../ops/grading-bundle.mjs';

const PRIVATE = resolve('E:/Codex-Data/k67-backend-separation-20261006');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--target' || args[2] !== '--output') {
  throw new Error('K67_EXPORT_ARGS_EXPECT_TARGET_AND_OUTPUT');
}
function privatePath(value) {
  const path = resolve(value);
  const rel = relative(PRIVATE, path);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('K67_EXPORT_PATH_OUTSIDE_PRIVATE');
  }
  return path;
}
const targetPath = privatePath(args[1]);
const outputPath = privatePath(args[3]);
const lockBytes = await readFile(new URL('../ops/grading-source-lock.json', import.meta.url));
const targetBytes = await readFile(targetPath);
const lock = JSON.parse(lockBytes);
const target = JSON.parse(targetBytes);
const sources = await loadPinnedWorkflows(lock);
const built = buildGradingBundle(sources, target);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const { workflow } of built) for (const node of workflow.nodes) {
  if (node.type === 'n8n-nodes-base.code') new AsyncFunction(node.parameters.jsCode);
}
const hash = value => createHash('sha256').update(value).digest('hex');
// mkdir không recursive: đích đã có sẽ bị từ chối trước mọi lần ghi candidate.
await mkdir(outputPath, { recursive: false });
const manifest = { schema_version: 1, product_id: 'PRODUCT-TERM-MINI-K67', status: 'complete',
  source_lock_sha256: hash(lockBytes), target_sha256: hash(targetBytes), workflows: [] };
for (const { profile, sourceId, sourceVersionId, workflow } of built) {
  const filename = profile + '-' + sourceId + '.private.json';
  const bytes = Buffer.from(JSON.stringify(workflow, null, 2) + '\n');
  await writeFile(join(outputPath, filename), bytes, { flag: 'wx' });
  manifest.workflows.push({ profile, sourceId, sourceVersionId, targetId: workflow.id, name: workflow.name,
    active: false, path: join(outputPath, filename), sha256: hash(bytes) });
}
await writeFile(join(outputPath, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ outcome: 'success', workflows: built.length, active: false,
  manifest: join(outputPath, 'manifest.json'), source_lock_sha256: manifest.source_lock_sha256 }));
