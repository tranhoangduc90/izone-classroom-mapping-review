import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTermTestAssetService } from '../src/term-test-assets.js';

function makeResponse() {
  const chunks = [];
  let resolveEnd;
  const ended = new Promise(resolve => { resolveEnd = resolve; });
  return {
    chunks,
    headers: {},
    statusCode: 0,
    status(code) { this.statusCode = code; return this; },
    set(headers) { Object.assign(this.headers, headers); return this; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolveEnd(); },
    ended
  };
}

test('audio phòng chờ được mã hóa riêng theo phiên và chỉ khóa đúng phiên mới giải được', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'izone-term-assets-'));
  const target = path.join(root, 'term-test-2');
  await fs.mkdir(target, { recursive: true });
  const audio = Buffer.from('audio-private-test-data');
  await Promise.all([
    fs.writeFile(path.join(target, 'content.json'), JSON.stringify({ baseTestSlug: 'term-test-2', listening: {}, reading: {}, writing: {} })),
    fs.writeFile(path.join(target, 'listening-audio.mp3'), audio),
    fs.writeFile(path.join(target, 'listening-preview-30s.mp3'), Buffer.from('preview-only'))
  ]);
  const service = createTermTestAssetService({
    assetDir: root,
    sessionSecret: 'test-secret-with-at-least-thirty-two-characters'
  });
  const sessionToken = '00000000-0000-4000-8000-000000000001';
  const response = makeResponse();
  await service.streamEncryptedAudio('term-test-2', sessionToken, response);
  await response.ended;
  const encrypted = Buffer.concat(response.chunks);
  assert.equal(encrypted.subarray(0, 5).toString('ascii'), 'IZTT1');
  assert.notDeepEqual(encrypted.subarray(17, 17 + audio.length), audio);
  assert.equal(response.headers['Cache-Control'], 'no-store, private');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    service.getSessionAudioKey('term-test-2', sessionToken),
    encrypted.subarray(5, 17)
  );
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(17, -16)), decipher.final()]);
  assert.deepEqual(plain, audio);
  assert.notDeepEqual(
    service.getSessionAudioKey('term-test-2', sessionToken),
    service.getSessionAudioKey('term-test-2', '00000000-0000-4000-8000-000000000002')
  );
  assert.deepEqual(await service.getPreview('term-test-2'), Buffer.from('preview-only'));
  assert.equal((await service.getContent('term-test-2')).baseTestSlug, 'term-test-2');
  await fs.rm(root, { recursive: true, force: true });
});
