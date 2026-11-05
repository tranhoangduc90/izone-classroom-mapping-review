// Native HTTP/SQL/producer/Agent/Collector, synthetic source, no AI/Google/Drive.
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as modern from './fixture-independent.mjs';
import {createIndependentApp} from '../independent/src/speaking-independent-server.js';
import {startSpeakingJournalRuntime} from '../independent/src/speaking-journal-runtime.js';
import {startSpeakingSpoolAgent} from './spool-agent.mjs';

export async function startNativeBrowserFixture({origin,enabled=true,loseClientAck=false}){
 const libraryRoot=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;if(!libraryRoot)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
 const lib=path=>import(pathToFileURL(resolve(libraryRoot,path)).href);
 const {createJournalService}=await lib('src/service.mjs');
 const {createSpeakingProducerJournalFromEnv}=await lib('adapters/speaking-producer.mjs');
 const {speakingHomeworkBinding,speakingHomeworkSchemas}=await lib('adapters/speaking-homework.mjs');
 const {ProductLogRegistry,storageScope}=await lib('src/product-record.mjs');
 const key=Buffer.alloc(32,7),product='speaking-homework',root=mkdtempSync(join(tmpdir(),'speaking-native-browser-'));
 const collector=await createJournalService({version:1,role:'primary',dataRoot:join(root,'collector'),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',ingestKey:key,genericSchemas:speakingHomeworkSchemas,
   replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}},{fixtureMode:true});
 let agent,runtime,f,server,closing,dropped=false;const requests=[],health=[];
 const close=()=>closing??=(async()=>{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  try{await runtime?.close({flushers:[f?.service.flushJournal]});}finally{
   try{await agent?.close();}finally{try{await collector.close();}finally{await f?.db.close();}}
  }
 })();
 try{
  await new Promise(r=>collector.server.listen(0,'127.0.0.1',r));
  const port=collector.server.address().port;
  if(enabled)agent=await startSpeakingSpoolAgent(libraryRoot,mkdtempSync(join(tmpdir(),'journal-producer-e2e-native-browser-')),port);
  const encoded=key.toString('base64'),file=join(root,'api.json');
  if(enabled)writeFileSync(file,JSON.stringify({version:1,identityKey:encoded,ticketKeys:{fixture:encoded},currentTicketKeyId:'fixture',
   rpc:{endpoint:`http://127.0.0.1:${port}/rpc/${product}`,key:encoded,producerSpool:{version:1,endpoint:agent.ready.endpoint}}}));
  runtime=await startSpeakingJournalRuntime({env:{EXAM_JOURNAL_ENABLED:enabled?'1':'0',EXAM_JOURNAL_CONFIG_FILE:file},allowedOrigins:[origin],onHealth:row=>health.push(row),
   load:async()=>({createSpeakingProducerJournalFromEnv:input=>createSpeakingProducerJournalFromEnv({...input,fixtureMode:true})})});
  if(enabled&&!runtime.journal)throw Error('FIXTURE_JOURNAL_START_FAILED');
  f=await modern.fixture({journal:runtime.journal});const app=createIndependentApp({service:f.service,origin,journalRuntime:runtime});
  server=createServer((req,res)=>{
   const path=new URL(req.url,'http://localhost').pathname,end=res.end.bind(res);
   res.end=function(body,...args){
    if(loseClientAck&&!dropped&&path.endsWith('/journal-events')&&res.statusCode===202){
     dropped=true;res.statusCode=503;body=JSON.stringify({ok:false,error:'FIXTURE_CLIENT_ACK_LOST'});res.setHeader('content-length',Buffer.byteLength(body));
    }
    return end(body,...args);
   };
   res.once('finish',()=>requests.push({method:req.method,path,httpStatus:res.statusCode,origin:req.headers.origin,
    allowedOrigin:res.getHeader('access-control-allow-origin'),requestId:req.headers['x-exam-journal-request-id'],
    ...(path.endsWith('/journal-events')?{eventIds:Array.isArray(req.body?.events)?req.body.events.map(row=>row.id):[]}:{})}));
   app(req,res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const scope=storageScope(speakingHomeworkBinding({mode:'independent',assignmentRef:modern.code,classRef:'1293',subjectRef:modern.ref,unitId:f.session.workUnitId}));
  const registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});
  return{...f,origin:`http://127.0.0.1:${server.address().port}`,ref:modern.ref,code:modern.code,requests,health,runtime,collector,close,
   async flush(){
    await f.service.flushJournal();await runtime.journal?.flush();
    if(agent)for(let turn=0;turn<8;turn++){
     const status=await agent.command('drain');if(status.queue.frames===0)break;
     await agent.command('advance',{seconds:11});
     if(turn===7)throw Error('FIXTURE_DRAIN_LIMIT');
    }
   },async rows(){return(await collector.stores.get(product).read(scope)).map(row=>registry.decode(scope,row));},
   async counts(){return{links:(await f.pool.query('SELECT count(*)::int AS n FROM speaking_independent.link')).rows[0].n,
    jobs:(await f.pool.query('SELECT count(*)::int AS n FROM speaking_independent.job')).rows[0].n};},
  };
 }catch(error){await close();throw error;}
}
