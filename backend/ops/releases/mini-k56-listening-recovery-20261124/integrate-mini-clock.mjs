import {readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const model=new URL('../term2-k56-listening-recovery-20261124/listening-clock.mjs',import.meta.url);
const coreFiles=new Set(['mini-k56-recovery-core.mjs','k56-offline-core.mjs']);
const normalize=source=>source.replaceAll('\r\n','\n');

function replaceOnce(source,anchor,value){
  const first=source.indexOf(anchor);
  if(first<0||source.indexOf(anchor,first+anchor.length)>=0)
    throw Error('Mini K56 clock overlay anchor changed: '+anchor.slice(0,120));
  return source.slice(0,first)+value+source.slice(first+anchor.length);
}

export async function buildMiniClock(){
  const source=normalize(await readFile(model,'utf8'));
  if(!source.includes('CREATE TABLE IF NOT EXISTS assessment.term2_offline_listening_clock (') ||
    !source.includes('UPDATE assessment.term2_offline_run SET state'))
    throw Error('K56 Listening clock model changed');
  return source.replaceAll('term2_offline_', 'mini_k56_offline_');
}

export function integrateMiniClock(source){
  if(source.includes('mini-k56-listening-clock.mjs'))throw Error('Mini K56 clock is already installed');
  const afterInsert="\n   }\n   if(row.owner_id!==body.ownerId)";
  let revised=replaceOnce(source,afterInsert,
    "\n    if(mini&&body.listeningRecoveryClientVersion===1)row=await enrollMiniClock(client,row,current,process.env.MINI_K56_LISTENING_RECOVERY_V1==='true');"+afterInsert);
  revised=replaceOnce(revised,"identityConfirmed:z.literal(true).optional()}:{})}),req.body);",
    "identityConfirmed:z.literal(true).optional(),listeningRecoveryClientVersion:z.literal(1).optional()}:{})}),req.body);");
  revised=replaceOnce(revised,'sendWindowHours:24',
    "sendWindowHours:24,...(mini&&!paper&&run.state?.listeningRecoveryVersion===1?{listeningRecoveryVersion:1}:{})");
  const route=" router.post('/:testSlug/offline/operation',onlyThis,draftLimiter,route(async(req,res)=>{";
  revised=replaceOnce(revised,route,` if(mini)mountMiniClock(router,{
  onlyThis,draftLimiter,route,parseScope:value=>parse(scope,value),transaction,admitted,
  durationMs:a=>Math.round((a.mini_definition_snapshot?.timing||assets.getTiming(SLUG)).listeningDurationSeconds*1000),
  note:(req,scope,receipt,duplicate)=>record(duplicate?'listening_clock_receipt_replayed':'listening_clock_synced',SLUG,scope.attemptToken,{
   section:'listening',requestId:req.get('x-exam-journal-request-id'),operationId:receipt.operationId,playerId:receipt.playerId,
   transition:receipt.clock.phase,revision:receipt.revision,generation:receipt.generation,
   interruptionId:receipt.clock.interruptionId,positionMs:receipt.clock.positionMs,remainingMs:receipt.clock.remainingMs,
   resumeCount:receipt.clock.resumeCount,observedAt:receipt.clock.observedAt
  })
 });
`+route);
  return "import {enrollListeningClock as enrollMiniClock, mountListeningClock as mountMiniClock} from './mini-k56-listening-clock.mjs';\n"+revised;
}

export function integrateMiniClockJournal(source){
  if(source.includes('miniK56ListeningClockVersion'))throw Error('Mini K56 clock journal is already installed');
  const peer=source.match(/^    if \(testSlug === 'term-test-1-k56' &&\n        \['listening_clock_synced', 'listening_clock_receipt_replayed'\]\.includes\(event\)\) \{[\s\S]*?^    \}\n/m)?.[0];
  if(!peer?.includes('term1ListeningClockVersion') || !peer.includes('observedAt'))
    throw Error('Term 1 K56 clock journal preimage changed');
  return replaceOnce(source,peer,peer+peer.replaceAll('term-test-1-k56','mini-test-k56')
    .replaceAll('term1ListeningClockVersion','miniK56ListeningClockVersion'));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const paths=process.argv.slice(2).map(value=>resolve(value));
  const [coreIn,coreOut,journalIn,journalOut]=paths;
  if(paths.length!==4||coreIn===coreOut||journalIn===journalOut||
    !coreFiles.has(basename(coreIn))||basename(coreOut)!==basename(coreIn)||
    [journalIn,journalOut].some(path=>basename(path)!=='term.mjs'))
    throw Error('Pass separate paths for the serving Mini K56 core and Term journal adapter');
  const core=integrateMiniClock(normalize(await readFile(coreIn,'utf8')));
  const journal=integrateMiniClockJournal(normalize(await readFile(journalIn,'utf8')));
  await Promise.all([
    writeFile(coreOut,core),writeFile(journalOut,journal),
    writeFile(resolve(dirname(coreOut),'mini-k56-listening-clock.mjs'),await buildMiniClock())
  ]);
}
