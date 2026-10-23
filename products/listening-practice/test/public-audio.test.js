import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {AUDIO_MANIFEST_TYPE,publicAudioCatalog} from '../src/public-audio.js';
import {secret,uuid} from '../src/domain.js';

const cf=process.env.TEST_CF_AUDIO==='1';
if(cf)process.env.AUDIO_CLOUDFLARE_ENABLED='true';
// Real service/SQL authorization with a deliberately absent local file: the
// successful manifest path proves that no audio file bytes are served by VPS.
for(const sha of ['0454a5b56ce8e7645a5aaa33cfc01be4b1b4fa81de768d20ec5f70bf17d3cfbb','b0220f6be93db9e2ddc28f3debd48d86f81c6b69c809f12a4c1135bee08afacc'])
test('MP3 '+sha.slice(0,8)+' keeps active owner, post-submit review and teacher class checks',async t=>{
  const f=await fixture();t.after(f.close);
  await f.pool.query(`UPDATE listening_practice.content SET definition=jsonb_set(definition,'{audio,sha256}',to_jsonb($1::text))`,[sha]);
  const review={audioSha256:sha,contentVersion:'fixture-v1'},app=createApp({pool:f.pool,service:f.service,
    mediaCatalog:{[sha]:{audioFile:'/fixture-file-must-not-be-read.mp3',review}},origins:['https://page.test'],
    googleClientId:'fixture',adminKey:secret(),verifyGoogle:async()=>({email:'teacher@example.test',sub:'google-fixture',email_verified:true})});
  const started=await f.begin(),id=started.attempts.at(-1).id;
  const get=(path,token=f.token)=>request(app).get(path).set('Accept',AUDIO_MANIFEST_TYPE).set('Authorization',`Bearer ${token}`);
  const active=await get(`/api/audio/${id}`);assert.equal(active.status,200);
  assert.deepEqual(active.body.audioManifest,cf?{...publicAudioCatalog[sha],cloudflare:{version:1,policy:'public-mp3-v1',chunkSize:524288}}:publicAudioCatalog[sha]);assert.match(active.headers['cache-control'],/no-store/);
  assert.equal((await request(app).get(`/api/audio/${id}`).set('Accept',AUDIO_MANIFEST_TYPE)).status,401);
  assert.equal((await get(`/api/audio/${id}`,secret())).status,401);
  assert.equal((await get(`/api/audio/${uuid()}`)).status,409);
  assert.equal((await get(`/api/review-audio/${id}`)).status,404);
  await f.service.submit({token:f.token,attemptId:id,lease:started.lease,snapshot:f.draft(),operationId:uuid(),method:'manual'});
  const before=await f.service.read({token:f.token});
  assert.equal((await get(`/api/audio/${id}`)).status,409);
  const result=await get(`/api/result/${id}`),submission=result.body.attempt.submissionId;
  assert.equal((await get(`/api/review-audio/${id}`)).body.audioManifest.sha256,sha);
  const teacher=await request(app).post('/api/teacher/login').send({credential:'fixture-google-login'});
  const teacherRead=await get(`/api/teacher/review-audio/${submission}`,teacher.body.token);
  assert.equal(teacherRead.status,200);assert.equal(teacherRead.body.audioManifest.sha256,sha);
  f.setTeacher(false);
  assert.equal((await get(`/api/teacher/review-audio/${submission}`,teacher.body.token)).status,403);
  assert.deepEqual(await f.service.read({token:f.token}),before);
});
