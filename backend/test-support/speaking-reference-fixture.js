import assert from 'node:assert/strict';

export function bindFixtureReferences(payload, prompt) {
  const scope=prompt.match(/"id":"@m\d+\.s\d+(\.k[a-f0-9]{16})"/)?.[1];
  assert.ok(scope,'Speaking reference catalog missing from provider prompt');
  return JSON.parse(JSON.stringify(payload,(_key,value)=>
    typeof value==='string'&&/^@m\d+\.s\d+$/.test(value)?value+scope:value));
}
