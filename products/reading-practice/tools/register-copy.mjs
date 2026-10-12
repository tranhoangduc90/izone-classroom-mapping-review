import {readFile,writeFile} from 'node:fs/promises';
import {secret} from '../src/domain.js';

// Nhận một bản sao Classroom đã xác định UUID/submission/Docs; lưu token trước gửi để retry giữ cùng link.
// API kiểm lại owner từ Google, ghi CTA qua queue và readback; công cụ này không tự mở lớp hay gửi bài.
const file=process.argv[2],base=process.env.READING_ADMIN_API,key=process.env.READING_ADMIN_KEY;
if(!file||!base||!key)throw new Error('Private binding file and admin API configuration required');
const input=JSON.parse(await readFile(file,'utf8'));input.entryToken??=secret();
await writeFile(file,JSON.stringify(input,null,2),'utf8');
const response=await fetch(`${base.replace(/\/$/,'')}/admin/register`,{method:'POST',headers:{'Content-Type':'application/json','x-reading-admin':key},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});
const result=await response.json();if(!response.ok)throw new Error(result.error?.code||'REGISTER_FAILED');
await writeFile(file+'.registered.json',JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify({status:'registered',bindingId:result.bindingId,assignmentId:result.assignmentId,cta:'pending_readback'}));
