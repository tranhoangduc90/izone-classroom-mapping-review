import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {term2ListeningReportSchema} from './listening-report-queue.mjs';

const modified=['term2-offline.mjs','k56-offline-core.mjs','k56-exam-order.js','app.js',
  'exam-journal-runtime/adapters/term-k56-offline.mjs','exam-journal-runtime/adapters/term.mjs'];
const modules=['listening-report-runtime.mjs','listening-report-queue.mjs','listening-report-native.mjs',
  'listening-report-ingress.mjs','listening-report-online.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');

function edit(source,before,after){
  if(source.split(before).length!==2)throw Error('Term 2 overlay anchor differs: '+before);
  return source.replace(before,()=>after);
}

function wrapper(source){
  return edit(source,'export const registerTerm2Offline=api.registerOffline;',`
import {readFileSync} from 'node:fs';
import {armTerm2ListeningReportService} from './term2-listening-report/listening-report-runtime.mjs';
import {createTelegramAlertSender} from './mini-listening-report/telegram-alerts.mjs';
export function registerTerm2Offline(router,dependencies){
 const {pool,secret,limiter,listeningReportLimiter=limiter,term2ListeningReportSender,record}=dependencies;
 const credentialFile=process.env.MINI_K56_LISTENING_REPORT_TELEGRAM_FILE;
 const policyFile=process.env.TERM2_K56_LISTENING_REPORT_POLICY_FILE;
 const allowReporting=()=>{
  if(!policyFile)return false;
  try{return JSON.parse(readFileSync(policyFile,'utf8')).enabled===true;}catch{return false;}
 };
 const send=term2ListeningReportSender??(policyFile&&credentialFile?
  createTelegramAlertSender({credentialFile,preferIPv4:true}):undefined);
 const reports=armTerm2ListeningReportService({
  router,limiter:listeningReportLimiter,query:pool.query.bind(pool),
  makePermit:run=>permitFor(secret,run),onlineSecret:secret,send,allowReporting,
  observe:({status,attemptId,...detail})=>{
   if(attemptId)record?.('term2_listening_report',SLUG,attemptId,{section:'listening',status,...detail});
   else if(typeof status==='string'&&(status.endsWith('_error')||status.endsWith('_unavailable')))
    process.stderr.write('[term2-k56-listening-report] '+status+'\\n');
  },
 });
 const stopOffline=api.registerOffline(router,{...dependencies,listeningReportsEnabled:reports.enabled});
 const stop=async()=>{stopOffline();await reports.close();};
 stop.listeningReportsEnabled=reports.enabled;
 return stop;
}`.trim());
}

function offline(source){
  source=edit(source,'record,onWriting,allowNew=()=>profile.tablePrefix',
    'record,onWriting,listeningReportsEnabled=()=>false,allowNew=()=>profile.tablePrefix');
  return edit(source,'sendWindowHours:24,...(recovery.enabled(run)',
    "sendWindowHours:24,...(profile.tablePrefix==='term2'&&listeningReportsEnabled()?{listeningReportsEnabled:true}:{}),...(recovery.enabled(run)");
}

function examOrder(source){
  source=edit(source,'  registerTerm2Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});',
    '  const term2Offline=registerTerm2Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,listeningReportLimiter,record,onWriting});');
  return edit(source,'term1ListeningReportsEnabled:term1Offline.listeningReportsEnabled}',
    'term1ListeningReportsEnabled:term1Offline.listeningReportsEnabled,term2ListeningReportsEnabled:term2Offline.listeningReportsEnabled}');
}

function app(source){
  source=edit(source,"import {issueTerm1OnlineListeningReportGrant} from './term1-listening-report/listening-report-online.mjs';",
    "import {issueTerm1OnlineListeningReportGrant} from './term1-listening-report/listening-report-online.mjs';\nimport {issueTerm2OnlineListeningReportGrant} from './term2-listening-report/listening-report-online.mjs';");
  source=edit(source,'    const manualListeningReport=(miniReport||term1Report)',
    "    const term2Report=slug.data==='term-test-2-k56'&&k56ListeningReports?.term2ListeningReportsEnabled?.();\n    const manualListeningReport=(miniReport||term1Report||term2Report)");
  source=edit(source,"    if (parsed.data.state === 'recovered')\n      observeTerm1ListeningCheckpoint",
    "    const term2ListeningReportGrant=term2Report&&manualListeningReport\n      ?issueTerm2OnlineListeningReportGrant(config.termTestSessionSecret,{...parsed.data,manualListeningReport},row):null;\n    if (parsed.data.state === 'recovered')\n      observeTerm1ListeningCheckpoint");
  return edit(source,'      ...(term1ListeningReportGrant?{term1ListeningReportGrant}:{}),',
    '      ...(term1ListeningReportGrant?{term1ListeningReportGrant}:{}),\n      ...(term2ListeningReportGrant?{term2ListeningReportGrant}:{}),');
}

function journalEvents(source){
  return edit(source,'  if (phases.has(input.phase)) output.phase = input.phase;',`  if(testSlug==='term-test-2-k56'&&event==='term2_listening_report'&&UUID.test(input.incidentId||'')){
    output.term2ListeningReportVersion=1;
    output.incidentId=input.incidentId.toLowerCase();
    if(['enqueue','delivery'].includes(input.phase))output.phase=input.phase;
    if(['offline','online'].includes(input.mode))output.mode=input.mode;
    if(['open','sending','waiting_photo','photo_queued','sent','text_sent','retry_wait','failed','delivery_unknown','expired'].includes(input.status))
      output.reportStatus=input.status;
    if(Number.isSafeInteger(input.generation)&&input.generation>=0)output.generation=input.generation;
  }
  if (phases.has(input.phase)) output.phase = input.phase;`);
}

function journalRouting(source){
  return edit(source,'...(k56Offline?.miniListeningReportVersion||k56Offline?.term1ListeningReportVersion?{expectedGeneration:k56Offline.generation}:{})',
    '...(k56Offline?.miniListeningReportVersion||k56Offline?.term1ListeningReportVersion||k56Offline?.term2ListeningReportVersion?{expectedGeneration:k56Offline.generation}:{})');
}

export async function stageTerm2Report({sourceDir,mapFile,outputDir}){
  const transforms=[wrapper,offline,examOrder,app,journalEvents,journalRouting];
  const raw=await Promise.all(modified.map(name=>readFile(join(sourceDir,name))));
  const program=raw.map((text,index)=>transforms[index](text.toString('utf8').replace(/\r\n/g,'\n')));
  const files=[
    ...modified.map((name,index)=>['src/'+name,program[index]]),
    ...await Promise.all(modules.map(async name=>['src/term2-listening-report/'+name,await readFile(new URL(name,import.meta.url))])),
    ['src/term2-listening-report/listening-report-map-v1.mjs',await readFile(mapFile)],
    ['term2-listening-report.sql',term2ListeningReportSchema.replaceAll('assessment.','assessment_k56.')
      +'GRANT SELECT, INSERT, UPDATE ON TABLE assessment_k56.term2_k56_listening_report TO k56_shared_api;\n'],
  ];
  await mkdir(outputDir);
  for(const [name,content] of files){
    const destination=join(outputDir,name);
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,content,{flag:'wx'});
  }
  const result={product:'term-test-2-k56',
    sourceHashes:Object.fromEntries(modified.map((name,i)=>['src/'+name,sha(raw[i])])),
    outputHashes:Object.fromEntries(files.map(([name,content])=>[name,sha(content)])),
  };
  await writeFile(join(outputDir,'manifest.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [sourceDir,mapFile,outputDir]=process.argv.slice(2);
  if(!sourceDir||!mapFile||!outputDir)throw Error('Provide live src, reviewed map, and a fresh stage directory.');
  const staged=await stageTerm2Report({sourceDir,mapFile,outputDir});
  console.log(JSON.stringify({product:staged.product,files:Object.keys(staged.outputHashes).length}));
}
