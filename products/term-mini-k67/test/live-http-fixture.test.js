// Kiểm server.js và chín asset thật qua HTTP trên người giả; audio giải mã theo luồng.
// Sai đề/hash/khóa hoặc API lỗi làm test thất bại; không ghi điểm hay gọi AI/Portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const base='http://term-mini-k67-gateway-fixture:8876/term-mini-k67-api';
const refs=JSON.parse(process.env.K67_LIVE_FIXTURE_REFS || '{}');
const pins=JSON.parse(process.env.K67_LIVE_ASSET_PINS || '[]');
assert.equal(process.env.K67_LIVE_FIXTURE_CONFIRMATION,'synthetic-live-http-v1');
assert.equal(pins.length,9);
async function request(route,value) {
  const response=await fetch(base+route,{method:value===undefined?'GET':'POST',
    ...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)}),
    signal:AbortSignal.timeout(30000)});
  assert.equal(response.ok,true,`HTTP status ${response.status}`);
  return response;
}
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
test('Server K67 giữ sống có DB/phiên bản riêng và không phục vụ sản phẩm khác',async()=>{
  assert.equal((await (await request('/ready')).json()).ok,true);
  assert.equal((await (await request('/version')).json()).build.version,'synthetic-live-http-v1');
  assert.equal((await fetch(base+'/api/progress-log/lessons')).status,404);
  assert.equal((await fetch(base+'/api/speaking/tasks')).status,404);
});
for(const slug of ['term-test-1','term-test-2','mini-test-lesson-5'])test(`Asset thật ${slug}: đề, nghe thử và audio mã hóa khớp nguồn`,async()=>{
  const rows=pins.filter(row=>row.slug===slug);
  for(const pin of rows) {
    const raw=fs.readFileSync(path.join('/private-assets',pin.path));
    assert.equal(raw.length,pin.bytes); assert.equal(hash(raw),pin.sha256);
  }
  const prepare=await (await request(`/api/term-tests/${slug}/session/prepare`,{classCode:'K67SIM',studentRef:refs[slug]})).json();
  const preview=Buffer.from(await (await request(prepare.previewAudioUrl)).arrayBuffer());
  assert.equal(hash(preview),rows.find(row=>row.path.endsWith('preview-30s.mp3')).sha256);
  const started=await (await request(`/api/term-tests/${slug}/session/start`,{examSessionToken:prepare.examSessionToken})).json();
  assert.deepEqual(started.content,JSON.parse(fs.readFileSync(`/private-assets/${slug}/content.json`,'utf8')));
  assert.deepEqual(started.content.writing?.tasks?.map(task=>task.id)||[],slug==='term-test-1'?['task2']:slug==='term-test-2'?['task1','task2']:[]);
  const audio=await request(prepare.encryptedAudioUrl);
  let header=Buffer.alloc(0),tail=Buffer.alloc(0),decipher=null,total=0;
  const digest=crypto.createHash('sha256');
  for await(const chunk of audio.body) {
    let data=Buffer.from(chunk);
    if(!decipher) {
      header=Buffer.concat([header,data]);
      if(header.length<17)continue;
      assert.equal(header.subarray(0,5).toString('ascii'),'IZTT1');
      decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(started.audioKey,'base64'),header.subarray(5,17));
      data=header.subarray(17);header=null;
    }
    const pending=Buffer.concat([tail,data]);
    if(pending.length<=16){tail=pending;continue;}
    const clear=decipher.update(pending.subarray(0,-16));digest.update(clear);total+=clear.length;
    tail=Buffer.from(pending.subarray(-16));
  }
  assert.ok(decipher);assert.equal(tail.length,16);decipher.setAuthTag(tail);
  const last=decipher.final();digest.update(last);total+=last.length;
  const pin=rows.find(row=>row.path.endsWith('/listening-audio.mp3'));
  assert.equal(total,pin.bytes);assert.equal(digest.digest('hex'),pin.sha256);
});
