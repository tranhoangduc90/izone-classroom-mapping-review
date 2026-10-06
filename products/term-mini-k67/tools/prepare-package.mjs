// Nhận snapshot đã kiểm và đích K67 riêng; tách bằng cây cú pháp, giữ nguyên nghiệp vụ Term/Mini.
// Chỉ tạo file mới trong gói này. Sai nguồn, tuyến hoặc file đã tồn tại làm lệnh dừng trước ghi.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'file:///E:/Codex-Data/codex-tooling/powershell-preflight/node_modules/acorn/dist/acorn.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const live = 'E:/Codex-Data/k67-backend-separation-20261006/live-mapping';
const tests = 'E:/wt/k67-backend-separation-20261006/classroom-mapping-review/backend/test';
const outputs = new Map();
const inputs = [];
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const ast = text => parse(text, { ecmaVersion: 2024, sourceType: 'module' });
async function read(file, expected) {
  const content = await fs.readFile(file, 'utf8');
  const hash = sha(content);
  if (expected && expected !== hash) throw new Error(`Nguồn đã đổi: ${path.basename(file)}`);
  inputs.push({ path: file, sha256: hash });
  return content;
}
function identifiers(node, found = new Set()) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'Identifier') found.add(node.name);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => identifiers(child, found));
    else if (value && typeof value === 'object') identifiers(value, found);
  }
  return found;
}
function declarationNames(statement) {
  const node = statement.declaration || statement;
  if (node.id) return [node.id.name];
  return (node.declarations || []).flatMap(item => [...identifiers(item.id)]);
}
// Giữ các khai báo được phần ứng dụng còn lại sử dụng, lần theo phụ thuộc cho tới khi đủ.
function selectDeclarations(statements, needed) {
  const chosen = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of statements) {
      if (chosen.has(node) || !declarationNames(node).some(name => needed.has(name))) continue;
      chosen.add(node);
      identifiers(node, needed);
      changed = true;
    }
  }
  return chosen;
}
function edited(text, changes) {
  let result = text;
  for (const edit of changes.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

const original = await read(`${live}/src/app.js`, '32e6f3c50050a5eb67600324b8ddcbfbcff1e2034c2c7a2d3baf826f3c11694e');
const tree = ast(original);
const exportedApp = tree.body.find(node => node.declaration?.id?.name === 'createApp');
if (!exportedApp) throw new Error('Không tìm thấy điểm tạo ứng dụng.');
const app = exportedApp.declaration;
const changes = [{ start: app.params[0].start, end: app.params[0].end, text: `{
  config, pool, verifyGoogleToken,
  syncErpGrades = async () => ({ status: 'disabled' }),
  termTestWritingGradingService = null, termTestAssetService = null, logger = console
}` }];
const routes = [];
for (const statement of app.body.body) {
  const source = original.slice(statement.start, statement.end);
  let remove = declarationNames(statement).includes('writingTests');
  if (statement.type === 'IfStatement') {
    const names = identifiers(statement.test);
    remove ||= names.has('learningEnabled') || names.has('speakingHomeworkEnabled');
  }
  const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
  if (call?.type === 'CallExpression' && call.callee?.object?.name === 'app') {
    const route = call.arguments[0]?.value;
    if (typeof route === 'string' && route.startsWith('/')) {
      const keep = ['/health', '/ready', '/version'].includes(route)
        || route.startsWith('/api/auth/') || route.startsWith('/api/term-tests/')
        || route === '/api/mini-tests/results';
      remove ||= !keep;
      if (keep) routes.push({ method: call.callee.property.name, path: route });
    }
  }
  if (remove) changes.push({ start: statement.start, end: statement.end, text: '' });
  else {
    const cleaned = source
      .replace("    skip: req => req.path.startsWith('/api/learning'),\n", '')
      .replace("    skip: req => req.path.startsWith('/api/learning'),\r\n", '')
      .replace("    if (config.learningEnabled) await learningPool.query('SELECT 1');", '')
      .replace('error instanceof WritingTestError || ', '');
    if (cleaned !== source) changes.push({ start: statement.start, end: statement.end, text: cleaned });
  }
}
const appText = edited(original, changes);
const appTree = ast(appText);
const appNode = appTree.body.find(node => node.declaration?.id?.name === 'createApp');
const needed = identifiers(appNode);
const declarations = selectDeclarations(appTree.body.filter(node => node !== appNode && node.type !== 'ImportDeclaration'), needed);
const imports = [];
const sqlNames = new Set();
for (const node of appTree.body.filter(node => node.type === 'ImportDeclaration')) {
  const specs = node.specifiers.filter(spec => needed.has(spec.local.name));
  if (!specs.length) continue;
  if (node.source.value === './sql.js') specs.forEach(spec => sqlNames.add(spec.imported.name));
  const defaultSpec = specs.find(spec => spec.type === 'ImportDefaultSpecifier');
  const named = specs.filter(spec => spec.type === 'ImportSpecifier').map(spec => spec.imported.name === spec.local.name ? spec.local.name : `${spec.imported.name} as ${spec.local.name}`);
  const parts = [defaultSpec?.local.name, named.length ? `{ ${named.join(', ')} }` : null].filter(Boolean);
  imports.push(`import ${parts.join(', ')} from ${JSON.stringify(node.source.value)};`);
}
const outputApp = '// Ứng dụng K67 chỉ phục vụ thi, chấm Term/Mini và đăng nhập giảng viên.\n'
  + imports.join('\n') + '\n\n'
  + [...declarations].sort((a, b) => a.start - b.start).map(node => appText.slice(node.start, node.end)).join('\n\n')
  + '\n\n' + appText.slice(appNode.start, appNode.end) + '\n';
if (imports.some(line => /learning-|speaking-|writing-tests/.test(line))) throw new Error('Còn import sản phẩm khác.');
ast(outputApp);
outputs.set('src/app.js', outputApp);

const sql = await read(`${live}/src/sql.js`, '16c76201fffff6e09cd3f3a68070a82103de9e3ce738a75b02e8e76c315d1ea9');
const sqlTree = ast(sql);
const sqlNodes = selectDeclarations(sqlTree.body, sqlNames);
if (![...sqlNames].filter(name => name.endsWith('Sql')).every(name => [...sqlNodes].some(node => declarationNames(node).includes(name)))) throw new Error('Thiếu SQL được gọi.');
outputs.set('src/sql.js', '// SQL Term/Mini được ghim từ bản chạy; mapping ở đây phải là ngữ cảnh trong DB K67 riêng.\n'
  + [...sqlNodes].sort((a, b) => a.start - b.start).map(node => sql.slice(node.start, node.end)).join('\n\n') + '\n');
for (const name of ['auth', 'erp-sync', 'mini-tests', 'term-tests', 'term-test-assets', 'term-test-writing-grading', 'term-test-writing-notifier']) {
  outputs.set(`src/${name}.js`, await read(`${live}/src/${name}.js`));
}
for (const name of ['term-tests', 'mini-tests', 'term-test-assets', 'term-test-writing-notifier']) {
  outputs.set(`test/${name}.test.js`, await read(`${tests}/${name}.test.js`));
}
const pkg = JSON.parse(await read(`${live}/package.json`, 'd7eca88811e6d7853f6e0a8899c7e86e729974c8e4f46d6699970634d04e7b73'));
pkg.name = 'izone-term-mini-k67';
pkg.scripts = { start: 'node src/server.js', test: 'node --test' };
outputs.set('package.json', JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(await read(`${live}/package-lock.json`, 'd6e0f33e98da7d650fe20242bfea1e7b3d33aecc8642333fd985b3bedd7850ff'));
lock.name = pkg.name;
lock.packages[''].name = pkg.name;
outputs.set('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
// Kiểm đủ đích trước khi ghi để tránh ghi đè source của một lần dựng trước.
for (const [relative, content] of outputs) {
  const dest = path.resolve(root, relative);
  if (!dest.startsWith(path.resolve(root) + path.sep)) throw new Error('Đích ngoài gói K67.');
  try { await fs.access(dest); throw new Error(`File đã tồn tại: ${relative}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (relative.endsWith('.js')) ast(content);
}
for (const [relative, content] of outputs) {
  const dest = path.resolve(root, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, { encoding: 'utf8', flag: 'wx' });
}
const receipt = { outcome: 'success', inputs, routes, outputs: [...outputs].map(([name, content]) => ({ name, sha256: sha(content) })) };
await fs.writeFile(path.join(root, '.codex/product-evidence/source-package.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ outcome: receipt.outcome, files: outputs.size, routes: routes.length }));
