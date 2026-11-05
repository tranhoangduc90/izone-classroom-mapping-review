import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import * as modern from './fixture-independent.mjs';
import * as legacy from './fixture-legacy.mjs';
import {registerWorkPublisher as registerModernWork} from '../independent/src/test-work-runtime.js';
import {registerWorkPublisher as registerLegacyWork} from '../legacy/src/test-work-runtime.js';
const libraryRoot=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;
if(!libraryRoot)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const library=relative=>import(pathToFileURL(resolve(libraryRoot,relative)).href);
const {createSpeakingHomeworkJournal,speakingHomeworkBinding,speakingHomeworkSchemas}=await library('adapters/speaking-homework.mjs');
const {createJournalService}=await library('src/service.mjs');
const {RemoteJournalStore}=await library('src/remote-store.mjs');
const {ProductLogRegistry,storageScope}=await library('src/product-record.mjs');

const product='speaking-homework',registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});
async function collector(t){
 const ingestKey=Buffer.alloc(32,9),service=await createJournalService({version:1,role:'primary',
  dataRoot:mkdtempSync(join(tmpdir(),'speaking-commit-log-')),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',
   ingestKey,genericSchemas:speakingHomeworkSchemas,replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key:ingestKey}],
   drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:ingestKey.toString('base64')}}}}, {fixtureMode:true});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const remote=new RemoteJournalStore({endpoint:`http://127.0.0.1:${service.server.address().port}/rpc/${product}`,
  productId:product,key:ingestKey,fixtureMode:true});await remote.ready;
 t.after(async()=>{await remote.close();await service.close();});
 const journal=createSpeakingHomeworkJournal({append:remote.append.bind(remote)}),projections=[];
 return{projections,callback:async projection=>{
  projections.push(structuredClone(projection));
  return journal.recordCommitted(speakingHomeworkBinding(projection.scope),projection);
 },async read(){
  const scopes=new Map(projections.map(row=>{const b=speakingHomeworkBinding(row.scope);return[JSON.stringify(b),storageScope(b)];}));
  const rows=[];for(const scope of scopes.values())for(const row of await service.stores.get(product).read(scope))rows.push(registry.decode(scope,row));
  return rows;
 }};
}
async function delivered(service,expected){
 const until=Date.now()+5000;
 while(service.journalHealth().pending&&Date.now()<until)await delay(10);
 assert.equal(service.journalHealth().pending,0);assert.equal(service.journalHealth().unknown,0);
 assert.equal(service.journalHealth().overflow,0);assert.equal(service.journalHealth().delivered,expected);
}
function commitTrace(pool){
 const connect=pool.connect.bind(pool),state={commits:0,failCommit:false};
 pool.connect=async()=>{const db=await connect(),query=db.query.bind(db);return{...db,async query(sql,...args){
  if(sql==='COMMIT'&&state.failCommit)throw Error('FIXTURE_COMMIT_FAILED');
  const value=await query(sql,...args);if(sql==='COMMIT')state.commits++;return value;
 }};};return state;
}

test('modern: main/practice/receipt từ SQL commit qua signed Collector, replay không tạo mới',async t=>{
 const c=await collector(t);let trace;
 const f=await modern.fixture({journal:projection=>{assert.ok(trace.commits>0);return c.callback(projection);}});
 t.after(()=>f.db.close());trace=commitTrace(f.pool);
 const lanes=[],detach=registerModernWork(f.pool,lane=>lanes.push({lane,commits:trace.commits}));t.after(detach);
 const inputs=[['benefit_harm',1],['reason_action',2],['freestyle',3]];
 for(const [part,n]of inputs)await f.service.requestCheck({...f.identity,part,rawUrl:modern.url(n)});
 const first=await f.service.requestCheck({...f.identity,part:'benefit_harm',rawUrl:modern.url(1)});
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM speaking_independent.link')).rows[0].n,3);
 for(const slot of [1,2])await f.service.requestPracticeCheck({...f.identity,slot,exerciseId:modern.exercise(slot),rawUrl:modern.url(slot+3)});
 const links=(await f.pool.query('SELECT * FROM speaking_independent.link ORDER BY part')).rows;
 // Seed deterministic checker outcomes only; no Share/AI calls. Worker/lease integration is a later slice.
 for(const [i,row]of links.entries())if(row.status!=='accepted')await f.pool.query(
  "UPDATE speaking_independent.link SET status='accepted',fingerprint=$2,question_count=5 WHERE id=$1",[row.id,String(i+2).repeat(64)]);
 const receipt=await f.service.finish(f.identity),again=await f.service.finish(f.identity);
 assert.equal(again.id,receipt.id);assert.ok(first.id);await delivered(f.service,7);
 const rows=await c.read();assert.equal(rows.length,7);
 assert.equal(rows.filter(row=>row.kind==='link.saved').length,5);
 const saved=rows.find(row=>row.kind==='submit.accepted');assert.equal(saved.data.receiptId,receipt.id);
 assert.equal(saved.data.acceptedMainCount,3);assert.equal(saved.data.acceptedPracticeCount,2);
 for(const row of rows.filter(row=>row.kind==='link.saved')){
  const native=(await f.pool.query('SELECT created_at FROM speaking_independent.link WHERE id=$1',[row.data.linkId])).rows[0];
  assert.equal(row.occurredAt,new Date(native.created_at).toISOString());
 }
 assert.ok(c.projections.every(row=>row.scope.mode==='independent'&&row.scope.unitId===f.session.workUnitId&&row.scope.subjectRef===modern.ref));
 assert.ok(!JSON.stringify(rows).includes('chatgpt.com'));assert.ok(!JSON.stringify(rows).includes(f.identity.accessToken));
 assert.ok(lanes.some(row=>row.lane==='ai'));assert.ok(lanes.every(row=>row.commits>0));
});

test('legacy: main/practice/receipt dùng access_grant, giữ work-ready và không đụng bài mới',async t=>{
 const c=await collector(t);let trace;
 const f=await legacy.fixture({journal:projection=>{assert.ok(trace.commits>0);return c.callback(projection);}});
 t.after(()=>f.db.close());trace=commitTrace(f.pool);
 const lanes=[],detach=registerLegacyWork(f.pool,lane=>lanes.push({lane,commits:trace.commits}));t.after(detach);
 await f.pool.query("UPDATE speaking_homework.assignment SET required_practice_count=2 WHERE assignment_code='67-speaking-lesson-2'");
 const identity={accessToken:legacy.accessToken,studentRef:legacy.studentRef};
 for(const [part,letter]of [['paraphrase','a'],['speaking','b']])await f.service.requestCheck({...identity,part,rawUrl:legacy.share(letter)});
 const duplicate=await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('a')});assert.ok(duplicate.linkId);
 for(const [slot,letter]of [[1,'c'],[2,'d']]){
  const exercise=(await f.pool.query("INSERT INTO speaking_homework.doctor_exercise(course_key,source_record_id,title,exercise_url) VALUES('67',$1,'Fixture','https://example.invalid') RETURNING id",['fixture-'+slot])).rows[0].id;
  await f.service.requestPracticeCheck({...identity,slot,exerciseId:exercise,rawUrl:legacy.share(letter)});
 }
 for(const [table,field]of [['submission_link','check_status'],['practice_link','status']]){
  const rows=(await f.pool.query(`SELECT id FROM speaking_homework.${table} ORDER BY id`)).rows;
  for(const [i,row]of rows.entries())await f.pool.query(`UPDATE speaking_homework.${table} SET ${field}='accepted',fingerprint=$2,question_count=6 WHERE id=$1`,[row.id,(table==='submission_link'?String(i+1):String(i+5)).repeat(64)]);
 }
 const receipt=await f.service.finish(identity),again=await f.service.finish(identity);assert.equal(again.id,receipt.id);
 await delivered(f.service,5);const rows=await c.read();assert.equal(rows.length,5);
 const grant=(await f.pool.query('SELECT id FROM speaking_homework.access_grant WHERE student_ref=$1 AND document_id=$2',[legacy.studentRef,'doc-A'])).rows[0].id;
 assert.ok(c.projections.every(row=>row.scope.mode==='legacy'&&row.scope.unitId===grant&&row.scope.assignmentRef==='67-speaking-lesson-2'));
 assert.equal(rows.filter(row=>row.kind==='submit.accepted').length,1);
 for(const row of rows.filter(row=>row.kind==='link.saved')){
  const practice=row.data.linkKind==='practice';
  const native=(await f.pool.query(`SELECT ${practice?'submitted_at':'created_at'} AS at FROM speaking_homework.${practice?'practice_link':'submission_link'} WHERE id=$1`,[row.data.linkId])).rows[0];
  assert.equal(row.occurredAt,new Date(native.at).toISOString());
 }
 assert.ok(!JSON.stringify(rows).includes('doc-A'));assert.ok(!JSON.stringify(rows).includes('chatgpt.com'));
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM speaking_homework.check_job')).rows[0].n,2);
 assert.ok(lanes.some(row=>row.lane==='ai'));assert.ok(lanes.every(row=>row.commits>0));
});

for(const [mode,make,input,table]of [
 ['independent',modern.fixture,f=>({...f.identity,part:'benefit_harm',rawUrl:modern.url(9)}),'speaking_independent.link'],
 ['legacy',legacy.fixture,()=>({accessToken:legacy.accessToken,studentRef:legacy.studentRef,part:'paraphrase',rawUrl:legacy.share('e')}),'speaking_homework.submission_link'],
])test(`${mode}: SQL COMMIT lỗi rollback link/job và không phát log`,async t=>{
 let sent=0;const f=await make({journal:()=>{sent++;return{persisted:true};}});t.after(()=>f.db.close());
 const trace=commitTrace(f.pool);trace.failCommit=true;
 await assert.rejects(f.service.requestCheck(input(f)),/FIXTURE_COMMIT_FAILED/);
 await delay(10);assert.equal(sent,0);assert.equal(f.service.journalHealth().discardedOnTransactionError,1);
 assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
 const jobTable=mode==='independent'?'speaking_independent.job':'speaking_homework.check_job';
 assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${jobTable}`)).rows[0].n,0);
});

test('modern document profile không có ERP student_ref vẫn dùng identity_ref đã grant',async t=>{
 const c=await collector(t),f=await modern.fixture({journal:c.callback});t.after(()=>f.db.close());
 const identityRef=randomUUID(),accessToken='fixture-document-native-token';
 await f.pool.query("UPDATE speaking_independent.profile SET kind='document',student_ref=NULL,class_id=NULL,class_code=NULL,identity_ref=$1 WHERE identity_ref=$2",[identityRef,modern.ref]);
 await f.pool.query('UPDATE speaking_independent.work_unit SET token_hash=$1 WHERE id=$2',[
  createHash('sha256').update(accessToken).digest('hex'),f.session.workUnitId]);
 await f.service.requestCheck({accessToken,studentRef:identityRef,part:'benefit_harm',rawUrl:modern.url(8)});
 await delivered(f.service,1);const rows=await c.read();assert.equal(rows[0].subjectRef,identityRef);
 assert.equal(rows[0].groupRef,null,'hồ sơ chưa có lớp ERP phải giữ null, không bịa classRef');
 assert.equal((await f.pool.query('SELECT student_ref FROM speaking_independent.profile WHERE identity_ref=$1',[identityRef])).rows[0].student_ref,null);
});

for(const [mode,make,input,table]of [
 ['independent',modern.fixture,f=>({...f.identity,part:'benefit_harm',rawUrl:modern.url(7)}),'speaking_independent.link'],
 ['legacy',legacy.fixture,()=>({accessToken:legacy.accessToken,studentRef:legacy.studentRef,part:'paraphrase',rawUrl:legacy.share('f')}),'speaking_homework.submission_link'],
])test(`${mode}: logger lỗi không ngăn SQL/native response và flag tắt không gửi`,async t=>{
 const f=await make({journal:()=>{throw Error('fixture collector unavailable');}});t.after(()=>f.db.close());
 await f.service.requestCheck(input(f));await delay(10);
 assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,1);
 assert.equal(f.service.journalHealth().unknown,1);
 const off=await make({journal:false});t.after(()=>off.db.close());await off.service.requestCheck(input(off));
 assert.equal(off.service.journalHealth().enabled,false);assert.equal(off.service.journalHealth().committed,0);
});
