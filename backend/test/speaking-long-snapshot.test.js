import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationSnapshot} from '../src/speaking-conversation-snapshot.js';
import {speakingFingerprint} from '../src/speaking-completion-policy.js';
import {checkSubmission} from '../src/speaking-checker.js';

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

test('the standard Speaking check keeps the full transcript up to the snapshot limit',async t=>{
  const messages=[
    {role:'assistant',text:'Question one?'},
    {role:'user',text:'First answer.'},
    {role:'assistant',text:'First feedback.'},
    {role:'user',text:'First full revision.'},
    {role:'assistant',text:'Question two?'},
    {role:'user',text:'Second answer.'},
    {role:'assistant',text:'Second feedback.'},
    {role:'user',text:'Second full revision.'},
  ];
  const length=messages.reduce((sum,message)=>sum+message.text.length,0);
  messages[6].text+='x'.repeat(160_000-length);
  const completed=[
    {questionMessage:1,answerMessage:2,feedbackMessage:3,repeatMessage:4},
    {questionMessage:5,answerMessage:6,feedbackMessage:7,repeatMessage:8},
  ];
  const provider=t.mock.method(globalThis,'fetch',async (_url,{body})=>{
    const prompt=JSON.parse(body).prompt;
    assert.ok(prompt.includes(messages[6].text));
    assert.ok(prompt.endsWith('[8] HỌC VIÊN: Second full revision.'));
    return Response.json({text:JSON.stringify({confidence:0.99,completed})});
  });
  const input={section:'speaking',url:'https://chatgpt.com/share/00000000-0000-4000-8000-000000000000',minimum:2};
  const deps={readShare:async()=>({messages}),analyzeCompletion:async()=>({completed:false,confidence:1})};
  const accepted=await checkSubmission(input,deps);
  assert.equal(accepted.kind,'pass');
  assert.equal(accepted.count,2);
  assert.deepEqual(accepted.completedTurns,[[1,2,3,4],[5,6,7,8]]);
  assert.equal(accepted.fingerprint,speakingFingerprint(messages));
  assert.equal(provider.mock.callCount(),1);

  messages[6].text+='x';
  const tooLong=await checkSubmission(input,deps);
  assert.equal(tooLong.kind,'error');
  assert.equal(tooLong.errorCode,'SHARE_TOO_LONG');
  assert.equal(provider.mock.callCount(),1);
});
