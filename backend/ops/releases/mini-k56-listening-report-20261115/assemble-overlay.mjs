import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {integrateMiniOffline,integrateMiniOnline,integrateMiniReportJournal,integrateMiniJournalRouting} from './integrate-mini-offline.mjs';
import {miniListeningReportSchema} from './listening-report-queue.mjs';

const buildModules=['listening-report-runtime.mjs','listening-report-queue.mjs','listening-report-native.mjs',
  'listening-report-ingress.mjs','listening-report-online.mjs'];
const transportModules=['contract.mjs','telegram-alerts.mjs'];
const hash=content=>createHash('sha256').update(content).digest('hex');
const offlineFiles=['mini-offline.mjs','mini-k56-recovery-core.mjs'];
const onlineFiles=['k56-exam-order.js','app.js'];
const journalDirectory='exam-journal-runtime/adapters/';
const journalFiles=[journalDirectory+'term-k56-offline.mjs',journalDirectory+'term.mjs'];

export async function assembleMiniReportOverlay({sourceDir,transportDir,outputDir}) {
  const names=[...offlineFiles,...onlineFiles,...journalFiles];
  const input=Object.fromEntries(await Promise.all(names.map(async name=>[name,await readFile(join(sourceDir,name),'utf8')])));
  const canonical=key=>input[key].replace(/\r\n/g,'\n');
  const {wrapper,core}=integrateMiniOffline({wrapper:canonical(offlineFiles[0]),core:canonical(offlineFiles[1])});
  const {examOrder,app}=integrateMiniOnline({examOrder:canonical(onlineFiles[0]),app:canonical(onlineFiles[1])});
  const updated=[
    wrapper,core,examOrder,app,integrateMiniReportJournal(canonical(journalFiles[0])),
    integrateMiniJournalRouting(canonical(journalFiles[1])),
  ];
  const modules=[
    ...await Promise.all(buildModules.map(async name=>[name,await readFile(new URL(name,import.meta.url),'utf8')])),
    ...await Promise.all(transportModules.map(async name=>[name,await readFile(join(transportDir,name),'utf8')])),
  ];
  const files=[
    ...names.map((name,i)=>['src/'+name,updated[i]]),
    ...modules.map(([name,content])=>['src/mini-listening-report/'+name,content.replace(/\r\n/g,'\n')]),
    ['mini-listening-report.sql',miniListeningReportSchema.replaceAll('assessment.','assessment_k56.')
      +'GRANT SELECT, INSERT, UPDATE ON TABLE assessment_k56.mini_k56_listening_report TO k56_shared_api;\n'],
  ];
  // A new output directory keeps a previous candidate and its manifest intact.
  await mkdir(outputDir);
  for(const [name,content] of files){
    const path=join(outputDir,name);
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,content,{flag:'wx'});
  }
  const manifest={
    product:'mini-test-k56',overlayVersion:1,
    sourceHashes:Object.fromEntries(names.map(name=>['src/'+name,hash(input[name])])),
    outputHashes:Object.fromEntries(await Promise.all(files.map(async([name])=>{
      return [name,hash(await readFile(join(outputDir,name)))];
    }))),
  };
  await writeFile(join(outputDir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [sourceDir,transportDir,outputDir]=process.argv.slice(2);
  if(!sourceDir||!transportDir||!outputDir)throw Error('Usage: node assemble-overlay.mjs <runtime src> <journal src> <new output directory>');
  const manifest=await assembleMiniReportOverlay({sourceDir,transportDir,outputDir});
  console.log(JSON.stringify({product:manifest.product,files:Object.keys(manifest.outputHashes).length}));
}
