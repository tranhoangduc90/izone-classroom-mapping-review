import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeDoctorConversation} from '../src/speaking-doctor-worker.js';

test('Doctor accepts the same long snapshot without losing the end of the conversation',async()=>{
  const conversation={messages:[{role:'user',text:'a'.repeat(95000)},{role:'assistant',text:'Feedback at the original end.'}]};
  let prompt;
  const matches=await analyzeDoctorConversation('review_clarify_middle',conversation,{exercises:[]},'https://example.invalid',async(_url,options)=>{
    prompt=JSON.parse(options.body).prompt;
    return {ok:true,json:async()=>({text:JSON.stringify({confidence:.9,matches:[]})})};
  });
  assert.deepEqual(matches,[]);
  assert.ok(prompt.includes('Feedback at the original end.'));
});
