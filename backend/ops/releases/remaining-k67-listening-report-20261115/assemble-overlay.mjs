import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {k67ListeningReportSchema} from './listening-report-queue.mjs';

const products=['term-test-1','mini-test-lesson-5','pretest-lesson-16'];
const scopedKeys=['term1','mini','pretest'];
const baseFiles=['src/app.js','src/mini-cbt-journey.js'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function replace(source,before,after){
  if(source.split(before).length!==2)throw Error('Live source drift near '+before.slice(0,90));
  return source.replace(before,()=>after);
}
function addReports(source){
  source=replace(source,"import {armTerm2K67Reports} from './term2-listening-report/listening-report-service.mjs';",`
import {armTerm2K67Reports} from './term2-listening-report/listening-report-service.mjs';
import {armK67ProductReports} from './k67-product-listening-report/listening-report-service.mjs';`.trim());
  return replace(source,"  mountTerm2CbtJourney(app,termCbtServices('term-test-2'));",`
  mountTerm2CbtJourney(app,termCbtServices('term-test-2'));
  app.locals.eligibleListeningReports=new Map(${JSON.stringify(products)}.map(testSlug=>[testSlug,
    armK67ProductReports({slug:testSlug,app,query:reportQuery,secret:config.termTestSessionSecret,
      limiter:rateLimit({windowMs:60000,limit:100,keyGenerator:examRateKey,standardHeaders:'draft-8',legacyHeaders:false}),
      observe({sessionId,generation,operationId,incidentId,phase,status,mode}){
        if(!sessionId||!operationId||!incidentId)return;
        void termJournal?.observe?.({testSlug,type:'decision_made',
          proof:{examSessionToken:sessionId,expectedGeneration:generation},
          data:{action:'k67_listening_reporting',section:'listening',checkpointState:{
            productSlug:testSlug,reportVersion:1,operationId,incidentId,phase,reportStatus:status,generation,...(mode?{mode}:{})
          }}});
      }}),
  ]));`.trimEnd().slice(1));
}
function persistListeningStart(source){
  return replace(source,'...(profile===term2&&interruption?{startedAt:body.startedAt}:{})',
    '...(!profile.paper&&interruption?{startedAt:body.startedAt}:{})');
}
async function stage({input,profileMap,sender,output}){
  const raw=await Promise.all(baseFiles.map(path=>readFile(join(input,path))));
  const modules='src/k67-product-listening-report/';
  const files=[
    [baseFiles[0],addReports(raw[0].toString('utf8').replace(/\r\n/g,'\n'))],
    [baseFiles[1],persistListeningStart(raw[1].toString('utf8').replace(/\r\n/g,'\n'))],
    [modules+'telegram-alerts.mjs',await readFile(sender)],
    [modules+'listening-profiles-v1.mjs',await readFile(profileMap)],
    [modules+'listening-report-service.mjs',await readFile(new URL('listening-report-service.mjs',import.meta.url))],
    [modules+'listening-report-queue.mjs',await readFile(new URL('listening-report-queue.mjs',import.meta.url))],
    ['k67-product-listening-report.sql',scopedKeys.map(k67ListeningReportSchema).join('\n')],
  ];
  await mkdir(output);
  for(const [name,bytes] of files){
    const target=join(output,name);
    await mkdir(dirname(target),{recursive:true});
    await writeFile(target,bytes,{flag:'wx'});
  }
  const manifest={product:'k67-listening-products',profiles:products,
    sourceHashes:Object.fromEntries(baseFiles.map((path,index)=>[path,sha(raw[index])])),
    outputHashes:Object.fromEntries(files.map(([path,bytes])=>[path,sha(bytes)]))};
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({products,files:files.length}));
}
const [input,profileMap,sender,output]=process.argv.slice(2);
if(!input||!profileMap||!sender||!output)throw Error('Expect verified runtime root, exact profiles, pinned sender and fresh release directory');
await stage({input,profileMap,sender,output});
