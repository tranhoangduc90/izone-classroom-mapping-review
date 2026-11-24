import {readFile, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

function replaceOnce(source, anchor, replacement) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error('K56 Listening clock overlay anchor changed: ' + anchor.slice(0, 100));
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

export function integrateListeningClock(source) {
  if (source.includes('term2-listening-clock.mjs')) throw new Error('K56 Listening clock overlay already applied');
  const imported = "import {enrollListeningClock, mountListeningClock} from './term2-listening-clock.mjs';\n";
  const endOfNewRun = "\n   }\n   if(row.owner_id!==body.ownerId)";
  let revised = replaceOnce(source, endOfNewRun,
    "\n    if (profile.tablePrefix==='term2') row=await enrollListeningClock(client,row,current,process.env.TERM2_LISTENING_RECOVERY_V1==='true');"+endOfNewRun);
  const capability = 'sendWindowHours:24';
  revised = replaceOnce(revised, capability,
    "sendWindowHours:24,...(profile.tablePrefix==='term2'&&run.state?.listeningRecoveryVersion===1?{listeningRecoveryVersion:1}:{})");
  const status = " router.post('/:testSlug/offline/status',onlyThis,readLimiter,route(async(req,res)=>{";
  const mount = ` if(profile.tablePrefix==='term2')mountListeningClock(router,{
  onlyThis,draftLimiter,route,parseScope:value=>parse(scope,value),transaction,admitted,
  durationMs:a=>Math.round((a.mini_definition_snapshot?.timing||assets.getTiming(SLUG)).listeningDurationSeconds*1000),
  note:(req,scope,receipt,duplicate)=>record(duplicate?'listening_clock_receipt_replayed':'listening_clock_synced',SLUG,scope.attemptToken,{
    section:'listening',requestId:req.get('x-exam-journal-request-id'),operationId:receipt.operationId,
    playerId:receipt.playerId,transition:receipt.clock.phase,revision:receipt.revision,generation:receipt.generation,
    interruptionId:receipt.clock.interruptionId,positionMs:receipt.clock.positionMs,remainingMs:receipt.clock.remainingMs,
    resumeCount:receipt.clock.resumeCount,observedAt:receipt.clock.observedAt
  })
 });
`;
  revised = replaceOnce(revised, status, mount+status);
  return imported+revised;
}

export function integrateListeningClockJournal(source) {
  const hook = source.match(/^    void observe\(\{testSlug,token,type,data,(?:miniPaper,)?content(?::k56Offline\?undefined:content)?[,}]/m)?.[0];
  if (!hook || source.includes('term2ListeningClockVersion')) throw Error('K56 clock journal observation anchor changed');
  const checkpoint = `    if (testSlug === 'term-test-2-k56' &&
        ['listening_clock_synced', 'listening_clock_receipt_replayed'].includes(event)) {
      data.checkpointState = {term2ListeningClockVersion: 1};
      for (const key of ['operationId', 'playerId', 'interruptionId']) {
        if (UUID.test(details[key] || '')) data.checkpointState[key] = details[key].toLowerCase();
      }
      for (const key of ['generation', 'revision', 'positionMs', 'remainingMs', 'resumeCount']) {
        if (Number.isSafeInteger(details[key]) && details[key] >= 0) data.checkpointState[key] = details[key];
      }
      if (['paused', 'running'].includes(details.transition)) data.checkpointState.transition = details.transition;
      if (typeof details.observedAt === 'string' && /^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$/.test(details.observedAt)) {
        data.checkpointState.observedAt = details.observedAt;
      }
    }
`;
  return replaceOnce(source, hook, checkpoint + hook);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [input, output, journalInput, journalOutput] = process.argv.slice(2).map(path => resolve(path));
  if (!input || !output || basename(input)!=='k56-offline-core.mjs' || basename(output)!=='k56-offline-core.mjs' || input===output) {
    throw Error('Pass an explicit captured and isolated destination k56-offline-core.mjs');
  }
  if (!journalInput || !journalOutput || journalInput === journalOutput || basename(journalInput) !== 'term.mjs' || basename(journalOutput) !== 'term.mjs') {
    throw Error('Pass the captured and isolated destination for the Term journal adapter');
  }
  const patched = integrateListeningClock((await readFile(input,'utf8')).replace(/\r\n/g,'\n'));
  const journal = integrateListeningClockJournal((await readFile(journalInput,'utf8')).replace(/\r\n/g,'\n'));
  await writeFile(output,patched);
  await writeFile(journalOutput,journal);
  await writeFile(resolve(dirname(output),'term2-listening-clock.mjs'),await readFile(new URL('./listening-clock.mjs',import.meta.url)));
}
