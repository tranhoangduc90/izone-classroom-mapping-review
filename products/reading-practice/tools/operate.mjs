import {readFile} from 'node:fs/promises';

// Nhận hành động status/open/close/retry và ID; API chặn mở khi CTA chưa readback, không sửa bài làm.
const [action,id]=process.argv.slice(2),base=process.env.READING_ADMIN_API,key=process.env.READING_ADMIN_KEY;
if(!base||!key||!['status','open','close','retry'].includes(action))throw new Error('Admin configuration and valid operation required');
const path=action==='status'?'/admin/status':action==='retry'?'/admin/retry-docs':'/admin/assignment';
const body=action==='status'?undefined:action==='retry'?{jobId:id}:{assignmentId:id,status:action==='open'?'open':'closed'};
const response=await fetch(base.replace(/\/$/,'')+path,{method:body?'POST':'GET',headers:{'x-reading-admin':key,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
const result=await response.json();if(!response.ok)throw new Error(result.error?.code||'OPERATION_FAILED');
console.log(JSON.stringify(result,null,2));
