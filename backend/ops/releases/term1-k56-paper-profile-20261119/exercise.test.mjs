import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const [evidencePath, candidatePath, variant] = process.argv.slice(2);
assert.ok(evidencePath && candidatePath);
assert.ok(variant === undefined || variant === '--term2-regression');
const term1 = variant !== '--term2-regression';
const evidence = pathToFileURL(resolve(evidencePath) + sep);
const candidate = pathToFileURL(resolve(candidatePath) + sep);
const runtime = new URL('mini-k56-browser-api-runtime-fixture-74fa7a02/', evidence);
const runner = new URL('../term2-k56-paper-t4-20261119/paper-admission.test.mjs',import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json',candidate),'utf8'));
assert.equal(manifest.baseBuild,'59e4c428326c1f29db8a1c09497d39ff2ecaa660');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const overrides = new Map();
for (const [name, item] of Object.entries(manifest.files)) {
  const bytes = await readFile(new URL(name,candidate));
  assert.equal(digest(bytes),item.sha256,name);
  overrides.set(new URL('src/' + name,runtime).href,bytes);
}
const migration = await readFile(new URL('migration.sql',candidate));
assert.equal(digest(migration),manifest.migrationSha256);
const term1CbtMigration = await readFile(new URL('term1-k56-candidate/release-payload/migration.sql',evidence),'utf8');
const grantModule = new URL('src/term1-skill-grant.mjs',runtime).href;
const {skillGrantSchema} = await import(grantModule);
let source = (await readFile(runner,'utf8')).replaceAll('\r\n','\n');
const begin = source.indexOf('import {assembleEntry,assembleRecovery}');
const env = source.indexOf('process.env.TERM2_RUNTIME_ROOT',begin);
assert.ok(begin>0 && env>begin);
const fixtureSetup = source.slice(source.indexOf('// Add the real transactional grading service',begin),env);
assert.ok(fixtureSetup.includes('registerHooks({'));
const setup = `
const [evidencePath] = process.argv.slice(2);
const evidence = pathToFileURL(resolve(evidencePath) + sep);
const runtime = new URL('mini-k56-browser-api-runtime-fixture-74fa7a02/', evidence);
const fixtureFile = new URL('term1-k56-candidate/baseline/fixture.mjs', evidence);
const overlays = new Map();
`;
source = source.slice(0,begin) + setup + fixtureSetup + source.slice(env);
const term1Mode = "process.env.K56_TERM1_PARALLEL_ENTRY_MODE = 'on';\nprocess.env.K56_TERM1_PAPER_PARALLEL_ENTRY_MODE = 'on';\n";
source = source.replace('delete process.env.TERM2_TEST_PG_URL;',term1Mode + 'delete process.env.TERM2_TEST_PG_URL;');
const migrationAnchor = "  await f.db.exec(await readFile(new URL('./legacy-bridge.sql',import.meta.url),'utf8'));";
assert.equal(source.split(migrationAnchor).length,2);
source = source.replace(migrationAnchor,() => migrationAnchor + '\n' + [term1CbtMigration,skillGrantSchema,migration.toString('utf8')]
  .map(sql=>'  await f.db.exec(' + JSON.stringify(sql) + ');').join('\n'));
if (term1) {
  source = source.replaceAll('K56_TERM2_PAPER_PARALLEL_ENTRY_MODE','K56_TERM1_PAPER_PARALLEL_ENTRY_MODE')
    .replace("process.env.K56_TEST_PRODUCT = '2';","process.env.K56_TEST_PRODUCT = '1';")
    .replace("    INSERT INTO assessment.term_test_class_access VALUES ('term-test-2-k56',5601,true);\n",'')
    .replace('CREATE TABLE assessment.term2_submission_hold','CREATE TABLE assessment.term1_submission_hold');
  const bodyStart = source.indexOf("  const identity = {classCode:'FIXTURE'");
  assert.ok(bodyStart>0);
  let body = source.slice(bodyStart).replaceAll('term2PaperProfileId','term1PaperProfileId')
    .replaceAll('term2PaperParallelEntry','term1PaperParallelEntry')
    .replaceAll('term-test-2-k56','term-test-1-k56')
    .replaceAll('term2_paper_legacy_resumed','term1_paper_legacy_resumed')
    .replaceAll('term2_official_submission','term1_official_submission')
    .replaceAll('writing_task_1','writing_task_2')
    .replaceAll('.writing.task1','.writing.task2')
    .replaceAll("payload->'writing'->>'task1'","payload->'writing'->>'task2'")
    .replace('task_number:1','task_number:2')
    .replace("(a, action, task1 = '', baseRevision = null, outline = '')","(a, action, task2 = '', baseRevision = null, outline = '')")
    .replace("...tokens(a), action, task1, task2:'', outline, baseRevision",
      "...tokens(a), action, term1PaperParallelEntry:true, task1:'', task2, outline, baseRevision")
    .replace("(a, proof, task1, baseRevision, outline = '')","(a, proof, task2, baseRevision, outline = '')")
    .replace("attemptToken:a.attemptToken, task1, task2:'', outline, baseRevision, recovery:proof",
      "attemptToken:a.attemptToken, task1:'', task2, outline, baseRevision, recovery:proof");
  const guardAnchor = '  const startWriting = await request(';
  assert.equal(body.split(guardAnchor).length,2);
  body = body.replace(guardAnchor,`  // A bound Term 1 fallback remains authoritative when B uses the main paper link.
  const grantId = randomUUID();
  await f.db.query(\`INSERT INTO assessment.term1_skill_grant
    (id,secret_hash,activation_hash,attempt_id,session_id,generation,class_id,student_ref,section,expires_at,owner_id,bound_at)
    VALUES($1,$2,$3,$4,$5,$6,5601,$7,'writing',now()+interval '1 day',$8,now())\`,
  [grantId,randomUUID(),randomUUID(),first.attemptToken,first.examSessionToken,first.generation,f.student,randomUUID()]);
  const bound = await request('/writing/draft',paperWriting(second,'start'),409);
  assert.equal(bound.error,'TERM1_SKILL_OWNED_BY_FALLBACK');
  await f.db.query('UPDATE assessment.term1_skill_grant SET revoked_at=now() WHERE id=$1',[grantId]);
  await request('/writing/draft',{...paperWriting(second,'start'),task1:'wrong task'},400);
  const startWriting = await request(`);
  source = source.slice(0,bodyStart) + body;
}
const hook = registerHooks({load(url,context,next) {
  if (url === runner.href) return {format:'module',source,shortCircuit:true};
  if (overrides.has(url)) return {format:'module',source:overrides.get(url),shortCircuit:true};
  return next(url,context);
}});
try {
  await import(runner);
  console.log(JSON.stringify({passed:true,fixtureOnly:true,build:manifest.build,
    testSlug:term1?'term-test-1-k56':'term-test-2-k56',writingTask:term1?2:1,
    fallbackGrantPreserved:term1?true:undefined}));
} finally {
  hook.deregister();
}
