import {readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const model=new URL('../term2-k56-listening-recovery-20261124/listening-clock.mjs',import.meta.url);
function replaceOnce(source,anchor,value) {
  const first=source.indexOf(anchor);
  if(first<0||source.indexOf(anchor,first+anchor.length)>=0)
    throw Error('Term 1 Listening clock overlay anchor changed: '+anchor.slice(0,120));
  return source.slice(0,first)+value+source.slice(first+anchor.length);
}
const normalize=source=>source.replaceAll('\r\n','\n');

export async function buildTerm1Clock(){
  const source=normalize(await readFile(model,'utf8'));
  if(!source.includes('CREATE TABLE IF NOT EXISTS assessment.term2_offline_listening_clock (') ||
    !source.includes('UPDATE assessment.term2_offline_run SET state'))
    throw Error('Term 2 Listening clock model changed');
  return source.replaceAll('term2_offline_', 'term1_offline_');
}

export function integrateTerm1Clock(source){
  if(source.includes('term1-listening-clock.mjs'))throw Error('Term 1 clock is already installed');
  const endNewRun="   }\n   if(row.session_id!==body.examSessionToken||Number(row.generation)!==body.generation||row.policy!==POLICY)";
  let revised=replaceOnce(source,endNewRun,
    "    if(profile.tablePrefix==='term1')row=await enrollListeningClock(client,row,current,process.env.TERM1_LISTENING_RECOVERY_V1==='true');\n"+endNewRun);
  revised=replaceOnce(revised,'sendWindowHours:24',
    "sendWindowHours:24,...(profile.tablePrefix==='term1'&&run.state?.listeningRecoveryVersion===1?{listeningRecoveryVersion:1}:{})");
  const anchor=" router.post('/:testSlug/offline/resume',onlyThis,readLimiter,route(async(req,res)=>{";
  revised=replaceOnce(revised,anchor,` if(profile.tablePrefix==='term1')mountListeningClock(router,{
  onlyThis,draftLimiter,route,parseScope:value=>parse(scope,value),transaction,
  admitted:async (client,scope,permit)=>{
   const bound=await admitted(client,scope,permit);
   await rejectMainSkillIfBound(client,bound.a,'listening');
   return bound;
  },
  durationMs:a=>Math.round((a.mini_definition_snapshot?.timing||assets.getTiming(SLUG)).listeningDurationSeconds*1000),
  note:(req,scope,receipt,duplicate)=>record(duplicate?'listening_clock_receipt_replayed':'listening_clock_synced',SLUG,scope.attemptToken,{
   section:'listening',requestId:req.get('x-exam-journal-request-id'),operationId:receipt.operationId,playerId:receipt.playerId,
   transition:receipt.clock.phase,revision:receipt.revision,generation:receipt.generation,
   interruptionId:receipt.clock.interruptionId,positionMs:receipt.clock.positionMs,remainingMs:receipt.clock.remainingMs,
   resumeCount:receipt.clock.resumeCount,observedAt:receipt.clock.observedAt
  })
 });
`+anchor);
  return "import {enrollListeningClock, mountListeningClock} from './term1-listening-clock.mjs';\n"+revised;
}

export function integrateTerm1ClockJournal(source){
  if(source.includes('term1ListeningClockVersion'))throw Error('Term 1 clock journal is already installed');
  const peer=source.match(/^    if \(testSlug === 'term-test-2-k56' &&\n        \['listening_clock_synced', 'listening_clock_receipt_replayed'\]\.includes\(event\)\) \{[\s\S]*?^    \}\n/m)?.[0];
  if(!peer||!peer.includes('observedAt'))throw Error('Term 2 clock journal preimage changed');
  return replaceOnce(source,peer,peer+peer.replaceAll('term-test-2-k56','term-test-1-k56')
    .replaceAll('term2ListeningClockVersion','term1ListeningClockVersion'));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const paths=process.argv.slice(2).map(value=>resolve(value));
  const [coreIn,coreOut,journalIn,journalOut]=paths;
  if(paths.length!==4||coreIn===coreOut||journalIn===journalOut||
    [coreIn,coreOut].some(path=>basename(path)!=='term1-skill-offline-core.mjs')||
    [journalIn,journalOut].some(path=>basename(path)!=='term.mjs'))
    throw Error('Pass isolated input/output paths for the Term 1 core and Term journal adapter');
  const core=integrateTerm1Clock(normalize(await readFile(coreIn,'utf8')));
  const journal=integrateTerm1ClockJournal(normalize(await readFile(journalIn,'utf8')));
  await Promise.all([
    writeFile(coreOut,core),writeFile(journalOut,journal),
    writeFile(resolve(dirname(coreOut),'term1-listening-clock.mjs'),await buildTerm1Clock())
  ]);
}
