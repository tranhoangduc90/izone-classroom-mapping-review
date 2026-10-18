// Nhận snapshot live đã chụp và hash app.js đã đối chiếu; dựng bản thử riêng.
// Chỉ thêm một import, một lần gắn route và module mới. Không kết nối hoặc sửa VPS.
import { createHash } from 'node:crypto';
import { cp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const sha256 = value => createHash('sha256').update(value).digest('hex');
export function identityRuntimePatch({ source, expectedSha, family }) {
  if (!['mapping', 'k56', 'k67'].includes(family)) throw new Error('INVALID_RUNTIME_FAMILY');
  if (!/^[0-9a-f]{64}$/.test(expectedSha || '') || sha256(source) !== expectedSha) throw new Error('LIVE_SOURCE_CHANGED');
  const text = source.toString('utf8'), newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (text.includes("'./student-identity.js'")) throw new Error('IDENTITY_ALREADY_MOUNTED');
  const importName = family === 'mapping' ? 'mountMappingStudentIdentity' : 'mountTermStudentIdentity';
  const importLine = `import { ${importName} } from './student-identity.js';${newline}`;
  const marker = "  app.get('/api/term-tests/roster',";
  if (text.split(marker).length !== 2) throw new Error('ROSTER_ANCHOR_NOT_UNIQUE');
  const middleware = family === 'k67' ? '[testReadLimiter, requireContext]' : '[testReadLimiter]';
  const mount = `  ${importName}(app, { pool, ${family === 'k56' ? 'k56: true, ' : ''}middleware: ${middleware} });${newline}${newline}`;
  const result = importLine + text.replace(marker, mount + marker);
  // Chứng minh tháo đúng hai đoạn mới sẽ trở về source byte ban đầu.
  if (result.slice(importLine.length).replace(mount + marker, marker) !== text) throw new Error('PATCH_SCOPE_CHANGED');
  return { code: Buffer.from(result, 'utf8'), beforeSha: expectedSha, afterSha: sha256(result), importLine, mount };
}

async function main() {
  const input = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
    if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), args[index + 1]]);
    return pairs;
  }, []));
  const sourceDir = path.resolve(input.source || ''), outputDir = path.resolve(input.output || '');
  if (!input.source || !input.output || sourceDir === outputDir || outputDir.startsWith(sourceDir + path.sep))
    throw new Error('SOURCE_OUTPUT_MUST_BE_SEPARATE');
  try { await stat(outputDir); throw new Error('OUTPUT_ALREADY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = await readFile(path.join(sourceDir, 'src/app.js'));
  const patch = identityRuntimePatch({ source, expectedSha: input['expected-sha'], family: input.family });
  const module = await readFile(new URL('../src/student-identity.js', import.meta.url));
  await mkdir(path.dirname(outputDir), { recursive: true });
  await cp(sourceDir, outputDir, { recursive: true, force: false, errorOnExist: true });
  await writeFile(path.join(outputDir, 'src/app.js'), patch.code);
  await writeFile(path.join(outputDir, 'src/student-identity.js'), module);
  const proof = { outcome: 'prepared_not_deployed', family: input.family,
    beforeAppSha: patch.beforeSha, afterAppSha: patch.afterSha, moduleSha: sha256(module),
    changedFiles: ['src/app.js', 'src/student-identity.js'], sourceDir, outputDir };
  await writeFile(path.join(outputDir, 'identity-runtime-proof.json'), JSON.stringify(proof, null, 2), 'utf8');
  console.log(JSON.stringify(proof));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
