import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { overlay, body, hash, classifyLive, repairWriterReadback } from '../ops/grading-fixture.mjs';

const intent = 'bf9c05b3ed514e1a9ed0e37ee2efac12';
const credential = { id: 'fixtureAuth0001', name: 'K67 · Khóa Portal giả để diễn tập' };
const pins = {
  event: ['pY437GnW09WmD9b2', 'a68b16633ffdc59c03f04c544a85c052166c0d062abbc3768817332cae702b9b'],
  poll: ['qj1aGCo406QsXtai', '0bd1925ced423e51ab28d02670e3d26a06d9fc8a9e671c232d6a1f7eba9bcaa7'],
  writer: ['nwp6ERqWKb2FkgFl', '8f35b0db4a264792e513c223c25fa85eef2fb48d6612d84423af0f327aefb6f2']
};
function fixture(role) {
  // Đọc đúng baseline private có hash; không chép credential hoặc webhook vào Git.
  const [id, pin] = pins[role];
  const root = `E:/Codex-Data/n8n-workflow-versions/${id}/k67-fixture-${role}-20261006/incoming`;
  const files = fs.readdirSync(root).filter(x => x.endsWith('.json'));
  assert.equal(files.length, 1);
  const bytes = fs.readFileSync(root + '/' + files[0]);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin);
  return JSON.parse(bytes);
}
const options = role => ({ role, profile: role === 'writer' ? 'izone-ai' : 'default', intent, credential });

test('K67 writer repair: chỉ Code readback đổi, không sửa nguồn hoặc gọi cây chung', () => {
  const before = overlay(fixture('writer'), options('writer'));
  const after = repairWriterReadback(before);
  const nodes = after.nodes.filter((node, i) => hash(node) !== hash(before.nodes[i]));
  assert.equal(nodes.length, 1); assert.equal(nodes[0].name, 'Kiểm tra kết quả ghi');
  const restored = structuredClone(after);
  restored.nodes = before.nodes;
  assert.deepEqual(restored, before);
  assert.deepEqual(before, overlay(fixture('writer'), options('writer')));
  assert.throws(() => repairWriterReadback(after), /WRITER_READBACK_BASELINE_CHANGED/);
  assert.throws(() => repairWriterReadback({ ...before, id: 'NFgOTzvfzfjwqY9x' }), /NOT_OWN/);
  assert.throws(() => repairWriterReadback({ ...before, active: true }), /NOT_OWN/);
});

for (const role of ['event', 'poll']) test(`K67 fixture ${role}: chỉ năm callback đổi, AI/trigger/graph nguyên vẹn`, () => {
  const before = fixture(role), original = hash(before), after = overlay(before, options(role));
  let changed = 0;
  for (let i = 0; i < before.nodes.length; i++) {
    const a = before.nodes[i], b = after.nodes[i];
    if (hash(a) === hash(b)) continue;
    changed++;
    assert.equal(b.type, 'n8n-nodes-base.code');
    const copy = structuredClone(b);
    copy.parameters.jsCode = copy.parameters.jsCode.replace('http://term-mini-k67-gateway-fixture:8876/term-mini-k67-api/',
      'https://ducizone.ddns.net/term-mini-k67-api/');
    assert.deepEqual(copy, a);
  }
  assert.equal(changed, 5);
  const restored = structuredClone(after); restored.nodes = before.nodes;
  assert.deepEqual(restored, before); assert.equal(hash(before), original);
});
test('K67 fixture writer: chỉ năm đích Portal/auth đổi, nội dung điểm và readback giữ nguyên', () => {
  const before = fixture('writer'), after = overlay(before, options('writer'));
  let changed = 0;
  for (let i = 0; i < before.nodes.length; i++) {
    const a = before.nodes[i], b = after.nodes[i];
    if (hash(a) === hash(b)) continue;
    changed++;
    assert.equal(b.type, 'n8n-nodes-base.httpRequest');
    assert.equal(b.parameters.url, a.parameters.url.replace('https://gateway.izone.edu.vn/portal/v1/course-classes/',
      `https://ducizone.ddns.net:18868/k67-portal-fixture/${intent}/`));
    assert.deepEqual(b.credentials, { httpHeaderAuth: credential });
    const restored = structuredClone(b); restored.parameters.url = a.parameters.url;
    restored.parameters.genericAuthType = a.parameters.genericAuthType; restored.credentials = a.credentials;
    assert.deepEqual(restored, a);
  }
  assert.equal(changed, 5);
  assert.deepEqual(after.connections, before.connections); assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(before, fixture('writer'));
});
test('K67 fixture: identity/profile/intent/active hoặc credential sai đều dừng', () => {
  const before = fixture('writer');
  for (const patch of [{ profile: 'default' }, { intent: '../outside' }, { credential: { id: 'real', name: 'Portal' } }])
    assert.throws(() => overlay(before, { ...options('writer'), ...patch }));
  assert.throws(() => overlay({ ...before, active: true }, options('writer')));
  assert.throws(() => overlay({ ...before, id: 'NFgOTzvfzfjwqY9x' }, options('writer')));
});
test('K67 fixture: baseline HTTP/callback thay đổi không được âm thầm ghép', () => {
  const writer = fixture('writer'); writer.nodes.find(n => n.type === 'n8n-nodes-base.httpRequest').parameters.url += '?x=1';
  assert.throws(() => overlay(writer, options('writer')), /PORTAL_BASELINE_CHANGED/);
  const event = fixture('event'); const n = event.nodes.find(n => n.name === 'Nhận việc chấm');
  n.parameters.jsCode += '\n// https://ducizone.ddns.net/term-mini-k67-api/api/term-tests/writing-grading/jobs';
  assert.throws(() => overlay(event, options('event')), /CALLBACK_BASELINE_CHANGED/);
});
test('K67 fixture: mất ACK nhận candidate chính xác; source hoặc version đổi chặn ghi đè', () => {
  const before = fixture('event'), candidate = overlay(before, options('event'));
  assert.equal(classifyLive(before, before, candidate, 'event', 'default'), 'before');
  assert.equal(classifyLive({ ...candidate, versionId: 'server-new-version' }, before, candidate, 'event', 'default'), 'candidate');
  assert.throws(() => classifyLive({ ...before, versionId: 'someone-else-version' }, before, candidate, 'event', 'default'), /LIVE_CHANGED/);
  const changed = structuredClone(candidate); changed.nodes[0].notes = 'Task khác đã chỉnh';
  assert.throws(() => classifyLive(changed, before, candidate, 'event', 'default'), /LIVE_CHANGED/);
});
test('K67 fixture: restore chỉ nhận overlay version đã readback, canonical hash không phụ thuộc key order', () => {
  const before = fixture('writer'), candidate = overlay(before, options('writer'));
  candidate.versionId = 'observed-overlay-version';
  assert.equal(classifyLive(candidate, candidate, before, 'writer', 'izone-ai'), 'before');
  assert.throws(() => classifyLive({ ...candidate, versionId: 'edited-again' }, candidate, before, 'writer', 'izone-ai'), /LIVE_CHANGED/);
  assert.equal(hash(body(before)), hash(Object.fromEntries(Object.entries(body(before)).reverse())));
});
