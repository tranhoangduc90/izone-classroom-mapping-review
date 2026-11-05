import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFrontendReleaseReader} from '../src/learning-frontend-release.js';
test('Release pointer chỉ chuyển khi trọn gói hợp lệ; lỗi/thiếu file giữ bản cũ, hỗ trợ rollback',async()=>{
 let clock=0,version='1111111111111111',broken=false,queries=0;
 const blob=Buffer.from('public fixture'),hash=createHash('sha256').update(blob).digest('hex');
 const read=createFrontendReleaseReader({now:()=>clock,fetcher:async url=>{
  queries++;if(url.includes('release.json'))return new Response(JSON.stringify({version,assets:['index.html','thuy.html','teacher.html','teacher-thuy.html','student.html','journey.html'].map(entry=>({path:'/izone-ai-team-pages/progress-log/releases/'+version+'/progress-log/'+entry,sha256:hash,bytes:blob.length}))}));
  return new Response(broken?'incomplete':blob);
 }});
 const settle=()=>new Promise(r=>setTimeout(r,30));
 assert.equal(read(),null);await settle();assert.equal(read().version,version);assert.equal(queries,7);
 version='2222222222222222';broken=true;clock=60001;read();await settle();assert.equal(read().version,'1111111111111111');
 broken=false;clock+=60001;read();await settle();assert.equal(read().version,version);
 version='0000000000000000';clock+=60001;read();await settle();assert.equal(read().version,version);
});
