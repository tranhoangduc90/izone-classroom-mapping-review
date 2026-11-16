import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSpeakingCloudPolicy } from './speaking-journal-cloud-policy.js';

test('Browser policy defaults to Collector and only adds a cloud append ticket for the same granted scope', async () => {
  const work = await mkdtemp(join(tmpdir(), 'spk-cloud-policy-'));
  const mode = join(work,'mode');
  const key = join(work,'key');
  const env = { SPEAKING_JOURNAL_CLOUD_BROWSER_MODE_FILE:mode, SPEAKING_JOURNAL_CLOUD_APPEND_KEY_FILE:key };
  assert.equal(await createSpeakingCloudPolicy({env:{},allowedOrigins:[]}),null);
  const collectorGrant = { bindingId:'a'.repeat(64), ticket:'collector', ticketId:'original' };
  const owner = { mode:'independent', assignmentRef:'assignment', classRef:null, subjectRef:'identity', unitId:'unit' };
  let now = 100;
  let reply = { bindingId:collectorGrant.bindingId, ticket:'cloud', ticketId:'separate' };
  const calls = [];
  const failures = [];
  await writeFile(key,Buffer.alloc(32,7).toString('base64'));
  await writeFile(mode,'collector');
  const decorate = await createSpeakingCloudPolicy({ env,allowedOrigins:['https://example.invalid'],
    clock:()=>now,onFailure:code=>failures.push(code),load:async()=>({
      createSpeakingHomeworkIntake({ keys,currentKeyId,allowedOrigins }) {
        assert.deepEqual(Object.keys(keys),['spk-cloud-v1']);
        assert.deepEqual(keys[currentKeyId],Buffer.alloc(32,7));
        assert.deepEqual(allowedOrigins,['https://example.invalid']);
        return { context(input){ calls.push(input);return reply; } };
      },
    }) });
  assert.deepEqual(await decorate(owner,collectorGrant),{ ...collectorGrant,archiveLane:'collector' });
  await writeFile(mode,'cloud');
  assert.equal((await decorate(owner,collectorGrant)).archiveLane,'collector');
  now += 5000;
  assert.deepEqual(await decorate(owner,collectorGrant),{ ...collectorGrant,archiveLane:'cloud',cloud:reply });
  assert.deepEqual(calls,[owner]);
  reply = { ...reply,bindingId:'b'.repeat(64) };
  assert.deepEqual(await decorate(owner,collectorGrant),{ ...collectorGrant,archiveLane:'collector' });
  await writeFile(mode,'unrecognised');
  now += 5000;
  assert.deepEqual(await decorate(owner,collectorGrant),{ ...collectorGrant,archiveLane:'collector' });
  assert.deepEqual(failures,['SPEAKING_CLOUD_GRANT_FAILED','SPEAKING_CLOUD_BROWSER_MODE_UNAVAILABLE']);
  await writeFile(key,'invalid');
  assert.equal(await createSpeakingCloudPolicy({ env,allowedOrigins:[] }),null);
});
