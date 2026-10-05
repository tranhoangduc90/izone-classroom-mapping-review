// Nhận entry đã pin từ producer; mỗi lệnh đi qua journal C/VPS và UUID riêng.
// Không chấm/nộp bài. Mất response giữ unknown, không thử gửi lại.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
export async function createBridge(entry) {
 assert.equal(entry.fixture_seeded,true);
 assert.equal(entry.binding.destination.container,entry.destination.container);
 const rpc=fileURLToPath(new URL('./ui_rpc.py',import.meta.url));
 function call(action,payload) {
  return new Promise((resolve,reject)=>{
   const child=spawn(entry.python||'python',[rpc,'--config',entry.rpc_config,'--case',entry.case_id,action],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   let out='',err='',settled=false;
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.stdout.on('data',value=>out+=value);child.stderr.on('data',value=>err+=value);
   child.on('error',error=>{settled=true;reject(error);});
   child.on('close',code=>{
    if(settled)return;settled=true;
    if(code!==0)return reject(new Error('UI bridge unknown; giữ journal, không gửi lại hoặc cleanup'));
    try{resolve(JSON.parse(out));}catch(error){reject(new Error('UI bridge thiếu response JSON; giữ journal'));}
   });
   // Payload chỉ là hai Task giả; CLI lưu request trước SSH.
   child.stdin.end(action==='post'?JSON.stringify(payload):'');
  });
 }
 return {binding:entry.binding,post:payload=>call('post',payload),read:()=>call('read'),cleanup:()=>call('cleanup')};
}
