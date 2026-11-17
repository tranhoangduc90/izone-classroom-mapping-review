import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const target = resolve(process.argv[2] ?? '');
assert.equal(basename(target), 'src', 'Use the src directory of an isolated Speaking image copy');
const files = {
  'speaking-journal-runtime.js':'c85db36d86e6668d904157c433753203f3dbb1866a4849fa740b4b029a192e06',
  'speaking-independent-server.js':'854dd548bed1fe211bafeeb6d553b9d00bf4be69fdec4fd6c49494ca05cd4211',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const input = Object.fromEntries(await Promise.all(Object.keys(files).map(async name =>
  [name,await readFile(resolve(target,name),'utf8')])));
for (const [name,content] of Object.entries(input)) assert.equal(sha(content),files[name],name);
const replace = (text,before,after) => {
  assert.equal(text.split(before).length,2,'Speaking runtime overlay anchor');
  return text.replace(before,after);
};
let runtime = input['speaking-journal-runtime.js'];
runtime = replace(runtime,"import {randomUUID} from 'node:crypto';",
  "import {randomUUID} from 'node:crypto';\nimport {createSpeakingCloudPolicy} from './speaking-journal-cloud-policy.js';");
runtime = replace(runtime," return {journal,intake:journal?.intake||null,",
  ` const cloudPolicy=journal?.intake?await createSpeakingCloudPolicy({env,allowedOrigins,
  onFailure:code=>notify('degraded',code)}):null;
 return {journal,intake:journal?.intake||null,
  context(owner){
   const grant=journal.intake.context(owner);
   return cloudPolicy?cloudPolicy(owner,grant):grant;
  },`);
const server = replace(input['speaking-independent-server.js'],
  "      return journalRuntime.intake.context({mode:'independent',assignmentRef:u.assignment_code,classRef:u.class_id==null?null:String(u.class_id),subjectRef:u.identity_ref,unitId:u.id});",
  `      const owner={mode:'independent',assignmentRef:u.assignment_code,classRef:u.class_id==null?null:String(u.class_id),subjectRef:u.identity_ref,unitId:u.id};
      return journalRuntime.context?journalRuntime.context(owner):journalRuntime.intake.context(owner);`);
await copyFile(new URL('./speaking-journal-cloud-policy.js', import.meta.url),
  resolve(target,'speaking-journal-cloud-policy.js'));
await Promise.all([writeFile(resolve(target,'speaking-journal-runtime.js'),runtime),
  writeFile(resolve(target,'speaking-independent-server.js'),server)]);
console.log(JSON.stringify({ base:files, staged:{ runtime:sha(runtime),server:sha(server) } }));
