import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {pathToFileURL} from 'node:url';
const appPath=process.env.TERM_CACHE_APP;
const {createApp}=await import(appPath?pathToFileURL(appPath).href:'../src/app.js');

// Gọi API thật với nguồn SQL giả, kiểm số lượt đọc và dữ liệu không lẫn lớp/bài.
// Có thể trỏ TERM_CACHE_APP vào bản live đã ghép; không mở kết nối database thật.
const slugs=appPath?['term-test-1-k56','term-test-2-k56','mini-test-k56']:['term-test-1','term-test-2','mini-test-lesson-5'];
for(const slug of slugs)
test(`Roster ${slug}: 100 người, đổi lớp/bài, quyền mới và nguồn lỗi`,async()=>{
  let reads=0,broken=false,opened=true;
  const app=createApp({config:{trustProxyHops:1,allowedOrigins:new Set(),authMode:'legacy',legacyReviewToken:'fixture'},
    pool:{query:async(sql,values)=>{
      reads++;await new Promise(r=>setTimeout(r,150));
      if(broken)throw Error('Nguồn giả lỗi');
      return {rows:opened?[{test_slug:values[1],test_title:'Đề giả',definition_version:1,class_count:1,
        class_id:values[0],class_name:values[0],students:[{ref:values.join(':'),name:'Người giả'}]}]:[]};
    }},logger:{error(){},info(){}}});
  const url=(c='IC9900',s=slug)=>`/api/term-tests/roster?class=${c}&test=${s}`;
  const all=await Promise.all(Array.from({length:100},(_,i)=>request(app).get(url()).set('X-Forwarded-For',`198.18.0.${1+Math.floor(i/30)}`)));
  assert.ok(all.every(r=>r.status===200));assert.equal(reads,1);
  const different=await Promise.all([url('IC9901'),url('IC9900',slugs[(slugs.indexOf(slug)+1)%slugs.length])].map(p=>request(app).get(p)));
  assert.notEqual(different[0].body.students[0].ref,different[1].body.students[0].ref);assert.equal(reads,3);
  opened=false;assert.equal((await request(app).get(url())).status,404);
  opened=true;broken=true;assert.equal((await request(app).get(url())).status,500);
  broken=false;assert.equal((await request(app).get(url())).status,200);assert.equal(reads,6);
});
