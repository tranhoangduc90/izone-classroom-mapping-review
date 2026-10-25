import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationSnapshot} from '../src/speaking-conversation-snapshot.js';
import {speakingFingerprint} from '../src/speaking-completion-policy.js';

test('a confirmed long conversation keeps its entire snapshot and original fingerprint',()=>{
  const messages=Array.from({length:50},(_,i)=>({role:i%2?'assistant':'user',text:'a'.repeat(1900)}));
  const snapshot=conversationSnapshot({messages});
  assert.deepEqual(snapshot.messages,messages);
  assert.equal(snapshot.fingerprint,speakingFingerprint(messages));
});

test('long snapshots remain bounded and reject malformed text',()=>{
  assert.throws(()=>conversationSnapshot({messages:[{role:'user',text:'a'.repeat(160001)}]}),/DOCTOR_SNAPSHOT_INVALID/);
  assert.throws(()=>conversationSnapshot({messages:[{role:'user',text:'bad\u0000text'}]}),/DOCTOR_SNAPSHOT_INVALID/);
});
