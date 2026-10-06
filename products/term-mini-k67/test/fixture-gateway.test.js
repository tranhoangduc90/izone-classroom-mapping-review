// Kiểm HTTP thật của gateway với người/điểm giả; không kết nối VPS hoặc Portal thật.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureGateway, fixtureIdentity, students } from '../ops/fixture-gateway.mjs';
const portalSecret = 'portal-fixture-'.repeat(4), controlSecret = 'control-fixture-'.repeat(4);
const portal = '/portal/v1/course-classes/1124/student-tests';
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, statePath = null) {
  const target = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, data, headers: req.headers }));
  });
  const backend = await listen(target);
  const server = createFixtureGateway({ backend, portalSecret, controlSecret, statePath });
  const base = await listen(server);
  t.after(async () => { for (const item of [server,target]) await new Promise(resolve => item.close(resolve)); });
  async function request(route, value, key = portalSecret, method = value === undefined ? 'GET' : 'PUT') {
    const response = await fetch(base + route, { method, headers: { 'content-type':'application/json',
      'x-k67-fixture-service':key, 'x-k67-fixture-control':key },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal:AbortSignal.timeout(2000) });
    return { status:response.status, value:await response.json() };
  }
  return { request, base, server };
}
const write = { student_id:students[0], class_test_id:6701, grade:6, record_id:670000 };
test('Gateway chuyển đúng tiền tố/query/body và không chuyển khóa điều khiển', async t => {
  const f = await fixture(t);
  const result = await f.request('/term-mini-k67-api/api/example?a=1', { text:'Bài giả' });
  assert.equal(result.status,200);
  assert.equal(result.value.url,'/api/example?a=1');
  assert.equal(result.value.method,'PUT');
  assert.equal(result.value.data,JSON.stringify({ text:'Bài giả' }));
  assert.equal(result.value.headers['x-k67-fixture-service'],undefined);
  assert.equal(result.value.headers['x-k67-fixture-control'],undefined);
  assert.equal((await f.request('/mapping-api/api/example')).status,404);
});
test('Portal giả khóa đúng nguồn và đích, request sai không đổi dữ liệu', async t => {
  const f = await fixture(t);
  const before = (await f.request('/fixture/state',undefined,controlSecret)).value;
  assert.equal(before.identity,fixtureIdentity);
  assert.equal((await f.request(portal,write,'wrong')).status,401);
  assert.equal((await f.request(portal.replace('1124','1131'),write)).status,404);
  assert.equal((await f.request('/fixture/state')).status,401);
  for (const value of [{...write,student_id:123},{...write,record_id:null},{...write,grade:6.2},
    {...write,grade:10},{...write,extra:true},{...write,class_test_id:1}]) {
    assert.equal((await f.request(portal,value)).status,422);
  }
  assert.deepEqual((await f.request('/fixture/state',undefined,controlSecret)).value,before);
});
test('Portal giả ghi, đọc lại, lặp và từ chối điểm đã có khác giá trị', async t => {
  const f = await fixture(t);
  for (let i=0;i<2;i++) assert.equal((await f.request(portal,write)).status,200);
  assert.equal((await f.request(portal,{...write,grade:9})).status,409);
  const result = (await f.request(portal)).value;
  assert.equal(result.student_test_grades.find(row=>row.student_id===write.student_id && row.class_test_id===6701).grade,6);
  const state = (await f.request('/fixture/state',undefined,controlSecret)).value;
  assert.equal(state.audit.filter(row=>row.method==='PUT').length,2);
});
test('Portal giả mất phản hồi sau ghi vẫn lưu điểm, đọc lại và khởi động lại giữ nguyên', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'k67-gateway-'));
  t.after(()=>fs.rm(dir,{ recursive:true,force:true }));
  const statePath = path.join(dir,'state.json');
  const f = await fixture(t,statePath);
  assert.equal((await f.request('/fixture/control',{fault:'write_then_disconnect'},controlSecret,'POST')).status,200);
  await assert.rejects(()=>f.request(portal,write));
  const saved = JSON.parse(await fs.readFile(statePath,'utf8'));
  assert.equal(saved.student_test_grades[0].grade,6); assert.equal(saved.fault,'none');
  const next = await fixture(t,statePath);
  assert.deepEqual((await next.request('/fixture/state',undefined,controlSecret)).value,saved);
  assert.throws(()=>createFixtureGateway({backend:'http://127.0.0.1:1',portalSecret,controlSecret,statePath,intent:'1'.repeat(32)}),/FIXTURE_STATE_MISMATCH/);
  assert.equal((await next.request(portal,{...write,grade:9})).status,409);
});

test('Portal giả ACK không ghi giữ ô trống và fault chỉ tác động một PUT', async t => {
  const f = await fixture(t);
  const before = (await f.request('/fixture/state', undefined, controlSecret)).value;
  assert.equal((await f.request('/fixture/control', { fault: 'ack_without_write' }, controlSecret, 'POST')).status, 200);
  assert.equal((await f.request(portal, { ...write, grade: 0 })).status, 200);
  const after = (await f.request('/fixture/state', undefined, controlSecret)).value;
  assert.deepEqual(after.student_test_grades, before.student_test_grades);
  assert.equal(after.fault, 'none');
  assert.equal(after.audit.at(-1).fault, 'ack_without_write');
  assert.equal((await f.request(portal, { ...write, grade: 0 })).status, 200);
  assert.equal((await f.request(portal)).value.student_test_grades[0].grade, 0);
});
