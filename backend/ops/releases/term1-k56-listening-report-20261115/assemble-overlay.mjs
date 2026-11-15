import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {term1ListeningReportSchema} from './listening-report-queue.mjs';

const modified=['term1-offline.mjs','term1-skill-offline-core.mjs','k56-exam-order.js','app.js','term1-skill-routes.mjs',
  'exam-journal-runtime/adapters/term-k56-offline.mjs','exam-journal-runtime/adapters/term.mjs'];
const modules=['listening-report-runtime.mjs','listening-report-queue.mjs','listening-report-native.mjs',
  'listening-report-ingress.mjs','listening-report-online.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');

function edit(source,before,after){
  if(source.split(before).length!==2)throw Error('Term 1 overlay anchor differs: '+before);
  return source.replace(before,()=>after);
}

function wrapper(source){
  return edit(source,'export const registerTerm1Offline=api.registerOffline;',`
import {readFileSync} from 'node:fs';
import {armTerm1ListeningReportService} from './term1-listening-report/listening-report-runtime.mjs';
import {createTelegramAlertSender} from './mini-listening-report/telegram-alerts.mjs';
export function registerTerm1Offline(router,dependencies){
 const {pool,secret,limiter,listeningReportLimiter=limiter,term1ListeningReportSender,record}=dependencies;
 const credentialFile=process.env.MINI_K56_LISTENING_REPORT_TELEGRAM_FILE;
 const policyFile=process.env.TERM1_K56_LISTENING_REPORT_POLICY_FILE;
 const allowReporting=()=>{
  if(!policyFile)return false;
  try{return JSON.parse(readFileSync(policyFile,'utf8')).enabled===true;}catch{return false;}
 };
 const send=term1ListeningReportSender??(policyFile&&credentialFile?
  createTelegramAlertSender({credentialFile,preferIPv4:true}):undefined);
 const reports=armTerm1ListeningReportService({
  router,limiter:listeningReportLimiter,query:pool.query.bind(pool),
  makePermit:run=>permitFor(secret,run),onlineSecret:secret,send,allowReporting,
  observe:({status,attemptId,...detail})=>{
   if(attemptId)record?.('term1_listening_report',SLUG,attemptId,{section:'listening',status,...detail});
   else if(typeof status==='string'&&(status.endsWith('_error')||status.endsWith('_unavailable')))
    process.stderr.write('[term1-k56-listening-report] '+status+'\\n');
  },
 });
 const stopOffline=api.registerOffline(router,{...dependencies,listeningReportsEnabled:reports.enabled});
 const stop=async()=>{stopOffline();await reports.close();};
 stop.listeningReportsEnabled=reports.enabled;
 return stop;
}`.trim());
}

function offline(source){
  source=edit(source,'record,onWriting,allowNew=()=>profile.tablePrefix','record,onWriting,listeningReportsEnabled=()=>false,allowNew=()=>profile.tablePrefix');
  return edit(source,'sendWindowHours:24,...(isHoldRun(run)',
    "sendWindowHours:24,...(profile.tablePrefix==='term1'&&listeningReportsEnabled()?{listeningReportsEnabled:true}:{}),...(isHoldRun(run)");
}

function examOrder(source){
  source=edit(source,'  registerTerm1Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});',
    '  const term1Offline=registerTerm1Offline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,listeningReportLimiter,record,onWriting});');
  source=edit(source,'    issueAudio:issueTerm1SkillAudio,',
    '    issueAudio:issueTerm1SkillAudio,listeningReportsEnabled:term1Offline.listeningReportsEnabled,');
  return edit(source,'return miniOffline.listeningReportsEnabled;',
    'return {miniListeningReportsEnabled:miniOffline.listeningReportsEnabled,term1ListeningReportsEnabled:term1Offline.listeningReportsEnabled};');
}

function app(source){
  source=edit(source,"import {issueMiniOnlineListeningReportGrant} from './mini-listening-report/listening-report-online.mjs';",
    "import {issueMiniOnlineListeningReportGrant} from './mini-listening-report/listening-report-online.mjs';\nimport {issueTerm1OnlineListeningReportGrant} from './term1-listening-report/listening-report-online.mjs';");
  source=edit(source,'const miniListeningReportsEnabled=registerK56ExamOrder(app,',
    'const k56ListeningReports=registerK56ExamOrder(app,');
  source=edit(source,"    const manualListeningReport=slug.data==='mini-test-k56'&&miniListeningReportsEnabled?.()",
    "    const miniReport=slug.data==='mini-test-k56'&&k56ListeningReports?.miniListeningReportsEnabled?.();\n    const term1Report=slug.data==='term-test-1-k56'&&k56ListeningReports?.term1ListeningReportsEnabled?.();\n    const manualListeningReport=(miniReport||term1Report)");
  source=edit(source,'    const miniListeningReportGrant=manualListeningReport\n',
    '    const miniListeningReportGrant=miniReport&&manualListeningReport\n');
  source=edit(source,"    if (parsed.data.state === 'recovered')\n      observeTerm1ListeningCheckpoint",
    "    const term1ListeningReportGrant=term1Report&&manualListeningReport\n      ?issueTerm1OnlineListeningReportGrant(config.termTestSessionSecret,{...parsed.data,manualListeningReport},row):null;\n    if (parsed.data.state === 'recovered')\n      observeTerm1ListeningCheckpoint");
  source=edit(source,'      ...(miniListeningReportGrant?{miniListeningReportGrant}:{}),',
    '      ...(miniListeningReportGrant?{miniListeningReportGrant}:{}),\n      ...(term1ListeningReportGrant?{term1ListeningReportGrant}:{}),');
  return source;
}

function fallbackRoutes(source){
  source=edit(source,'limiter, readLimiter, record, issueAudio, readWriting, readReview,',
    'limiter, readLimiter, record, issueAudio, readWriting, readReview, listeningReportsEnabled=()=>false,');
  return edit(source,'position, audioDownload, listeningContinuityVersion: 1, listeningInterrupted }',
    'position, audioDownload, listeningContinuityVersion: 1, listeningInterrupted,\n          ...(listeningReportsEnabled()?{listeningReportsEnabled:true}:{}) }');
}

function journalEvents(source){
  return edit(source,'  if (phases.has(input.phase)) output.phase = input.phase;',`  if(testSlug==='term-test-1-k56'&&event==='term1_listening_report'&&UUID.test(input.incidentId||'')){
    output.term1ListeningReportVersion=1;
    output.incidentId=input.incidentId.toLowerCase();
    if(['enqueue','delivery'].includes(input.phase))output.phase=input.phase;
    if(['offline','online','fallback'].includes(input.mode))output.mode=input.mode;
    if(['open','sending','waiting_photo','photo_queued','sent','text_sent','retry_wait','failed','delivery_unknown','expired'].includes(input.status))
      output.reportStatus=input.status;
    if(Number.isSafeInteger(input.generation)&&input.generation>=0)output.generation=input.generation;
  }
  if (phases.has(input.phase)) output.phase = input.phase;`);
}

function journalRouting(source){
  return edit(source,'...(k56Offline?.miniListeningReportVersion?{expectedGeneration:k56Offline.generation}:{})',
    '...(k56Offline?.miniListeningReportVersion||k56Offline?.term1ListeningReportVersion?{expectedGeneration:k56Offline.generation}:{})');
}

export async function stageTerm1Report({sourceDir,mapFile,outputDir}){
  const transforms=[wrapper,offline,examOrder,app,fallbackRoutes,journalEvents,journalRouting];
  const raw=await Promise.all(modified.map(name=>readFile(join(sourceDir,name))));
  const program=raw.map((text,index)=>transforms[index](text.toString('utf8').replace(/\r\n/g,'\n')));
  const files=[
    ...modified.map((name,index)=>['src/'+name,program[index]]),
    ...await Promise.all(modules.map(async name=>['src/term1-listening-report/'+name,await readFile(new URL(name,import.meta.url))])),
    ['src/term1-listening-report/listening-report-map-v1.mjs',await readFile(mapFile)],
    ['term1-listening-report.sql',term1ListeningReportSchema.replaceAll('assessment.','assessment_k56.')
      +'GRANT SELECT, INSERT, UPDATE ON TABLE assessment_k56.term1_k56_listening_report TO k56_shared_api;\n'],
  ];
  await mkdir(outputDir);
  for(const [name,content] of files){
    const destination=join(outputDir,name);
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,content,{flag:'wx'});
  }
  const result={product:'term-test-1-k56',
    sourceHashes:Object.fromEntries(modified.map((name,i)=>['src/'+name,sha(raw[i])])),
    outputHashes:Object.fromEntries(files.map(([name,content])=>[name,sha(content)])),
  };
  await writeFile(join(outputDir,'manifest.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [sourceDir,mapFile,outputDir]=process.argv.slice(2);
  if(!sourceDir||!mapFile||!outputDir)throw Error('Provide live src, reviewed map, and a fresh stage directory.');
  const staged=await stageTerm1Report({sourceDir,mapFile,outputDir});
  console.log(JSON.stringify({product:staged.product,files:Object.keys(staged.outputHashes).length}));
}
