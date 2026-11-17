import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const target = resolve(process.argv[2] ?? '');
const expected = process.argv[3];
const mountMode = process.argv[4];
assert.ok(mountMode === undefined || mountMode === '--mounted-gate', 'Use --mounted-gate for the production bind layout');
assert.equal(basename(target),'src','Use the src directory of an isolated Collector image copy');
assert.match(expected ?? '',/^[a-f0-9]{64}$/,'Supply the SHA-256 of the current Collector source');
const file=resolve(target,'service.mjs');
const base=await readFile(file,'utf8');
const sha=content=>createHash('sha256').update(content).digest('hex');
assert.equal(sha(base),expected);
const replace = (text,before,after) => {
  assert.equal(text.split(before).length,2,'Collector overlay anchor');
  return text.replace(before,after);
};
const gate = mountMode
  ? '/run/speaking-collector-overlay/speaking-journal-producer-gate.mjs'
  : './speaking-journal-producer-gate.mjs';
let candidate = `import {createSpeakingProducerGate} from '${gate}';\n` + base;
candidate = replace(candidate,' const intakeMetrics=new IntakeMetrics(Object.keys(config.products));',
  ` const intakeMetrics=new IntakeMetrics(Object.keys(config.products));
 const speakingCloud= { requests:0, requestBytes:0, responseBytes:0, errors:0 };
 const speakingGate=createSpeakingProducerGate({
  modeFile:config.modes['speaking-homework']==='primary'?process.env.SPEAKING_JOURNAL_CLOUD_SERVER_MODE_FILE:undefined,
  measure(row){
   speakingCloud.requests++;speakingCloud.requestBytes+=row.requestBytes;speakingCloud.responseBytes+=row.responseBytes;
   if(row.status>=400)speakingCloud.errors++;
  },
 });`);
const postGuard = "  if(closing || req.method!=='POST' || req.headers.origin";
candidate = replace(candidate,postGuard,
  `  if(!closing&&req.url==='/producer/speaking-homework'&&await speakingGate(req,res))return;
${postGuard}`);
candidate = replace(candidate,'operations,intakeMetrics:intakeMetrics.snapshot(),requests:',
  'operations,intakeMetrics:intakeMetrics.snapshot(),speakingCloudProducer:{...speakingCloud},requests:');
await copyFile(new URL('./speaking-journal-producer-gate.mjs',import.meta.url),resolve(target,'speaking-journal-producer-gate.mjs'));
await writeFile(file,candidate);
console.log(JSON.stringify({ base:expected,staged:sha(candidate) }));
