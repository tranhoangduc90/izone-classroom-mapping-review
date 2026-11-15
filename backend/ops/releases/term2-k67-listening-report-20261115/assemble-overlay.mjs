import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {term2K67ListeningReportSchema} from './listening-report-queue.mjs';

const sources=['app.js','exam-journal-runtime/adapters/term.mjs','mini-cbt-journey.js'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const edit=(text,before,after)=>{
  if(text.split(before).length!==2)throw Error('Live source changed near '+before.slice(0,90));
  return text.replace(before,after);
};
const app = source=>{
  source=edit(source,"import { mountMiniCbtJourney,",
    "import {armTerm2K67Reports} from './term2-listening-report/listening-report-service.mjs';\nimport { mountMiniCbtJourney,");
  source=edit(source,"  const rateIdentity=examRateIdentity(pool);",
    "  const reportQuery=pool.query.bind(pool);\n  const rateIdentity=examRateIdentity(pool);");
  return edit(source,"  mountTerm2CbtJourney(app,termCbtServices('term-test-2'));",
    `  mountTerm2CbtJourney(app,termCbtServices('term-test-2'));
  app.locals.term2K67Reports=armTerm2K67Reports({app,query:reportQuery,
    secret:config.termTestSessionSecret,
    limiter:rateLimit({windowMs:60000,limit:100,keyGenerator:examRateKey,standardHeaders:'draft-8',legacyHeaders:false}),
    observe({sessionId,generation,operationId,incidentId,phase,status,mode}){
      if(!sessionId||!operationId||!incidentId)return;
      void termJournal?.observe?.({testSlug:'term-test-2',type:'decision_made',
        proof:{examSessionToken:sessionId,expectedGeneration:generation},
        data:{action:'term2_k67_listening_reporting',section:'listening',checkpointState:{
          reportVersion:1,operationId,incidentId,phase,reportStatus:status,generation,...(mode?{mode}:{})
        }}});
    }});`);
};
const adapter=source=>edit(source,"      const owner = await work;\n      const context",
  "      const owner = await work;\n      if(!owner || (Number.isSafeInteger(proof?.expectedGeneration) && owner.generation!==proof.expectedGeneration)\n        || (Number.isSafeInteger(proof?.expectedGeneration)&&owner.versions?.superseded))return;\n      const context");

const journey=source=>edit(source,
  "examSessionToken:state.session.id,generation:body.generation,capturedAt:body.capturedAt};",
  "examSessionToken:state.session.id,generation:body.generation,capturedAt:body.capturedAt," +
  "\n        ...(profile===term2&&interruption?{startedAt:body.startedAt}:{})};");

export async function stage({input,output,map,sender}){
  const raw=await Promise.all(sources.map(name=>readFile(join(input,name))));
  const files=[
    ['src/app.js',app(raw[0].toString('utf8').replace(/\r\n/g,'\n'))],
    ['src/exam-journal-runtime/adapters/term.mjs',adapter(raw[1].toString('utf8').replace(/\r\n/g,'\n'))],
    ['src/mini-cbt-journey.js',journey(raw[2].toString('utf8').replace(/\r\n/g,'\n'))],
    ['src/term2-listening-report/listening-report-map-v1.mjs',await readFile(map)],
    ['src/term2-listening-report/telegram-alerts.mjs',
      edit(await readFile(sender,'utf8'),"from './contract.mjs'","from '../exam-journal-runtime/src/contract.mjs'")],
    ...await Promise.all(['listening-report-queue.mjs','listening-report-service.mjs'].map(async name=>
      ['src/term2-listening-report/'+name,await readFile(new URL(name,import.meta.url))])),
    ['term2-k67-listening-report.sql',term2K67ListeningReportSchema],
  ];
  await mkdir(output);
  for(const [name,bytes] of files){
    const target=join(output,name);
    await mkdir(dirname(target),{recursive:true});
    await writeFile(target,bytes,{flag:'wx'});
  }
  const manifest={product:'term-test-2',sourceHashes:Object.fromEntries(sources.map((name,index)=>['src/'+name,digest(raw[index])])),
    outputHashes:Object.fromEntries(files.map(([name,bytes])=>[name,digest(bytes)]))};
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [input,map,sender,output]=process.argv.slice(2);
  if(!input||!map||!sender||!output)throw Error('Provide live source, reviewed map and sender, and empty release directory');
  const manifest=await stage({input,map,sender,output});
  console.log(JSON.stringify({product:manifest.product,files:Object.keys(manifest.outputHashes).length}));
}
