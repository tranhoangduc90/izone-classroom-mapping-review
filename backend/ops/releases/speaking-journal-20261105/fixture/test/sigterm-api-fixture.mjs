// Child owns the native API/SQL/producer; Agent/Collector remain in parent.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as modern from './fixture-independent.mjs';
import {createIndependentApp} from '../independent/src/speaking-independent-server.js';
import {startSpeakingJournalRuntime} from '../independent/src/speaking-journal-runtime.js';
if(process.platform!=='linux'||!process.send||process.env.SPEAKING_SIGTERM_FIXTURE!=='synthetic-native-sigterm-v1')throw Error('FIXTURE_ONLY');
const root=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;
const {createSpeakingProducerJournalFromEnv}=await import(pathToFileURL(resolve(root,'adapters/speaking-producer.mjs')).href);
const origin='https://fixture.invalid';
const runtime=await startSpeakingJournalRuntime({env:process.env,allowedOrigins:[origin],
 load:async()=>({createSpeakingProducerJournalFromEnv:input=>createSpeakingProducerJournalFromEnv({...input,fixtureMode:true})})});
if(!runtime.journal)throw Error('FIXTURE_RUNTIME_NOT_CONFIGURED');
const f=await modern.fixture({journal:runtime.journal});
const server=createIndependentApp({service:f.service,origin,journalRuntime:runtime}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));let closing;
const stop=()=>closing??=(async()=>{
 await new Promise(r=>server.close(r));
 await runtime.close({flushers:[f.service.flushJournal]});
 const boundary=f.service.journalHealth(),transport=runtime.journal.metrics();await f.db.close();
 process.send({stopped:true,runtime:runtime.snapshot(),boundary,transport});
})();
process.on('SIGTERM',()=>void stop().catch(()=>{process.send({stopFailed:true});process.exitCode=1;}));
process.send({ready:true,port:server.address().port,identity:f.identity,unitId:f.session.workUnitId});
