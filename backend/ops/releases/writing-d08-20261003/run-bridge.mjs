// Nhận plan đã pin asset và bridge riêng của producer; không tự tạo/seed bài hoặc đọc credential.
// Mỗi client chỉ dùng UUID của ledger. Receipt con không được coi là outcome production tổng.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {runUiCanary,hash}=createRequire(import.meta.url)('./ui-canary.cjs');
const [planPath,bridgePath,evidenceRoot]=process.argv.slice(2);
assert.ok(planPath&&bridgePath&&evidenceRoot,'Cần plan.json, owned-bridge.mjs và evidence C riêng');
assert.match(path.resolve(evidenceRoot),/^C:[\\/]/i,'Không ghi E hoặc đích khác');
const plan=JSON.parse(await fs.readFile(planPath,'utf8'));
assert.equal(plan.schema,'d08-ui-production-plan/v1');assert.equal(plan.scope,'production_fixture');
const {createBridge}=await import(pathToFileURL(path.resolve(bridgePath)));
for(const entry of plan.entries){
 assert.equal(entry.fixture_seeded,true,'UUID phải được producer seed/readback trước Chrome');
 assert.deepEqual(Object.keys(entry.assets).sort(),['app','config','css','examOrder']);
 assert.deepEqual(Object.keys(entry.public_asset_urls).sort(),['app','config','css','examOrder']);
 for(const [key,file] of Object.entries(entry.assets))assert.equal(hash(await fs.readFile(file)),entry.asset_hashes[key],'Asset local lệch pin');
 // GET tài nguyên công khai chỉ đọc; bắt buộc đúng bytes trước khi nối API thật.
 const publicReadback={status:'passed',assets:{}};
 for(const [key,url] of Object.entries(entry.public_asset_urls)){
  assert.match(url,/^https:\/\/tranhoangduc90\.github\.io\/izone-ai-team-pages\/term-tests\//);
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
  const actualHash=hash(Buffer.from(await response.arrayBuffer()));
  assert.equal(actualHash,entry.asset_hashes[key],'Public asset chưa đúng bản phát hành');
  publicReadback.assets[key]={url,status:response.status,sha256:actualHash,captured_at:new Date().toISOString()};
 }
 const bridge=await createBridge(entry);bridge.publicAssets=publicReadback;
 assert.equal(bridge.binding.destination.container,entry.destination.container);
 assert.equal(bridge.binding.destination.public_api_base,entry.destination.public_api_base);
 await runUiCanary({client:entry.client,assets:entry.assets,identity:entry.identity,bridge,evidenceDir:path.join(evidenceRoot,entry.case_id),scope:'production_fixture'});
}
