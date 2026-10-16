import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createReadinessFixture} from './helpers/readiness-fixture.js';

// HTTP thật + SQL: báo cáo tự kiểm có scope riêng, không được biến thành quyền thi hoặc mất nháp.
let f,api;const root='/api/k67-readiness/v1';
before(async()=>{f=await createReadinessFixture();api=request(f.app);});after(async()=>{await f?.db.close();});
const post=(path,token,body={})=>api.post(root+path).send({token,...body});
async function open(){await f.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()');const r=await api.post(root+'/sessions').send({classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111',requestId:randomUUID(),openingProof:randomBytes(32).toString('hex')});assert.equal(r.status,201);return r.body.token;}
const report=(code='RESPONDED')=>({version:'web-check-v1',runId:randomUUID(),startedAt:new Date().toISOString(),checks:[{id:'session',state:'pass',code,at:new Date().toISOString()}]});
test('Lưu/đọc lại báo cáo tối thiểu; cùng revision lặp an toàn, bản cũ không ghi đè',async()=>{
  const token=await open(),r=report();
  const saved=await post('/checks',token,{revision:2,report:r});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual(saved.body.session.checkReport,r);assert.ok(saved.body.session.checkUpdatedAt);
  assert.equal((await post('/checks',token,{revision:2,report:r})).status,200);
  assert.equal((await post('/checks',token,{revision:2,report:report('SLOW')})).status,409);
  const stale=await post('/checks',token,{revision:1,report:report('UNREACHABLE')});assert.equal(stale.status,200);assert.deepEqual(stale.body.session.checkReport,r);
  const restored=await post('/session',token);assert.deepEqual(restored.body.session.checkReport,r);
  const db=(await f.db.query('SELECT check_report,check_revision FROM assessment.k67_readiness_session WHERE id=$1',[restored.body.session.id])).rows[0];assert.deepEqual(db.check_report,r);assert.equal(Number(db.check_revision),2);
});
test('Từ chối trường app/extension/thiết bị/raw UA, mã sai, id trùng và thời gian thiếu múi giờ',async()=>{
  const token=await open(),good=report();
  const bad=[{...good,apps:['private']},{...good,userAgent:'raw UA'},
    {...good,checks:[{...good.checks[0],deviceId:'private'}]},
    {...good,checks:[{...good.checks[0],code:'<script>secret</script>'}]},
    {...good,checks:[good.checks[0],good.checks[0]]},{...good,startedAt:'2026-10-16T12:00:00'}];
  for(const r of bad)assert.equal((await post('/checks',token,{revision:1,report:r})).status,400);
  assert.equal((await post('/session',token)).body.session.checkReport,null);
});
test('Báo cáo tự khai không bỏ xác nhận thiết bị/nghe; không ghi đè bài nộp hoặc tạo bài thi',async()=>{
  const token=await open(),r=report();
  await post('/checks',token,{revision:1,report:r});
  assert.equal((await post('/submit',token,{revision:1,heardConfirmed:true})).status,409);
  await post('/device',token,{sameComputer:false,sameHeadphones:false});
  await post('/draft',token,{revision:1,answers:{1:'retained'},heardSeconds:0,cacheState:'unavailable'});
  const done=await post('/submit',token,{revision:1,heardConfirmed:false});assert.equal(done.status,200);
  const saved=await post('/checks',token,{revision:2,report:report('UNREACHABLE')});assert.equal(saved.status,200);
  assert.equal(saved.body.session.submittedAt,done.body.session.submittedAt);assert.equal(saved.body.session.heardConfirmed,false);assert.deepEqual(saved.body.session.answers,{1:'retained'});
  for(const table of ['term_test_exam_session','term_test_attempt'])assert.equal(Number((await f.db.query(`SELECT count(*) n FROM assessment.${table}`)).rows[0].n),0);
});
test('Báo cáo cũng kiểm quyền/expiry mỗi lần và chống hai nội dung cùng revision',async()=>{
  const token=await open();const responses=await Promise.all([report(),report('SLOW')].map(r=>post('/checks',token,{revision:1,report:r})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  await f.db.exec("UPDATE mapping.student_mapping_review SET status='pending' WHERE public_id='11111111-1111-4111-8111-111111111111'");
  assert.equal((await post('/checks',token,{revision:2,report:report()})).status,401);
  await f.db.exec("UPDATE mapping.student_mapping_review SET status='approved' WHERE public_id='11111111-1111-4111-8111-111111111111'");
  await f.db.query('UPDATE assessment.k67_readiness_session SET expires_at=now()-interval \'1 minute\' WHERE id=$1',[(await post('/session',token)).body.session.id]);
  assert.equal((await post('/checks',token,{revision:3,report:report()})).status,401);
});
test('120 phiên chung IP ghi báo cáo và lưu thử, không bị quota chung khóa cả lớp',async()=>{
  const tokens=[];for(let i=0;i<120;i++)tokens.push(await open());
  for(const token of tokens){
    assert.equal((await post('/checks',token,{revision:1,report:report()})).status,200);
    assert.equal((await post('/draft',token,{revision:1,answers:{1:'sample'},heardSeconds:0,cacheState:'unavailable'})).status,200);
  }
});
