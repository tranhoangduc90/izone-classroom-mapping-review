import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {createContextGuard} from '../src/context-guard.js';
import {createTermTestAssetService} from '../src/term-test-assets.js';
import {listTermTestRosterSql} from '../src/sql.js';

// Gửi người/lớp giả; đo số lần đọc thật của adapter, kiểm lỗi và độ mới sau mỗi lượt.
// Không có kết nối tới VPS, audio, Portal hoặc dữ liệu học viên thật.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('100 người cùng lớp dùng chung lượt đọc roster, lượt sau đọc lại nguồn', async () => {
  let rosterReads=0, fail=false;
  const app=createApp({config:{trustProxyHops:1,allowedOrigins:new Set(),authMode:'legacy',legacyReviewToken:'fixture'},
    pool:{query:async (sql,values)=>{
      if(sql.includes('SELECT captured_at'))return {rows:[{captured_at:new Date()}]};
      assert.equal(sql,listTermTestRosterSql);rosterReads++;
      await pause(100);
      if(fail)throw new Error('Lỗi nguồn giả');
      return {rows:[{test_slug:values[1],test_title:'Đề giả',definition_version:1,class_count:1,
        class_id:values[0],class_name:values[0],students:[{ref:values[0],name:'Người giả'}]}]};
    }},logger:{error(){},info(){}}});
  const url='/api/term-tests/roster?class=IC9900&test=term-test-1';
  const batch=await Promise.all(Array.from({length:100},(_,i)=>request(app).get(url).set('X-Forwarded-For',`198.18.0.${1+Math.floor(i/30)}`)));
  assert.ok(batch.every(r=>r.status===200));assert.equal(rosterReads,1);
  const next=await request(app).get(url);assert.equal(next.status,200);assert.equal(rosterReads,2);
  const [a,b]=await Promise.all(['IC9900','IC9901'].map(c=>request(app).get(url.replace('IC9900',c))));
  assert.equal(a.body.class.name,'IC9900');assert.equal(b.body.class.name,'IC9901');assert.equal(rosterReads,4);
  fail=true;assert.equal((await request(app).get(url)).status,500);
  fail=false;assert.equal((await request(app).get(url)).status,200);assert.equal(rosterReads,6);
});
test('Gộp kiểm nguồn đang chờ nhưng luôn kiểm tuổi, nguồn lỗi không mở quyền', async () => {
  let reads=0, now=Date.now(), captured=now, broken=false;
  const guard=createContextGuard({now:()=>now,pool:{query:async()=>{
    reads++;await pause(20);if(broken)throw new Error('Nguồn giả lỗi');return {rows:[{captured_at:new Date(captured)}]};
  }}});
  const call=()=>new Promise(resolve=>guard({}, {status(n){this.code=n;return this;},json(){resolve(this.code);}},()=>resolve(200)));
  assert.ok((await Promise.all(Array.from({length:100},call))).every(s=>s===200));assert.equal(reads,1);
  now+=120001;assert.equal(await call(),503);assert.equal(reads,2);
  captured=now;broken=true;assert.equal(await call(),503);
  broken=false;assert.equal(await call(),200);assert.equal(reads,4);
});
test('Đề đọc đầu tiên chỉ đọc tệp một lần; lỗi không bị giữ lại', async t => {
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'k67-login-content-'));
  t.after(()=>fs.promises.rm(dir,{recursive:true,force:true}));
  await fs.promises.mkdir(path.join(dir,'term-test-1'));
  const file=path.join(dir,'term-test-1/content.json');
  const read=fs.promises.readFile.bind(fs.promises);let reads=0;
  t.mock.method(fs.promises,'readFile',async (...args)=>{if(args[0]===file){reads++;await pause(20);}return read(...args);});
  const assets=createTermTestAssetService({assetDir:dir,sessionSecret:'fixture-only-content-secret-with-at-least-32'});
  await assert.rejects(assets.getContent('term-test-1'));
  await fs.promises.writeFile(file,JSON.stringify({baseTestSlug:'term-test-1',reading:{}}));
  const results=await Promise.all(Array.from({length:100},()=>assets.getContent('term-test-1')));
  assert.equal(reads,2);assert.ok(results.every(c=>c===results[0]));
  await assets.getContent('term-test-1');assert.equal(reads,2);
});
