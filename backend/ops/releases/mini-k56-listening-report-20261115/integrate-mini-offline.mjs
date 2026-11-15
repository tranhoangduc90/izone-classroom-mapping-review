// Edits the captured Mini wrapper and recovery core when assembling an overlay.
// Leave its database, attempt routing and shared Term registrations untouched.
function replaceExact(source,before,after) {
  const first=source.indexOf(before);
  if(first===-1||source.indexOf(before,first+before.length)!==-1) {
    throw Error('MINI_LISTENING_OVERLAY_BASE_MISMATCH');
  }
  return source.slice(0,first)+after+source.slice(first+before.length);
}

export function integrateMiniOffline({wrapper,core}) {
  wrapper=replaceExact(wrapper,
    "import {isBlank} from './term1-blank.mjs';",
    "import {isBlank} from './term1-blank.mjs';\n"+
    "import {armMiniListeningReportService} from './mini-listening-report/listening-report-runtime.mjs';\n"+
    "import {createTelegramAlertSender} from './mini-listening-report/telegram-alerts.mjs';");
  wrapper=replaceExact(wrapper,
    'const {schema,registerOffline}=createK56Offline(profile);',
    'const {schema,registerOffline,permitFor}=createK56Offline(profile);');
  wrapper=replaceExact(wrapper,
    ' return registerOffline(router,{...dependencies,allowNew});',
    ` const {pool,secret,limiter,listeningReportLimiter=limiter,miniListeningReportSender,miniListeningReportObserver,record}=dependencies;
 const credentialFile=process.env.MINI_K56_LISTENING_REPORT_TELEGRAM_FILE;
 const policy=process.env.MINI_K56_LISTENING_REPORT_POLICY_FILE;
 const allowReporting=()=>{
  if(!policy)return true;
  try{return JSON.parse(readFileSync(policy,'utf8')).enabled===true;}catch{return false;}
 };
 const send=miniListeningReportSender??(credentialFile
  ?createTelegramAlertSender({credentialFile,preferIPv4:true}):undefined);
 const reports=armMiniListeningReportService({
  router,limiter:listeningReportLimiter,query:pool.query.bind(pool),makePermit:run=>permitFor(secret,run),onlineSecret:secret,send,allowReporting,
  observe:miniListeningReportObserver??(({status,attemptId,...detail})=>{
   if(attemptId)record?.('mini_listening_report',profile.slug,attemptId,{section:'listening',status,...detail});
   else if(status.endsWith('_error')||status.endsWith('_unavailable'))
    process.stderr.write('[mini-k56-listening-report] '+status+'\\n');
  })
 });
 const stopOffline=registerOffline(router,{...dependencies,allowNew,listeningReportsEnabled:reports.enabled});
 const stop=async()=>{stopOffline();await reports.close();};
 stop.listeningReportsEnabled=reports.enabled;
 return stop;`);
  core=replaceExact(core,
    "record,onWriting,allowNew=()=>profile.tablePrefix",
    "record,onWriting,listeningReportsEnabled=()=>false,allowNew=()=>profile.tablePrefix");
  core=replaceExact(core,
    'sendWindowHours:24,...(recovery.enabled(run)',
    'sendWindowHours:24,...(mini&&!paper&&listeningReportsEnabled()?{listeningReportsEnabled:true}:{}),...(recovery.enabled(run)');
  return {wrapper,core};
}

export function integrateMiniReportJournal(adapter) {
  return replaceExact(adapter,
    "  if (phases.has(input.phase)) output.phase = input.phase;",
    `  if(testSlug==='mini-test-k56'&&event==='mini_listening_report'&&UUID.test(input.incidentId||'')){
    output.miniListeningReportVersion=1;
    output.incidentId=input.incidentId.toLowerCase();
    if(['enqueue','delivery'].includes(input.phase))output.phase=input.phase;
    if(['offline','online'].includes(input.mode))output.mode=input.mode;
    if(['open','sending','waiting_photo','photo_queued','sent','text_sent','retry_wait','failed','delivery_unknown','expired'].includes(input.status))
      output.reportStatus=input.status;
    if(Number.isSafeInteger(input.generation)&&input.generation>=0)output.generation=input.generation;
  }
  if (phases.has(input.phase)) output.phase = input.phase;`);
}

export function integrateMiniJournalRouting(adapter) {
  return replaceExact(adapter,
    '    void observe({testSlug,token,type,data,content:k56Offline?undefined:content});',
    '    void observe({testSlug,token,type,data,content:k56Offline?undefined:content,\n'+
    '      ...(k56Offline?.miniListeningReportVersion?{expectedGeneration:k56Offline.generation}:{})});');
}

export function integrateMiniOnline({examOrder,app}) {
  examOrder=replaceExact(examOrder,
    'onJournalEvent, secret, onWriting, readLimiter, draftLimiter, authenticate,',
    'onJournalEvent, secret, onWriting, readLimiter, draftLimiter, listeningReportLimiter, authenticate,');
  examOrder=replaceExact(examOrder,
    '  registerMiniOffline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,record,onWriting});',
    '  const miniOffline=registerMiniOffline(router,{pool,secret,assets,prepare,load,transaction,serialize,resultFor,limiter,readLimiter,draftLimiter,listeningReportLimiter,record,onWriting});');
  examOrder=replaceExact(examOrder,
    "  app.use('/api/term-tests',router);",
    "  app.use('/api/term-tests',router);\n  return miniOffline.listeningReportsEnabled;");
  app=replaceExact(app,
    "import { registerK56ExamOrder } from './k56-exam-order.js';",
    "import { registerK56ExamOrder } from './k56-exam-order.js';\n"+
    "import {issueMiniOnlineListeningReportGrant} from './mini-listening-report/listening-report-online.mjs';");
  app=replaceExact(app,
    "  registerK56ExamOrder(app, { pool, profile: deploymentProfile, assets: termTestAssetService,",
    `  const listeningReportLimiter=rateLimit({
    windowMs:60_000,limit:req=>termTestRequestToken(req)?12:100,
    keyGenerator:termTestRateKey,standardHeaders:'draft-8',legacyHeaders:false,
    message:{ok:false,error:'LISTENING_REPORT_RATE_LIMITED'}
  });
  const miniListeningReportsEnabled=registerK56ExamOrder(app, { pool, profile: deploymentProfile, assets: termTestAssetService,
    listeningReportLimiter,`);
  app=replaceExact(app,
    "  state: z.enum(['playing', 'pause', 'waiting', 'stalled', 'recovered', 'pagehide'])\n});",
    `  state: z.enum(['playing', 'pause', 'waiting', 'stalled', 'recovered', 'pagehide'])
});
const miniManualListeningReportSchema=z.object({
  positionSeconds:z.number().min(0).max(7200),
  reportedAt:z.string().datetime(),
  audioHash:z.string().regex(/^[0-9a-f]{64}$/)
}).strict();`);
  app=replaceExact(app,
    "    if (parsed.data.state === 'recovered')\n      observeTerm1ListeningCheckpoint",
    `    const manualListeningReport=slug.data==='mini-test-k56'&&miniListeningReportsEnabled?.()
      ?miniManualListeningReportSchema.safeParse(req.body?.manualListeningReport).data:undefined;
    const miniListeningReportGrant=manualListeningReport
      ?issueMiniOnlineListeningReportGrant(config.termTestSessionSecret,{...parsed.data,manualListeningReport},row):null;
    if (parsed.data.state === 'recovered')
      observeTerm1ListeningCheckpoint`);
  app=replaceExact(app,
    '      ...(row.audio_recovery_version ? audioRecoveryPayload(row) : {}),\n      serverNow: row.server_now',
    '      ...(row.audio_recovery_version ? audioRecoveryPayload(row) : {}),\n'+
    '      ...(miniListeningReportGrant?{miniListeningReportGrant}:{}),\n      serverNow: row.server_now');
  return {examOrder,app};
}
