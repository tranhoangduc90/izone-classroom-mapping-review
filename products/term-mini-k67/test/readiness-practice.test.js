import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createReadinessFixture} from './helpers/readiness-fixture.js';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {createApp} from '../src/app.js';

// API thật và SQL trên dữ liệu giả: kiểm từng kỹ năng độc lập và không sửa bài thi.
let f,api;
const root='/api/k67-readiness/v1';
before(async()=>{f=await createReadinessFixture();api=request(f.app);});
after(async()=>{await f?.db.close();});
const post=(path,token,data={})=>api.post(root+path).send({token,...data});
async function open(complete=true){
  await f.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()');
  const r=await api.post(root+'/sessions').send({classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111',requestId:randomUUID(),openingProof:randomBytes(32).toString('hex')});
  assert.equal(r.status,201,JSON.stringify(r.body));const token=r.body.token;
  if(complete){
    await post('/device',token,{sameComputer:true,sameHeadphones:true});
    await post('/draft',token,{revision:1,answers:{1:'Listening retained'},heardSeconds:0,cacheState:'unavailable'});
    assert.equal((await post('/submit',token,{revision:1,heardConfirmed:false})).status,200);
  }
  return token;
}
test('Chỉ mở Reading/Writing sau bước kiểm âm thanh; kỹ năng và dữ liệu lạ bị từ chối',async()=>{
  const token=await open(false);
  assert.equal((await post('/practice/reading/draft',token,{revision:1,data:{1:'nine'}})).status,409);
  assert.equal((await post('/practice/listening/draft',token,{revision:1,data:{}})).status,404);
  const done=await open();
  for(const [skill,data]of [['reading',{4:'not allowed'}],['writing',{text:'text',score:9}],['writing',{text:'x'.repeat(12001)}]])
    assert.equal((await post('/practice/'+skill+'/draft',done,{revision:1,data})).status,400);
  assert.equal((await post('/practice/writing/draft','k67r1_'+'x'.repeat(43),{revision:1,data:{text:'unknown'}})).status,401);
});
test('Reading lưu/sửa/nộp/reload; nháp cũ và nộp nhầm revision không mất dữ liệu',async()=>{
  const token=await open(),path='/practice/reading';
  const saved=await post(path+'/draft',token,{revision:2,data:{1:'nine',2:'Wednesday',3:'meeting room'}});
  assert.equal(saved.status,200);assert.equal(saved.body.session.practice.reading.revision,2);
  const stale=await post(path+'/draft',token,{revision:1,data:{1:'old'}});
  assert.equal(stale.body.session.practice.reading.data[1],'nine');
  assert.equal((await post(path+'/draft',token,{revision:2,data:{1:'conflict'}})).status,409);
  assert.equal((await post(path+'/submit',token,{revision:1})).status,409);
  const done=await post(path+'/submit',token,{revision:2});assert.equal(done.status,200);assert.ok(done.body.session.practice.reading.submittedAt);
  const duplicate=await post(path+'/submit',token,{revision:2});assert.equal(duplicate.body.session.practice.reading.submittedAt,done.body.session.practice.reading.submittedAt);
  assert.equal((await post(path+'/draft',token,{revision:3,data:{1:'overwrite'}})).status,409);
  const restored=(await post('/session',token)).body.session;
  assert.deepEqual(restored.answers,{1:'Listening retained'});assert.deepEqual(restored.practice.reading,done.body.session.practice.reading);
  assert.deepEqual(restored.practice.writing,{data:{},revision:0,submittedAt:null});assert.equal(restored.score,undefined);
});
test('Writing giữ Unicode, xuống dòng và ký tự HTML; lưu/nộp độc lập Reading/Listening',async()=>{
  const token=await open(),text='I like the library.\nTôi thích yên tĩnh. <script>not executed</script>';
  await post('/practice/reading/draft',token,{revision:3,data:{2:'Wednesday'}});
  const before=(await post('/session',token)).body.session;
  const saved=await post('/practice/writing/draft',token,{revision:1,data:{text}});assert.equal(saved.status,200);
  const done=await post('/practice/writing/submit',token,{revision:1});assert.equal(done.status,200);
  assert.equal((await post('/practice/writing/draft',token,{revision:2,data:{text:'replace'}})).status,409);
  const row=(await f.db.query('SELECT * FROM assessment.k67_readiness_session WHERE token_hash=$1',[createHash('sha256').update(token).digest('hex')])).rows[0];
  assert.equal(row.writing_draft.text,text);assert.ok(row.writing_submitted_at);assert.equal(row.reading_submitted_at,null);
  assert.deepEqual(done.body.session.practice.reading,before.practice.reading);assert.deepEqual(done.body.session.answers,before.answers);
  assert.equal(done.body.session.submittedAt,before.submittedAt);
});
test('Nháp cùng revision đến đồng thời chỉ nhận một nội dung; nộp đồng thời không đổi kết quả',async()=>{
  const token=await open();
  const drafts=await Promise.all(['first','second'].map(text=>post('/practice/writing/draft',token,{revision:1,data:{text}})));
  assert.deepEqual(drafts.map(r=>r.status).sort(),[200,409]);
  const winner=drafts.find(r=>r.status===200).body.session.practice.writing.data;
  const submits=await Promise.all([1,2].map(()=>post('/practice/writing/submit',token,{revision:1})));
  assert.ok(submits.every(r=>r.status===200));assert.equal(submits[0].body.session.practice.writing.submittedAt,submits[1].body.session.practice.writing.submittedAt);
  const restored=(await post('/session',token)).body.session;
  assert.deepEqual(restored.practice.writing.data,winner);
});
test('Nháp chạy đua nộp: chỉ nộp đúng revision; không sửa được bản đã nộp',async()=>{
  const token=await open();
  await post('/practice/reading/draft',token,{revision:1,data:{1:'initial'}});
  const [draft,submit]=await Promise.all([
    post('/practice/reading/draft',token,{revision:2,data:{1:'newer'}}),post('/practice/reading/submit',token,{revision:1})]);
  const restored=(await post('/session',token)).body.session.practice.reading;
  if(submit.status===200){assert.ok(restored.submittedAt);assert.equal(restored.data[1],'initial');}
  else{assert.equal(submit.status,409);assert.equal(draft.status,200);assert.equal(restored.data[1],'newer');assert.equal(restored.submittedAt,null);}
});
test('Bỏ qua không sinh điểm/bài nộp; hoàn tất cả hai phần không tạo attempt hoặc phiên thi',async()=>{
  const token=await open(),initial=(await post('/session',token)).body.session;
  assert.equal(initial.practice.reading.submittedAt,null);assert.equal(initial.practice.writing.revision,0);
  for(const skill of ['reading','writing']){
    assert.equal((await post('/practice/'+skill+'/draft',token,{revision:1,data:skill==='reading'?{}:{text:''}})).status,200);
    assert.equal((await post('/practice/'+skill+'/submit',token,{revision:1})).status,200);
  }
  for(const table of ['term_test_exam_session','term_test_attempt'])assert.equal(Number((await f.db.query(`SELECT count(*) n FROM assessment.${table}`)).rows[0].n),0);
});
test('Nâng cấp phiên Listening cũ đã nộp: giữ dữ liệu, có thể làm tiếp Reading/Writing',async()=>{
  const old=await createMiniFixture();
  try{
    await old.db.exec(await readFile(new URL('../db/013-readiness.sql',import.meta.url),'utf8'));
    const app=createApp({pool:old.pool,config:f.config});const oldApi=request(app);
    const opened=await oldApi.post(root+'/sessions').send({classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111',requestId:randomUUID(),openingProof:randomBytes(32).toString('hex')});
    // Bản backend hiện tại cần 014 cho publicRow; mô phỏng hàng dữ liệu từ bản trước nâng cấp.
    assert.equal(opened.status,201);const token=opened.body.token;
    await old.db.exec("UPDATE assessment.k67_readiness_session SET same_computer=true,same_headphones=true,answers='{\"1\":\"old listening\"}',draft_revision=4,submitted_at=now()");
    await old.db.exec(await readFile(new URL('../db/014-readiness-reading-writing.sql',import.meta.url),'utf8'));
    const restored=await oldApi.post(root+'/session').send({token});assert.equal(restored.status,200);
    assert.deepEqual(restored.body.session.answers,{1:'old listening'});assert.equal(restored.body.session.revision,4);
    assert.deepEqual(restored.body.session.practice.reading,{data:{},revision:0,submittedAt:null});
    const saved=await oldApi.post(root+'/practice/reading/draft').send({token,revision:1,data:{1:'nine'}});assert.equal(saved.status,200);
  }finally{await old.db.close();}
});
