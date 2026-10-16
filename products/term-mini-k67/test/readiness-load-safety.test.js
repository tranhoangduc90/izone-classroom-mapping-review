import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const confirmed={K67_ORDER_NATIVE_URL:'postgres://k67_fixture_admin@127.0.0.1:55468/postgres',K67_ORDER_NATIVE_CONFIRM:'local-synthetic-20261014'};
// Chạy CLI thật với đích/giới hạn sai: phải từ chối trước khi tạo DB hay ghi output.
// Các profile tải local là positive control của cùng đường chạy.
function denied(env={},users='3',out='E:/Codex-Data/k67-readiness-denied-unused'){
  const r=spawnSync(process.execPath,['tools/readiness-load-local.mjs','--users',users,'--smoke','--output',out],{cwd:root,windowsHide:true,env:{...process.env,...confirmed,...env},encoding:'utf8',timeout:10000});
  assert.equal(r.status,2);assert.match(r.stderr,/AssertionError/);assert.doesNotMatch(r.stderr,/ECONNREFUSED|ENOTFOUND|timeout exceeded/);
}
test('Readiness load từ chối đích ngoài cluster fixture',()=>denied({K67_ORDER_NATIVE_URL:'postgres://k67_fixture_admin@192.0.2.1:55468/postgres'}));
test('Readiness load cần xác nhận fixture local',()=>denied({K67_ORDER_NATIVE_CONFIRM:'no'}));
test('Readiness load từ chối profile ngoài giới hạn đã chọn',()=>denied({},'999999'));
test('Readiness load chỉ ghi artifact trên ổ E',()=>denied({},'3','C:/k67-readiness-denied-unused'));
