import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const [portalRoot, destination] = process.argv.slice(2);
if (!portalRoot || !destination || !isAbsolute(portalRoot) || !isAbsolute(destination)) {
  throw new Error('Supply absolute paths to the shared Portal service and a new build context.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const staged = resolve(destination);
const portalFiles = [
  'client/exam-schema.mjs', 'client/exam-source.mjs', 'client/native-grade-ack.mjs', 'client/retry.mjs',
  'src/contract.mjs', 'src/exam-contract.mjs', 'src/http.mjs', 'src/response.mjs'
];
const files = await Promise.all(portalFiles.map(async name => ({
  name: `src/portal-sync/${name}`, bytes: await readFile(join(portalRoot, name))
})));
files.push({name: 'db/portal-k67-attempt-roster.sql',
  bytes: await readFile(join(portalRoot, 'client/k67-attempt-roster.sql'))});

await mkdir(staged);
for (const name of ['Dockerfile', 'package.json', 'package-lock.json', 'src', 'db']) {
  await cp(join(root, name), join(staged, name), {recursive: true, force: false, errorOnExist: true});
}
for (const {name, bytes} of files) {
  const target = join(staged, name);
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, bytes, {flag: 'wx'});
}
console.log(JSON.stringify({portalFiles: Object.fromEntries(files.map(({name, bytes}) => [
  name, createHash('sha256').update(bytes).digest('hex')
]))}));
