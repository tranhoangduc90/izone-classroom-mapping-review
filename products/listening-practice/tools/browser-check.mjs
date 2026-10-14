import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Kiểm luồng qua trình duyệt và API thật của Listening; chỉ nguồn identity/Google dùng fixture local.
const [playwrightRoot,contentPath,staticRoot,artifactDir,portArg='4390']=process.argv.slice(2);
if(!artifactDir)throw new Error('Usage: browser-check.mjs playwrightModuleDir privateContent frontendDir artifactDir [port]');
const require=createRequire(path.join(playwrightRoot,'package.json')),{chromium}=require('playwright');
const runDir=path.join(artifactDir,`browser-${Date.now()}`);await mkdir(runDir,{recursive:true});
const server=spawn(process.execPath,[new URL('./preview.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),contentPath,staticRoot,path.join(runDir,'data'),portArg],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='';server.stdout.on('data',x=>stdout+=x);server.stderr.on('data',x=>stderr+=x);
await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Preview did not start: '+stderr)),20000);const timer=setInterval(()=>{if(stdout.includes('listening_local_ready')){clearInterval(timer);clearTimeout(timeout);resolve();}},100);server.once('exit',()=>{clearInterval(timer);clearTimeout(timeout);reject(new Error('Preview exited: '+stderr));});});
// Bộ kiểm nhận đường dẫn module, fixture riêng và nơi lưu bằng chứng; lỗi được trả nguyên trạng.
try{
 const check=spawn(process.execPath,[new URL('./browser-flow.cjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),playwrightRoot,path.join(runDir,'data/open.json'),contentPath,runDir],{stdio:'inherit',windowsHide:true});
 const exitCode=await new Promise(resolve=>check.once('exit',resolve));
 if(exitCode!==0)throw new Error('Listening browser checks failed; see '+runDir);
}finally{server.kill('SIGINT');}
