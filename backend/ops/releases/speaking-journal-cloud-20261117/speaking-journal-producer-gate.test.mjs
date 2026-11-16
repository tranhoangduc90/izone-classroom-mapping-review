import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createSpeakingProducerGate } from './speaking-journal-producer-gate.mjs';

const packet = Buffer.from('{"envelope":{"frame":"fixture"},"signature":"opaque"}');
function request(url='/producer/speaking-homework',remoteAddress='127.0.0.1') {
  return Object.assign(Readable.from([packet]),{ method:'POST',url,headers:{},socket:{remoteAddress} });
}
function response() {
  return { writeHead(status){this.status=status;return this;},end(body){this.body=body;} };
}
test('Speaking server switch preserves other routes and signed bytes, and holds retries on missing state',async()=>{
  const dir = await mkdtemp(join(tmpdir(),'spk-agent-mode-'));
  const modeFile = join(dir,'mode');
  const calls = [];
  const measurements = [];
  let now = 5001;
  const gate = createSpeakingProducerGate({modeFile,clock:()=>now,measure:row=>measurements.push(row),
    fetcher:async (url,options)=>{
      calls.push(url);
      assert.deepEqual(options.body,packet);
      return new Response('{"receipt":"fixture"}',{status:200});
    }});
  assert.equal(await gate(request('/producer/other'),response()),false);
  assert.equal(await gate(request('/producer/speaking-homework','203.0.113.7'),response()),false);
  const held = response();
  assert.equal(await gate(request(),held),true);
  assert.equal(held.status,503);
  await writeFile(modeFile,'collector');
  now+=5000;
  assert.equal(await gate(request(),response()),false);
  await writeFile(modeFile,'cloud');
  now+=5000;
  const saved = response();
  assert.equal(await gate(request(),saved),true);
  assert.equal(saved.status,200);
  assert.equal(saved.body.toString(),'{"receipt":"fixture"}');
  assert.equal(calls.length,1);
  assert.equal(measurements[0].requestBytes,packet.length);
});
