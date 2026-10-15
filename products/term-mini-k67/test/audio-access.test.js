import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,createDecipheriv,randomUUID} from 'node:crypto';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {createTermTestAssetService} from '../src/term-test-assets.js';

// Kiểm API/quyền/SQL/mã hóa thật; byte đề giả. Không mock pin phiên hoặc phép kiểm hash.
let f,api,dir,assets;
const studentRef='11111111-1111-4111-8111-111111111111',slugs=['term-test-1','term-test-2','mini-test-lesson-5'];
const original=Buffer.from('Audio giả cho kiểm thử mã hóa K67, không phải đề thật.');
before(async()=>{
  dir=await mkdtemp(path.join(tmpdir(),'k67-audio-pin-'));
  for(const slug of slugs){await mkdir(path.join(dir,slug));await writeFile(path.join(dir,slug,'listening-audio.mp3'),original);
    await writeFile(path.join(dir,slug,'content.json'),JSON.stringify({baseTestSlug:slug}));}
  assets=createTermTestAssetService({assetDir:dir,sessionSecret:'fixture-only-secret-audio-cache-32-characters'});
  f=await createMiniFixture({examOrder:true,assets,audioProtection:true,audioCache:true});api=request(f.app);
  for(const slug of slugs.slice(0,2))await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,created_at,updated_at,is_active)
    SELECT $1,title,version,listening_definition,reading_definition,created_at,updated_at,is_active
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
});
after(async()=>{await f?.db.close();if(dir)await rm(dir,{recursive:true,force:true});});
const post=(base,suffix,body)=>api.post(base+'/session/'+suffix).send({...body,orderClientVersion:1});
async function prepare(slug='term-test-1',mode='lis_first'){
  await f.db.exec(`UPDATE mapping.k67_context_state SET captured_at=now();UPDATE assessment.term_test_exam_session SET attempt_id=NULL;
    UPDATE assessment.term_test_attempt SET exam_session_id=NULL;DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;`);
  const base='/api/term-tests/'+slug;
  const p=await post(base,'prepare',{classCode:'IC2304',studentRef,examMode:mode,examDelivery:'cbt'});
  assert.ok([200,201].includes(p.status),JSON.stringify(p.body));
  const token={examSessionToken:p.body.examSessionToken,attemptToken:p.body.attemptToken,generation:0};
  if(mode==='read_first'){
    assert.equal((await api.post(base+'/reading/start').send({...token,orderClientVersion:1})).status,200);
    assert.equal((await api.post(base+'/reading').send({...token,orderClientVersion:1,answers:{14:'A'}})).status,200);
  }
  return{base,token};
}
const begin=(base,token)=>post(base,'start',{...token,audioProtocolVersion:1,audioEventId:randomUUID()});
for(const slug of slugs)for(const mode of ['lis_first','read_first'])test(`${slug}/${mode}: metadata không cấp khóa trước start; reauth trả cùng bản ghim/khóa và không đổi mốc hoặc deadline`,async()=>{
  const{base,token}=await prepare(slug,mode);
  const lobby=await post(base,'audio-access',token);assert.equal(lobby.status,200,JSON.stringify(lobby.body));
  assert.equal(lobby.body.audioCacheSupported,true);assert.equal(lobby.body.audioKey,undefined);
  assert.equal(lobby.body.audioManifest.sha256,createHash('sha256').update(original).digest('hex'));
  const started=await begin(base,token);assert.equal(started.status,200,JSON.stringify(started.body));
  assert.deepEqual(started.body.audioManifest,lobby.body.audioManifest);
  const again=await post(base,'audio-access',token);assert.equal(again.status,200);
  assert.equal(again.headers['cache-control'],'no-store, private');assert.equal(again.body.audioKey,started.body.audioKey);
  assert.equal(again.body.listeningDeadlineAt,new Date(started.body.listeningDeadlineAt).toISOString());
  assert.equal(again.body.listeningRecoverySeconds,0);assert.equal(again.body.listeningResumeAtSeconds,0);
  const encrypted=await api.get(base+'/session/'+token.examSessionToken+'/audio').buffer(true).parse((res,cb)=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>cb(null,Buffer.concat(chunks)));
  });
  assert.equal(encrypted.status,200);assert.equal(encrypted.body.length,lobby.body.audioManifest.encryptedByteLength);
  const bytes=encrypted.body,decipher=createDecipheriv('aes-256-gcm',Buffer.from(again.body.audioKey,'base64'),bytes.subarray(5,17));
  decipher.setAuthTag(bytes.subarray(-16));assert.deepEqual(Buffer.concat([decipher.update(bytes.subarray(17,-16)),decipher.final()]),original);
});

test('Không cấp quyền cho sai slug/generation, phiên giấy, hết hạn, thay thế hoặc đã nộp',async()=>{
  let{base,token}=await prepare();
  assert.equal((await api.post(base+'/session/audio-access').send({examSessionToken:token.examSessionToken})).status,400);
  for(const patch of [{generation:7},{examSessionToken:randomUUID()}])assert.equal((await post(base,'audio-access',{...token,...patch})).status,409);
  assert.equal((await post('/api/term-tests/term-test-2','audio-access',token)).status,409);
  for(const sql of ["attempt_mode='answer_sheet'","prepared_at=clock_timestamp()-interval '9 hours'","superseded_at=clock_timestamp()","listening_started_at=clock_timestamp()-interval '1 second',listening_deadline_at=clock_timestamp()+interval '1 hour',listening_submitted_at=clock_timestamp()"]){
    ({base,token}=await prepare());await f.db.query(`UPDATE assessment.term_test_exam_session SET ${sql} WHERE id=$1`,[token.examSessionToken]);
    const denied=await post(base,'audio-access',token);assert.equal(denied.status,409);assert.equal(denied.body.audioKey,undefined);assert.equal(denied.body.audioManifest,undefined);
  }
});
test('Reading chưa nộp không lấy audio; bound Reading trước vẫn reauth được sau 8 giờ',async()=>{
  const{base,token}=await prepare('term-test-1','read_first');
  const prior=(await f.db.query('SELECT reading_answers,reading_result FROM assessment.term_test_attempt WHERE exam_session_id=$1',[token.examSessionToken])).rows[0];
  await f.db.query(`UPDATE assessment.term_test_attempt SET reading_submitted_at=NULL,reading_answers=NULL,reading_result=NULL WHERE exam_session_id=$1`,[token.examSessionToken]);
  assert.equal((await post(base,'audio-access',token)).status,409);
  await f.db.query(`UPDATE assessment.term_test_attempt SET reading_submitted_at=clock_timestamp(),reading_answers=$2,reading_result=$3 WHERE exam_session_id=$1`,[token.examSessionToken,JSON.stringify(prior.reading_answers),JSON.stringify(prior.reading_result)]);
  await f.db.query(`UPDATE assessment.term_test_exam_session SET prepared_at=clock_timestamp()-interval '9 hours' WHERE id=$1`,[token.examSessionToken]);
  assert.equal((await post(base,'audio-access',token)).status,200);
});
test('Thay file không đổi pin phiên; server từ chối gửi file mới cho phiên cũ',async()=>{
  const{base,token}=await prepare();const pinned=await post(base,'audio-access',token);
  const file=path.join(dir,'term-test-1/listening-audio.mp3');
  try{
    await writeFile(file,Buffer.from('Bản khác cùng slug'));
    assert.deepEqual((await post(base,'audio-access',token)).body.audioManifest,pinned.body.audioManifest);
    const denied=await api.get(base+'/session/'+token.examSessionToken+'/audio');assert.equal(denied.status,409);assert.equal(denied.body.error,'AUDIO_ASSET_CHANGED');
    assert.deepEqual((await begin(base,token)).body.audioManifest,pinned.body.audioManifest);
  }finally{await writeFile(file,original);}
});
test('Gửi lại và cạnh tranh pin giữ một manifest; reauth không đóng sự cố hoặc cộng bù',async()=>{
  const{base,token}=await prepare();const first=await Promise.all([post(base,'audio-access',token),post(base,'audio-access',token)]);
  assert.deepEqual(first[0].body.audioManifest,first[1].body.audioManifest);
  await begin(base,token);const id=randomUUID();
  const held=await post(base,'audio-incident',{...token,eventId:id,incidentId:id,heardSeconds:0,reason:'reload'});
  const again=await post(base,'audio-access',token);assert.equal(again.status,200);
  assert.equal(again.body.activeIncident.incidentId,id);assert.equal(again.body.listeningDeadlineAt,held.body.listeningDeadlineAt);assert.equal(again.body.listeningRecoverySeconds,0);
});
for(const mode of ['lis_first','read_first'])test(`${mode}: nộp xong không lấy lại khóa qua start cũ thiếu audioProtocolVersion`,async()=>{
  const{base,token}=await prepare('term-test-1',mode);await begin(base,token);
  const done=await api.post(base+'/listening').send({...token,orderClientVersion:1,classCode:'IC2304',studentRef,clientSubmissionId:randomUUID(),answers:{11:'A'}});
  assert.ok([200,201].includes(done.status),JSON.stringify(done.body));
  assert.equal((await post(base,'audio-access',token)).status,409);
  const legacy=await post(base,'start',token);assert.equal(legacy.status,409,JSON.stringify({status:legacy.status,hasKey:Boolean(legacy.body.audioKey)}));
  assert.equal(legacy.body.audioKey,undefined);
});
