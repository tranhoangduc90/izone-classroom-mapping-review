import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Fixture-only loopback transport with the signed Collector receivers and native archive format.
export async function startPreviewExamJournal(source,origin,testSlug) {
  const load=file=>import(pathToFileURL(resolve(source,file)).href);
  const [{ScopeJournalStore},{createRpcReceiver,signRpc},{createOperatorReceiver},
    {createProductJournal},{mountTermJournal,termOwnerResolver}]=await Promise.all([
    load('src/scope-store.mjs'),load('src/remote-store.mjs'),load('src/operator.mjs'),
    load('src/product.mjs'),load('adapters/term.mjs')
  ]);
  const productId='term-mini-k67',schema='assessment';
  const root=await mkdtemp(join(tmpdir(),'k67-preview-collector-'));
  const ingestKey=randomBytes(32),operatorKey=randomBytes(32),receiptKey=randomBytes(32);
  let offset=0,producer,resolver;
  const store=new ScopeJournalStore({file:join(root,'journal.sqlite'),allowedProduct:productId,
    keys:{fixture:randomBytes(32)},currentKeyId:'fixture',minFreeBytes:0,clock:()=>Date.now()+offset,
    driveTransit:{folderId:'fixture-k67-archive',receiptKey}});
  const rpc=createRpcReceiver({store,productId,key:ingestKey});
  const operator=createOperatorReceiver({store,productId,key:operatorKey,driveTransit:true});
  const collector=createServer(async (req,res)=>{
    try {
      const receiver=req.url===`/rpc/${productId}`?rpc:req.url===`/operator/${productId}`?operator:null;
      if(req.method!=='POST'||!receiver){res.writeHead(404).end();return;}
      const chunks=[];
      for await(const chunk of req)chunks.push(chunk);
      const result=await receiver(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(result.status,{'content-type':'application/json'}).end(JSON.stringify(result.body));
    }catch{res.writeHead(400).end();}
  });
  await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${collector.address().port}`;
  function mount(app,options) {
    const query=options.pool.query.bind(options.pool);
    resolver=termOwnerResolver({query,schema});
    producer=createProductJournal({productId,resolveOwner:resolver,allowedOrigins:[origin],build:'k67-browser-fixture',fixtureMode:true,
      fixtureConfig:{version:1,identityKey:randomBytes(32).toString('base64'),
        ticketKeys:{fixture:randomBytes(32).toString('base64')},currentTicketKeyId:'fixture',
        rpc:{endpoint:`${base}/rpc/${productId}`,key:ingestKey.toString('base64')}}});
    return mountTermJournal(app,{...options,productId,schema,journal:producer,lookupQuery:query});
  }
  async function call(method,...args) {
    const envelope={version:1,productId,nonce:randomUUID(),sentAt:Date.now(),method,args};
    const response=await fetch(`${base}/operator/${productId}`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({envelope,signature:signRpc(operatorKey,envelope)})});
    const {receipt,signature}=await response.json();
    if(!response.ok||receipt.nonce!==envelope.nonce||signRpc(operatorKey,receipt)!==signature)throw Error('Fixture Collector read failed');
    return receipt.result;
  }
  async function read(token,archive,bySession=false) {
    const owner=await resolver(bySession?{examSessionToken:token}:{attemptToken:token},{testSlug});
    const scope=producer.scopeForOwner(owner),scopeId=store.scopeId(scope);
    let packs=[];
    if(archive){
      offset=301_000;
      for(let i=0;i<30;i++){
        const {work,backlog}=await call('transitWork',{apply:true,kind:'seal'});
        if(!work&&(!backlog.oldest||backlog.oldest>Date.now()+offset-300_000))break;
      }
      const native=await store.local(scopeId);
      packs=native.cold.pendingDriveSegments().map(segment=>({eventCount:segment.eventCount,
        format:native.exportPack(segment.packId).bytes.subarray(0,5).toString()}));
    }
    const result=await call('transitRead',scope,{maxEvents:2000});
    return {scopeId,events:result.events,packs};
  }
  async function close(){
    await new Promise(resolve=>collector.close(resolve));
    store.close();
  }
  return {mount,read,close};
}
