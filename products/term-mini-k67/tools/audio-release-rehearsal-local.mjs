import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import {createNativeOrderFixture} from '../test/helpers/native-exam-order-fixture.js';
import {createApp} from '../src/app.js';
import {createTermTestAssetService} from '../src/term-test-assets.js';

// Nhận thư mục audio giả và output riêng; chỉ dựng/backup/restore DB fixture mới trên loopback.
// Không chạy helper production hoặc đổi cờ live. Lỗi đọc lại làm runner trả khác 0.
const argv=process.argv.slice(2),value=k=>argv[argv.indexOf(k)+1];
assert.ok(argv.includes('--output')&&argv.includes('--assets')&&argv.includes('--pg-bin'));
const out=path.resolve(value('--output')),assetDir=path.resolve(value('--assets')),pgBin=path.resolve(value('--pg-bin'));
assert.match(out,/^E:[\\/]/i);assert.match(assetDir,/^E:[\\/]/i);
assert.equal(process.env.K67_ORDER_NATIVE_URL,'postgres://k67_fixture_admin@127.0.0.1:55468/postgres');
assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM,'local-synthetic-20261014');
await mkdir(out,{recursive:true});
const result={at:new Date().toISOString(),productionChanged:false,checks:[],outcome:'running'};
const check=(id,actual)=>{result.checks.push({id,passed:Boolean(actual)});assert.ok(actual,id);};
const f=await createNativeOrderFixture({examOrder:true}),admin=new pg.Pool({connectionString:process.env.K67_ORDER_NATIVE_URL,max:1});
const restoreDb='term_mini_k67_test_rehearsal_'+randomBytes(6).toString('hex');let restored,created=false;const servers=[];
const assets=createTermTestAssetService({assetDir,sessionSecret:randomBytes(40).toString('hex')});
const config=enabled=>({readFirstNewEnabled:true,audioIncidentEnabled:enabled,audioCacheEnabled:enabled,audioOwnerEnabled:enabled,trustProxyHops:0,allowedOrigins:new Set(),authMode:'legacy',legacyReviewToken:'local-rehearsal-only'});
async function app(pool,enabled){const http=createApp({pool,termTestAssetService:assets,logger:{info(){},warn(){},error(){}},config:config(enabled)}).listen(0,'127.0.0.1');await once(http,'listening');servers.push(http);return`http://127.0.0.1:${http.address().port}`;}
const state=async db=>(await db.query(`SELECT id::text,generation,listening_draft,listening_draft_revision,listening_deadline_at,
 listening_audio_checkpoint_seconds,listening_recovery_seconds,listening_audio_incident_id,audio_owner_id,audio_owner_epoch,
 audio_owner_proof_hash,listening_audio_manifest,listening_audio_protocol_version FROM assessment.term_test_exam_session ORDER BY id`)).rows;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let fields={generation:0,ownerId:randomUUID(),ownerProof:randomBytes(32).toString('hex'),pageId:randomUUID(),ownerEpoch:0};
async function call(base,suffix,data={},expected=200){const r=await fetch(base+'/api/term-tests/mini-test-lesson-5/'+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderClientVersion:1,...fields,...data}),signal:AbortSignal.timeout(10000)});const body=await r.json();assert.equal(r.status,expected,JSON.stringify({suffix,status:r.status,error:body.error}));return body;}
try{
  const first=await app(f.pool,true),identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
  const prepared=await call(first,'session/prepare',{...identity,examMode:'lis_first',examDelivery:'cbt'},201);fields.examSessionToken=prepared.examSessionToken;
  fields.ownerEpoch=(await call(first,'session/audio-owner',{action:'claim'})).ownerEpoch;
  const started=await call(first,'session/start',{audioProtocolVersion:1,audioEventId:randomUUID()});
  await call(first,'listening/draft',{revision:7,answers:{11:'A'}});
  const id=randomUUID();await call(first,'session/audio-incident',{incidentId:id,eventId:id,heardSeconds:0,reason:'manual'});
  const before=await state(f.pool),sourceDb=(await f.db.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(sourceDb,/^term_mini_k67_test_order_[a-f0-9]{12}$/);
  execFileSync(path.join(pgBin,'pg_dump.exe'),['-h','127.0.0.1','-p','55468','-U','k67_fixture_admin','-Fc','-f',path.join(out,'synthetic-fixture.dump'),sourceDb],{windowsHide:true,stdio:'pipe'});
  await admin.query(`CREATE DATABASE ${restoreDb}`);created=true;
  execFileSync(path.join(pgBin,'pg_restore.exe'),['-h','127.0.0.1','-p','55468','-U','k67_fixture_admin','--exit-on-error','-d',restoreDb,path.join(out,'synthetic-fixture.dump')],{windowsHide:true,stdio:'pipe'});
  restored=new pg.Pool({connectionString:`postgres://k67_app@127.0.0.1:55468/${restoreDb}`,max:5});
  const restoredInitial=await state(restored);result.sourceSnapshotHash=digest(before);result.restoredInitialSnapshotHash=digest(restoredInitial);
  check('backup-restore-preserves-draft-deadline-incident-manifest-owner',result.sourceSnapshotHash===result.restoredInitialSnapshotHash);
  // Đổi checkpoint để đi đúng guard chủ phát; đổi draft khi đang hold sẽ bị guard hold chặn trước.
  let denied=false;try{await restored.query("UPDATE assessment.term_test_exam_session SET listening_audio_checkpoint_seconds=999 WHERE id=$1",[fields.examSessionToken]);}catch(error){denied=error.code==='P6703';}
  check('restored-database-still-fences-unowned-write',denied&&digest(before)===digest(await state(restored)));
  const standby=await app(restored,true),active=await call(standby,'session/audio-state');
  check('compatible-standby-preserves-open-hold-and-draft',active.activeIncident?.incidentId===id&&Number((await state(restored))[0].listening_draft_revision)===7);
  const key=(await call(standby,'session/audio-access')).audioKey;check('same-session-audio-key-across-runtime-replacement',key===started.audioKey);
  const request={incidentId:id,resumeAttemptId:randomUUID(),eventId:randomUUID(),phase:'prepare',heardSeconds:0};
  await call(standby,'session/audio-resume',request);await new Promise(r=>setTimeout(r,1200));
  const confirmation={...request,eventId:randomUUID(),phase:'confirm',heardSeconds:.1};const confirmed=await call(standby,'session/audio-resume',confirmation),duplicate=await call(standby,'session/audio-resume',confirmation);
  check('standby-resumes-and-retry-does-not-double-credit',!confirmed.activeIncident&&confirmed.listeningRecoverySeconds>=1&&duplicate.listeningRecoverySeconds===confirmed.listeningRecoverySeconds);
  const disabled=await app(restored,false),status=await call(disabled,'session/audio-owner',{action:'status'});
  check('flag-off-does-not-remove-existing-owner-protocol',status.ownerEnabled===true);
  const access=await call(disabled,'session/audio-access');check('flag-off-loses-cache-handshake-observed',access.audioCacheSupported===false);
  const oldEpoch=fields.ownerEpoch;fields.ownerEpoch=0;await call(disabled,'listening/draft',{revision:8,answers:{11:'B'}},409);fields.ownerEpoch=oldEpoch;
  check('flag-off-still-blocks-stale-owner',Number((await state(restored))[0].listening_draft_revision)===7);
  const submitted=await call(standby,'listening',{...identity,draftRevision:7,clientSubmissionId:randomUUID(),answers:{11:'A'}},201);
  check('compatible-runtime-can-finish-restored-attempt',typeof submitted.attemptToken==='string'&&(await restored.query('SELECT listening_submitted_at FROM assessment.term_test_exam_session WHERE id=$1',[fields.examSessionToken])).rows[0].listening_submitted_at!==null);
  result.outcome='passed';
  result.releaseConclusion='Flag-off is NOT a safe full rollback for active cache sessions; keep compatible runtime/flags and stop expansion until sessions finish. No production action performed.';
}catch(error){result.outcome='failed';result.error={name:error.name,message:error.message};process.exitCode=1;}
finally{
  for(const http of servers){http.closeAllConnections();await new Promise(r=>http.close(r));}
  await restored?.end();if(created){assert.match(restoreDb,/^term_mini_k67_test_rehearsal_[a-f0-9]{12}$/);await admin.query(`DROP DATABASE ${restoreDb}`);}
  await f.db.close();await admin.end();await writeFile(path.join(out,'release-rehearsal.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify(result));
}
