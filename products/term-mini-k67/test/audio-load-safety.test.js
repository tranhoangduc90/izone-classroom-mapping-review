import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const confirmed={K67_ORDER_NATIVE_URL:'postgres://k67_fixture_admin@127.0.0.1:55468/postgres',K67_ORDER_NATIVE_CONFIRM:'local-synthetic-20261014'};
// Chạy CLI thật với cấu hình bị cấm; phải dừng trước khi tạo DB/server hoặc ghi output.
// Các lượt load native là positive control cho cùng đường khởi động được phép.
function denied(env,output='E:/Codex-Data/k67-audio-slice4-denied-unused'){
  const r=spawnSync(process.execPath,['tools/audio-load-local.mjs','--smoke','--output',output],{cwd:root,windowsHide:true,env:{...process.env,...confirmed,...env},encoding:'utf8',timeout:10000});
  assert.equal(r.status,2);assert.match(r.stderr,/AssertionError/);assert.doesNotMatch(r.stderr,/ECONNREFUSED|ENOTFOUND|timeout exceeded/);
}
test('Load CLI từ chối hostname ngoài loopback trước khi kết nối',()=>denied({K67_ORDER_NATIVE_URL:'postgres://k67_fixture_admin@192.0.2.1:55468/postgres'}));
test('Load CLI cần xác nhận đúng fixture local',()=>denied({K67_ORDER_NATIVE_CONFIRM:'not-confirmed'}));
test('Load CLI không ghi dữ liệu kiểm lên ổ khác E',()=>denied({},'C:/k67-audio-slice4-denied-unused'));
test('Preview dài từ chối thời lượng sai trước khi mở server',()=>{
  for(const seconds of ['0','2101','NaN']){
    const r=spawnSync(process.execPath,['tools/preview-exam-order.mjs',root],{cwd:root,windowsHide:true,env:{...process.env,K67_PREVIEW_AUDIO_SECONDS:seconds},encoding:'utf8',timeout:10000});
    assert.equal(r.status,1);assert.match(r.stderr,/Thời lượng audio giả không hợp lệ/);
  }
});
