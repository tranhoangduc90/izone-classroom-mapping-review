import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { gzipSync } from 'node:zlib';
import { readSpeakingShare } from '../src/speaking-share-reader.js';

// Dữ liệu giả: một hội thoại có hai lượt; không dùng bài hoặc link học viên thật.
function conversationHtml() {
  const values = [];
  function encode(value) {
    const index = values.length;
    values.push(null);
    if (Array.isArray(value)) values[index] = value.map(encode);
    else if (value && typeof value === 'object') {
      values[index] = Object.fromEntries(Object.entries(value).map(([key, item]) => [`_${encode(key)}`, encode(item)]));
    } else values[index] = value;
    return index;
  }
  encode({ title: 'Fixture conversation', current_node: 'b', mapping: {
    a: { parent: null, message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['Practice answer'] } } },
    b: { parent: 'a', message: { id: 'b', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Feedback'] } } },
  } });
  return `<!DOCTYPE html><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(values))});</script>`;
}

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const realGet = https.get;
  const calls = { direct: 0, fallback: 0 };
  // Chuyển HTTP thật về loopback; giữ parser/header limits của Node để bắt đúng lỗi.
  globalThis.fetch = (url, options) => {
    if (new URL(url).hostname === 'chatgpt.com') { calls.direct++; return realFetch(local, { ...options, redirect: 'manual' }); }
    calls.fallback++;
    return Promise.resolve(calls.fallbackHtml
      ? Response.json({ data: calls.fallbackHtml })
      : new Response('unavailable', { status: 502 }));
  };
  https.get = (_url, options, callback) => { calls.direct++; return http.get(local, options, callback); };
  t.after(async () => { globalThis.fetch = realFetch; https.get = realGet; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return calls;
}

test('reads a real response with 24 KiB headers while the gateway is unavailable', async t => {
  const calls = await fixture(t, (_req, res) => { res.setHeader('x-large-header', 'a'.repeat(24 * 1024)); res.end(conversationHtml()); });
  const result = await readSpeakingShare('https://chatgpt.com/share/fixture-header-overflow');
  assert.equal(result.source, 'direct');
  assert.deepEqual(result.messages.map(m => m.text), ['Practice answer', 'Feedback']);
  assert.equal(calls.fallback, 0);
});

test('recovers a transient page without conversation data with bounded direct attempts', async t => {
  let requests = 0;
  const calls = await fixture(t, (_req, res) => { res.end(++requests === 1 ? '<!DOCTYPE html><title>Please retry</title>' : conversationHtml()); });
  const result = await readSpeakingShare('https://chatgpt.com/share/fixture-incomplete-page');
  assert.equal(result.messages.length, 2);
  assert.equal(calls.direct, 2);
  assert.equal(calls.fallback, 0);
});

test('keeps permanent failure bounded and does not turn it into accepted content', async t => {
  const calls = await fixture(t, (_req, res) => { res.end('<!DOCTYPE html><title>Unavailable</title>'); });
  await assert.rejects(readSpeakingShare('https://chatgpt.com/share/fixture-unavailable'), /Đọc trực tiếp lỗi/);
  assert.equal(calls.direct, 2);
  assert.equal(calls.fallback, 1);
});

test('rejects redirects outside the allowed Share hosts', async t => {
  await fixture(t, (_req, res) => { res.writeHead(302, { location: 'https://example.com/private' }); res.end(); });
  await assert.rejects(readSpeakingShare('https://chatgpt.com/share/fixture-redirect'), /HTTPS|share|Share/);
});

test('uses the gateway when direct HTML remains unavailable, including gateway-only mode', async t => {
  const calls = await fixture(t, (_req, res) => { res.end('<!DOCTYPE html><title>Temporary failure</title>'); });
  calls.fallbackHtml = conversationHtml();
  assert.equal((await readSpeakingShare('https://chatgpt.com/share/fixture-fallback')).source, 'n8n_fallback');
  assert.equal((await readSpeakingShare('https://chatgpt.com/share/fixture-fallback', true)).source, 'n8n_only');
  assert.equal(calls.direct, 2);
  assert.equal(calls.fallback, 2);
});

test('decodes compressed HTML before parsing the conversation', async t => {
  await fixture(t, (_req, res) => { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(conversationHtml())); });
  assert.equal((await readSpeakingShare('https://chatgpt.com/share/fixture-compressed')).messages.length, 2);
});

test('stops HTML exceeding the 12 MiB limit', async t => {
  await fixture(t, (_req, res) => { res.end('<!DOCTYPE html>' + 'a'.repeat(12 * 1024 * 1024)); });
  await assert.rejects(readSpeakingShare('https://chatgpt.com/share/fixture-oversize'), /SHARE_HTML_TOO_LARGE/);
});

test('reads the alternate Octane Share JSON without mixing rendered HTML or templates into messages', async t => {
  const transcript = { rows: [
    { key: 'a', origin: 'source', frame: { id: 'a', role: 'user', text: 'Practice answer' } },
    { key: 'b', origin: 'source', frame: { id: 'b', role: 'assistant', markdownHtml: '<b>Untrusted rendered alternative</b>' }, source: { messageId: 'b', markdown: 'Feedback' } },
  ], templates: { user: { text: 'This template is not a message' } } };
  const html = `<!DOCTYPE html><title>Fixture conversation</title><script id="octane-conversation-transcript" type="application/json">${JSON.stringify(transcript)}</script>`;
  const calls = await fixture(t, (_req, res) => res.end(html));
  const actual = await readSpeakingShare('https://chatgpt.com/share/fixture-octane');
  assert.deepEqual(actual.messages.map(m => [m.id, m.role, m.text]), [['a', 'user', 'Practice answer'], ['b', 'assistant', 'Feedback']]);
  assert.equal(calls.direct, 1);
  assert.equal(calls.fallback, 0);
});

test('rejects incomplete Octane messages instead of dropping a missing assistant reply', async t => {
  const html = '<!DOCTYPE html><script id="octane-conversation-transcript" type="application/json">{"rows":[{"frame":{"role":"assistant"}}]}</script>';
  await fixture(t, (_req, res) => res.end(html));
  await assert.rejects(readSpeakingShare('https://chatgpt.com/share/fixture-octane-incomplete'), /OCTANE_MESSAGE_INVALID/);
});

test('keeps the complete supplied text alternative for an Octane DIL reply without executing UI code', async t => {
  const transcript = { rows: [
    { key: 'a', frame: { id: 'a', role: 'user', text: 'My answer' } },
    { key: 'b', frame: { id: 'b', role: 'assistant' }, source: { markdown: '', dil: {
      code: 'throw new Error("MUST_NOT_EXECUTE")', constants: { 0: 'Do not use UI constants as conversation text' },
      fallbackMarkdown: 'Full feedback. You completed this exercise. Optional extra practice follows.',
    } } },
  ] };
  await fixture(t, (_req, res) => res.end(`<!DOCTYPE html><script id="octane-conversation-transcript" type="application/json">${JSON.stringify(transcript)}</script>`));
  const actual = await readSpeakingShare('https://chatgpt.com/share/fixture-octane-dil');
  assert.equal(actual.messages[1].text, transcript.rows[1].source.dil.fallbackMarkdown);
});
