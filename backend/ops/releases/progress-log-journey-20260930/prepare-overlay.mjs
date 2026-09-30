// Đầu vào: source trích đúng image API live và source Git đã kiểm bằng full suite.
// Việc chính: khóa hash image nền, phủ Journey và ba phần Term Test bị cũ trên image.
// Kết quả: thư mục build cùng manifest hash; khi image đổi thì dừng trước build.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [liveInput, backendInput, outputInput] = process.argv.slice(2);
if (!liveInput || !backendInput || !outputInput) {
  throw new Error('Cần live-source, backend và thư mục output.');
}
const live = resolve(liveInput);
const backend = resolve(backendInput);
const output = resolve(outputInput);
const expected = {
  'app.js': '1c34d61a44fe7124ef04eb87f64f804e81191547e79c4e8a8225ef8042567141',
  'config.js': '065fcca9abd238f47d82b052155fa5790b083d4d27235ea579136c910f4dcb38',
  'learning-routes.js': '4173b2beccad28dc2b5d1b40650f23c9fc70786dd81e53eb8af386253b35a35c',
  'learning-service.js': '1dfbb7ae672b0085a17840730dc14b38ff1b57c9e2d1583157623141149907d6',
  'learning-sql.js': '33499d8ca6d2b4029d17e0a49c7505a4bf541ec0351665cef20a5275c1bf60bd',
  'auth.js': 'af50eac4d39f0c0c4e9c5042e672b3fbd34d52a18e9f094072e0d8451858394b',
  'server.js': '5aa0068436adfaf1b1ea1b815ffa59a5c5011d6bf7ae045415fc181c182234e5',
  'sql.js': '474cde7d05fac8741ac80358ef46efff338196e2d7769c7562ce95d9625e9b8e',
  'term-test-writing-grading.js': '4919aa77a6e21a17c965898aa38637bea3a999f7d08c5bb51b3c9e2df0e80276',
  'learning-attendance-worker.js': 'fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d'
};
const hash = data => createHash('sha256').update(data).digest('hex');
for (const [file, digest] of Object.entries(expected)) {
  const bytes = await readFile(join(live, 'src', file));
  if (hash(bytes) !== digest) throw new Error(`Image nền đã đổi: ${file}`);
}
const copyModules = [
  'app.js', 'config.js', 'server.js', 'sql.js', 'term-test-writing-grading.js',
  'term-test-writing-notifier.js',
  'learning-routes.js', 'learning-service.js', 'learning-sql.js',
  'learning-erp-schedule.js', 'learning-test-sources.js', 'learning-test-results.js'
];
await mkdir(join(output, 'src'), { recursive: true });
for (const file of copyModules) {
  await cp(join(backend, 'src', file), join(output, 'src', file));
}
// Kiểm mọi import tương đối của module mới ngay lúc chuẩn bị image.
for (const file of copyModules) {
  const source = await readFile(join(output, 'src', file), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\/[A-Za-z0-9/_-]+\.js)['"]/gu)) {
    const relative = match[1].slice(2);
    if (!existsSync(join(output, 'src', relative))
      && !existsSync(join(live, 'src', relative))) {
      throw new Error(`Thiếu module import của ${file}: ${relative}`);
    }
  }
}
await cp(join(import.meta.dirname, 'Dockerfile'), join(output, 'Dockerfile'));
const result = { baseHashes: expected, overlayHashes: {} };
for (const file of copyModules) {
  result.overlayHashes[file] = hash(await readFile(join(output, 'src', file)));
}
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`overlay_ready modules=${copyModules.length}\n`);
