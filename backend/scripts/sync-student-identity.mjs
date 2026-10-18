// Nhận module nhận diện chuẩn; sao chép chính xác vào runtime K67 độc lập.
// --check chỉ đối chiếu, không sửa. Không gọi VPS hoặc thay dữ liệu học viên.
import { readFile, writeFile } from 'node:fs/promises';
const source = new URL('../src/student-identity.js', import.meta.url);
const target = new URL('../../products/term-mini-k67/src/student-identity.js', import.meta.url);
const code = await readFile(source, 'utf8');
if (process.argv.includes('--check')) {
  const actual = await readFile(target, 'utf8');
  if (actual !== code) throw new Error('Bản nhận diện K67 chưa khớp module đã ghim.');
} else await writeFile(target, code, 'utf8');
console.log(JSON.stringify({ outcome: 'success', mode: process.argv.includes('--check') ? 'check' : 'sync' }));
