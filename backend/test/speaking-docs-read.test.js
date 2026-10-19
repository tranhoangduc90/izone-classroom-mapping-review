import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectDocsReader, createOpeningDocsGateway, loadDocsReadCredentials } from '../src/speaking-docs-read.js';

const credentials = { clientId: 'client-fixture', clientSecret: 'secret-fixture', refreshToken: 'refresh-fixture' };
const doc = id => ({ documentId: id, revisionId: 'revision-current', tabs: [{ tabProperties: { tabId: 't.0' } }] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const token = () => json({ access_token: 'access-fixture', expires_in: 3600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(options = {}) {
  const calls = [];
  const call = async (url, request) => {
    calls.push({ url, request });
    if (url.includes('oauth2.googleapis.com')) return options.oauth ? options.oauth(calls) : token();
    const id = new URL(url).pathname.split('/').at(-1);
    return options.docs ? options.docs(id, request, calls) : json(doc(id));
  };
  return { calls, reader: createDirectDocsReader({ credentials, call, ...options.reader }), call };
}

test('đọc đúng Docs trực tiếp, chỉ GET Google, token không ra ngoài kết quả', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader.get('canary_document_1'), doc('canary_document_1'));
  assert.equal(f.calls.length, 2);
  const [auth, read] = f.calls;
  assert.equal(auth.request.body.get('grant_type'), 'refresh_token');
  assert.equal(auth.request.body.get('client_id'), credentials.clientId);
  assert.equal(read.url, 'https://docs.googleapis.com/v1/documents/canary_document_1?includeTabsContent=true');
  assert.equal(read.request.method, 'GET');
  assert.equal(read.request.redirect, 'error');
  assert.equal(read.request.headers.authorization, 'Bearer access-fixture');
  assert.equal(read.request.body, undefined);
});

test('hàng n8n chậm 47/86 giây không được gọi khi mở Docs; ghi vẫn đi gateway cũ', async () => {
  for (const queueDelay of [47000, 86000]) {
    let queuedReads = 0, writes = 0;
    const f = fixture();
    const gateway = { get: async () => { queuedReads += 1; throw new Error('QUEUED_' + queueDelay); }, write: async (id, body) => { writes += 1; return { id, body }; } };
    const opening = createOpeningDocsGateway({ gateway, credentialFile: 'private-fixture.json', readCredentials: () => credentials, call: f.call });
    assert.deepEqual(await opening.get('canary_document_1'), doc('canary_document_1'));
    assert.equal(queuedReads, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await opening.write('canary_document_1', { revision: 'same' }), { id: 'canary_document_1', body: { revision: 'same' } });
    assert.equal(writes, 1);
  }
});

test('chưa bật cấu hình giữ gateway cũ, cấu hình hỏng không tự quay về hàng n8n', () => {
  const gateway = { get() {}, write() {} };
  assert.equal(createOpeningDocsGateway({ gateway }), gateway);
  assert.equal(createOpeningDocsGateway({ gateway: null, credentialFile: 'not-used' }), null);
  assert.throws(() => createOpeningDocsGateway({ gateway, credentialFile: 'bad', readCredentials: () => { throw Error('DOCS_READ_CONFIG_INVALID'); } }), /DOCS_READ_CONFIG_INVALID/);
});

test('chỉ gộp lượt đọc cùng Docs đang chờ, đọc lại sau đó lấy nội dung mới', async () => {
  let resolve;
  const f = fixture({ docs: id => new Promise(r => { resolve = () => r(json(doc(id))); }) });
  const first = f.reader.get('canary_document_1');
  const same = f.reader.get('canary_document_1');
  assert.equal(first, same);
  await delay(1); resolve(); await first;
  const next = f.reader.get('canary_document_1');
  await delay(1); resolve(); await next;
  assert.equal(f.calls.filter(c => c.request.method === 'GET').length, 2);
});

test('khác Docs không dùng nhầm dữ liệu, chỉ làm mới token một lần khi đồng thời', async () => {
  const f = fixture({ oauth: async () => { await delay(10); return token(); } });
  const result = await Promise.all(['canary_document_1', 'canary_document_2'].map(id => f.reader.get(id)));
  assert.deepEqual(result.map(d => d.documentId), ['canary_document_1', 'canary_document_2']);
  assert.equal(f.calls.filter(c => c.url.includes('oauth2.googleapis.com')).length, 1);
});

test('token hết hạn được làm mới, nội dung Docs không được cache qua lượt đọc', async () => {
  let now = 0;
  const f = fixture({ reader: { now: () => now } });
  await f.reader.get('canary_document_1'); now = 3540000;
  await f.reader.get('canary_document_1');
  assert.equal(f.calls.filter(c => c.url.includes('oauth2.googleapis.com')).length, 2);
  assert.equal(f.calls.filter(c => c.request.method === 'GET').length, 2);
});

test('401 làm mới token đúng một lần, 401 lặp không lặp vô hạn', async () => {
  for (const recover of [true, false]) {
    let reads = 0;
    const f = fixture({ docs: id => ++reads === 1 || !recover ? json({ error: 'revoked' }, 401) : json(doc(id)) });
    if (recover) assert.equal((await f.reader.get('canary_document_1')).documentId, 'canary_document_1');
    else await assert.rejects(f.reader.get('canary_document_1'), { code: 'DOC_READ_UNAVAILABLE', httpStatus: 503 });
    assert.equal(reads, 2);
    assert.equal(f.calls.filter(c => c.url.includes('oauth2.googleapis.com')).length, 2);
  }
});

for (const [status, code] of [[403, 'DOC_READ_FORBIDDEN'], [404, 'DOC_READ_NOT_FOUND'], [429, 'DOC_READ_UNAVAILABLE'], [500, 'DOC_READ_UNAVAILABLE']]) {
  test(`Google ${status} không cấp nội dung cũ hoặc lộ phản hồi nguồn`, async () => {
    const f = fixture({ docs: () => json({ secret: credentials.clientSecret }, status) });
    await assert.rejects(f.reader.get('canary_document_1'), error => error.code === code && !error.message.includes(credentials.clientSecret));
    assert.equal(f.calls.length, 2);
  });
}

test('Docs sai ID, thiếu revision hoặc tabs đều bị từ chối', async () => {
  for (const value of [{ ...doc('other_document') }, { documentId: 'canary_document_1', tabs: [] }, { documentId: 'canary_document_1', revisionId: 'r' }]) {
    const f = fixture({ docs: () => json(value) });
    await assert.rejects(f.reader.get('canary_document_1'), { code: 'DOC_READ_UNAVAILABLE' });
  }
});

test('mã Docs chứa đường dẫn/URL bị từ chối trước khi gọi Google', async () => {
  const f = fixture();
  for (const id of ['', '../other', 'https://other.test/id', 'id%2Fbad']) await assert.rejects(f.reader.get(id), { code: 'INVALID_DOCUMENT_ID' });
  assert.equal(f.calls.length, 0);
});

test('lỗi OAuth/JSON/mạng không lộ khóa và lượt kế tiếp phục hồi được', async () => {
  for (const response of [() => json({ error: credentials.refreshToken }, 400), () => new Response('invalid json'), () => { throw Error(credentials.clientSecret); }]) {
    let bad = true;
    const f = fixture({ oauth: () => bad ? response() : token() });
    await assert.rejects(f.reader.get('canary_document_1'), error => error.code === 'DOC_READ_UNAVAILABLE' && !error.message.includes(credentials.clientSecret) && !error.message.includes(credentials.refreshToken));
    bad = false;
    assert.equal((await f.reader.get('canary_document_1')).documentId, 'canary_document_1');
  }
});

test('giới hạn số đọc đồng thời/hàng chờ, hoàn tất giải phóng đúng slot', async () => {
  let active = 0, peak = 0;
  const f = fixture({ reader: { concurrency: 2, maxPending: 3 }, docs: async id => {
    active += 1; peak = Math.max(peak, active); await delay(15); active -= 1; return json(doc(id));
  } });
  const work = [1, 2, 3].map(i => f.reader.get('canary_document_' + i));
  await assert.rejects(f.reader.get('canary_document_4'), { code: 'DOC_READ_BUSY' });
  assert.equal((await Promise.all(work)).length, 3); assert.equal(peak, 2);
  assert.equal((await f.reader.get('canary_document_4')).documentId, 'canary_document_4');
});

test('Google bỏ qua hủy vẫn hết hạn, lượt sau có slot và dữ liệu mới', async () => {
  let hang = true;
  const f = fixture({ reader: { timeoutMs: 40, tokenTimeoutMs: 20, concurrency: 1, maxPending: 2 }, docs: id => hang ? new Promise(() => {}) : json(doc(id)) });
  const work = [1, 2].map(i => assert.rejects(f.reader.get('canary_document_' + i), { code: 'DOC_READ_UNAVAILABLE' }));
  await Promise.all([...work, delay(90)]);
  hang = false; assert.equal((await f.reader.get('canary_document_3')).documentId, 'canary_document_3');
});

test('OAuth bỏ qua hủy không làm kẹt việc làm mới token về sau', async () => {
  let hang = true;
  const f = fixture({ reader: { timeoutMs: 60, tokenTimeoutMs: 20 }, oauth: () => hang ? new Promise(() => {}) : token() });
  await Promise.all([assert.rejects(f.reader.get('canary_document_1'), { code: 'DOC_READ_UNAVAILABLE' }), delay(80)]);
  hang = false; assert.equal((await f.reader.get('canary_document_1')).documentId, 'canary_document_1');
});

test('nạp cấu hình riêng, lỗi cấu hình không lộ nội dung file', t => {
  const folder = mkdtempSync(join(tmpdir(), 'speaking-docs-read-')); t.after(() => rmSync(folder, { recursive: true }));
  const file = join(folder, 'credential.json');
  writeFileSync(file, JSON.stringify({ ...credentials, unused: 'discard' }), 'utf8');
  assert.deepEqual(loadDocsReadCredentials(file), credentials);
  writeFileSync(file, '{bad ' + credentials.clientSecret, 'utf8');
  assert.throws(() => loadDocsReadCredentials(file), { message: 'DOCS_READ_CONFIG_INVALID' });
  assert.throws(() => createDirectDocsReader({ credentials: {} }), /DOCS_READ_CONFIG_INVALID/);
  assert.throws(() => createDirectDocsReader({ credentials, concurrency: 0 }), /DOCS_READ_LIMITS_INVALID/);
});
