import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
let f,api;
const studentRef='11111111-1111-4111-8111-111111111111',slugs=['term-test-1','term-test-2','mini-test-lesson-5'];
const assets={supports:s=>slugs.includes(s),getTiming:()=>({listeningDurationSeconds:120,listeningTotalSeconds:240,readingDurationMinutes:20}),getContent:async s=>({baseTestSlug:s}),getSessionAudioKey:()=>Buffer.alloc(32)};
before(async()=>{f=await createMiniFixture({examOrder:true,assets,audioProtection:true,audioCache:true,audioOwner:true});api=request(f.app);
  for(const s of slugs.slice(0,2))await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[s]);});
after(async()=>f?.db.close());
const fresh=()=>({ownerId:randomUUID(),ownerProof:randomBytes(32).toString('hex'),ownerEpoch:0,pageId:randomUUID()});
const post=(base,suffix,data)=>api.post(base+'/'+suffix).send({orderClientVersion:1,...data});
async function prepare(slug='term-test-1',mode='lis_first'){
  await f.db.exec(`UPDATE mapping.k67_context_state SET captured_at=now();UPDATE assessment.term_test_exam_session SET attempt_id=NULL;
    UPDATE assessment.term_test_attempt SET exam_session_id=NULL;DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;`);
  const base='/api/term-tests/'+slug;
  const p=await post(base,'session/prepare',{classCode:'IC2304',studentRef,examMode:mode,examDelivery:'cbt'});assert.ok([200,201].includes(p.status),JSON.stringify(p.body));
  const token={examSessionToken:p.body.examSessionToken,attemptToken:p.body.attemptToken,generation:0};
  if(mode==='read_first'){await post(base,'reading/start',token);assert.equal((await post(base,'reading',{...token,answers:{14:'A'}})).status,200);}
  return{base,token};
}
async function claim(base,token,owner=fresh(),reclaim=false){
  const r=await post(base,'session/audio-owner',{...token,...owner,action:'claim',reclaim});
  if(r.status===200)owner.ownerEpoch=r.body.ownerEpoch;return{r,owner};
}
const start=(base,token,owner)=>post(base,'session/start',{...token,...owner,audioProtocolVersion:1,audioEventId:randomUUID()});
const hold=(base,token,owner)=>{const id=randomUUID();return post(base,'session/audio-incident',{...token,...owner,eventId:id,incidentId:id,heardSeconds:0,reason:'manual'});};
const submit=(base,token,owner)=>post(base,'listening',{...token,...owner,classCode:'IC2304',studentRef,clientSubmissionId:randomUUID(),answers:{11:'A'}});
for(const slug of slugs)for(const mode of ['lis_first','read_first'])test(`${slug}/${mode}: chỉ chủ được start/giữ/nộp; không tự chiếm khi nơi cũ im lặng`,async()=>{
  const{base,token}=await prepare(slug,mode),a=fresh(),b=fresh();
  const claims=await Promise.all([claim(base,token,a),claim(base,token,b)]);
  assert.deepEqual(claims.map(x=>x.r.status).sort(),[200,409]);
  const owner=claims.find(x=>x.r.status===200).owner,other=owner===a?b:a;
  assert.equal((await start(base,token,other)).status,409);assert.equal((await start(base,token,owner)).status,200);
  assert.equal((await post(base,'session/audio-owner',{...token,...other,action:'claim',reclaim:true})).status,409);
  assert.equal((await post(base,'listening/draft',{...token,...other,answers:{11:'B'},revision:2})).status,409);
  assert.equal((await submit(base,token,other)).status,409);assert.equal((await submit(base,token,owner)).status,mode==='read_first'?200:201);
});
test('Reclaim cùng bằng chứng tăng epoch; mọi đường của epoch cũ bị chặn kể cả start bỏ protocol',async()=>{
  const{base,token}=await prepare(),first=await claim(base,token);assert.equal(first.r.status,200);
  await start(base,token,first.owner);const stale={...first.owner};
  const next={...first.owner,pageId:randomUUID()};assert.equal((await claim(base,token,next,true)).r.status,200);assert.ok(next.ownerEpoch>stale.ownerEpoch);
  const attempts=[['session/start',{}],['listening/draft',{answers:{11:'B'},revision:3}],['session/audio-progress',{heardSeconds:0,state:'playing'}],['session/audio-state',{}]];
  for(const [suffix,patch] of attempts){const r=await post(base,suffix,{...token,...stale,...patch});assert.equal(r.status,409,JSON.stringify(r.body));}
  assert.equal((await submit(base,token,stale)).status,409);
  assert.equal((await post(base,'session/audio-state',{...token,...next})).status,200);
});
test('Chuyển cần hold trước release; chủ mới tiếp quản sự cố, chủ cũ không ghi/bù được',async()=>{
  const{base,token}=await prepare(),{owner}=await claim(base,token);await start(base,token,owner);
  const denied=await post(base,'session/audio-owner',{...token,...owner,action:'release'});assert.equal(denied.status,409);
  const held=await hold(base,token,owner);assert.equal(held.status,200,JSON.stringify(held.body));
  assert.equal((await post(base,'session/audio-owner',{...token,...owner,action:'release'})).status,200);
  const next=await claim(base,token);assert.equal(next.r.status,200);
  const snapshot=await post(base,'session/audio-state',{...token,...next.owner});assert.equal(snapshot.body.activeIncident.incidentId,held.body.activeIncident.incidentId);
  assert.equal((await post(base,'session/audio-progress',{...token,...owner,heardSeconds:0,state:'recovered',eventId:randomUUID()})).status,409);
  assert.equal((await submit(base,token,owner)).status,409);
});
test('Thiếu proof/epoch, sai generation và tokenless legacy không vượt trigger',async()=>{
  const{base,token}=await prepare(),{owner}=await claim(base,token);await start(base,token,owner);
  for(const patch of [{ownerProof:''},{ownerEpoch:0},{generation:1}])assert.equal((await submit(base,token,{...owner,...patch})).status,409);
  assert.equal((await api.post(base+'/listening').send({classCode:'IC2304',studentRef,clientSubmissionId:randomUUID(),answers:{11:'A'}})).status,409);
  assert.equal((await f.db.query('SELECT listening_submitted_at FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0].listening_submitted_at,null);
});

for(const mode of ['lis_first','read_first'])test(`${mode}: xác nhận chuyển phòng chờ giữ nguyên phiên, nháp và Reading đã nộp`,async()=>{
  const {base,token}=await prepare('term-test-2',mode),first=await claim(base,token),next=fresh();
  const before=(await f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
  const status=await post(base,'session/audio-owner',{...token,...next,action:'status'});
  assert.equal(status.body.canRecoverPreparation,true);
  const transfer=await post(base,'session/audio-owner',{...token,...next,action:'recover-preparation',expectedOwnerEpoch:first.owner.ownerEpoch});
  assert.equal(transfer.status,200,JSON.stringify(transfer.body));next.ownerEpoch=transfer.body.ownerEpoch;
  const after=(await f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
  for(const field of Object.keys(before).filter(k=>!['audio_owner_id','audio_owner_page_id','audio_owner_proof_hash','audio_owner_epoch'].includes(k)))assert.deepEqual(after[field],before[field],field);
  assert.equal((await start(base,token,first.owner)).status,409);
  assert.equal((await start(base,token,next)).status,200);
  const active=await post(base,'session/audio-owner',{...token,...fresh(),action:'recover-preparation',expectedOwnerEpoch:next.ownerEpoch});
  assert.equal(active.status,409,'cannot take over an active listening exam');
});

test('Hai xác nhận phục hồi cùng epoch chỉ có một chủ thắng; sai generation không ghi',async()=>{
  const {base,token}=await prepare(),first=await claim(base,token);
  const recover=owner=>post(base,'session/audio-owner',{...token,...owner,action:'recover-preparation',expectedOwnerEpoch:first.owner.ownerEpoch});
  const results=await Promise.all([recover(fresh()),recover(fresh())]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await post(base,'session/audio-owner',{...token,...fresh(),generation:1,action:'recover-preparation',expectedOwnerEpoch:first.owner.ownerEpoch+1})).status,409);
});

for(const mode of ['lis_first','read_first'])test(`${mode}: preview does not reserve ownership; simultaneous native Starts have one winner and preserve Reading`,async()=>{
  const {base,token}=await prepare('term-test-2',mode),a=fresh(),b=fresh();
  const beforeAttempt=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE exam_session_id=$1',[token.examSessionToken])).rows;
  // A stale lobby reservation from an older client must not trap the new client.
  const stale=await claim(base,token);assert.equal(stale.r.status,200);
  for(const owner of [a,b]){
    const status=await post(base,'session/audio-owner',{...token,...owner,action:'status'});
    assert.equal(status.status,200);assert.equal(status.body.ownerStartVersion,2);
    assert.equal(status.body.listeningStartedAt,null);
  }
  const begin=owner=>post(base,'session/start',{...token,...owner,ownerStartVersion:2,audioProtocolVersion:1,audioEventId:randomUUID()});
  const results=await Promise.all([begin(a),begin(b)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results.map(r=>r.body)));
  const winner=results[0].status===200?a:b,reply=results.find(r=>r.status===200),loser=winner===a?b:a;
  const saved=(await f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
  assert.equal(saved.audio_owner_id,winner.ownerId);assert.ok(saved.listening_started_at);
  // Retry exactly the request whose ACK was lost, including its old epoch.
  const retry=await begin(winner);assert.equal(retry.status,200,JSON.stringify(retry.body));
  assert.equal(retry.body.listeningDeadlineAt,reply.body.listeningDeadlineAt);
  assert.deepEqual(retry.body.audioOwner,reply.body.audioOwner);
  assert.equal((await begin(loser)).status,409);
  const next={...winner,pageId:randomUUID(),ownerEpoch:reply.body.audioOwner.ownerEpoch,reclaim:true};
  const resumed=await begin(next);assert.equal(resumed.status,200,JSON.stringify(resumed.body));
  assert.equal(resumed.body.listeningDeadlineAt,reply.body.listeningDeadlineAt);
  assert.equal((await begin(winner)).status,409,'old page cannot follow the new epoch');
  const afterAttempt=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE exam_session_id=$1',[token.examSessionToken])).rows;
  assert.deepEqual(afterAttempt,beforeAttempt,'Reading result must survive listening start/reload');
});

test('prestart manifest metadata can be pinned without owner; active draft still requires owner',async()=>{
  const {base,token}=await prepare(),claimed=await claim(base,token),next=fresh();
  await f.db.query('UPDATE assessment.term_test_exam_session SET listening_audio_manifest=$2 WHERE id=$1',[token.examSessionToken,JSON.stringify({fixture:true})]);
  assert.equal((await post(base,'session/start',{...token,...next,ownerStartVersion:2,audioProtocolVersion:1})).status,200);
  await assert.rejects(f.db.query(`UPDATE assessment.term_test_exam_session SET listening_draft='{"11":"B"}' WHERE id=$1`,[token.examSessionToken]),/AUDIO_OWNER_REQUIRED/);
  assert.equal((await start(base,token,claimed.owner)).status,409);
});
