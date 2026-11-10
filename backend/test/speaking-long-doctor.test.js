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

test('Doctor recovers an invalid quote with a server-owned assistant excerpt',async()=>{
  const correction='Use **present simple** for a regular habit. 📝';
  const conversation={messages:[
    {role:'user',text:'I am going there every day.'},
    {role:'assistant',text:correction+'\n'+'More feedback. '.repeat(25)},
  ]};
  const exercises=[{id:'habit',title:'Present simple for habits'}];
  let calls=0;
  const result=await analyzeDoctorConversation('practice',conversation,{exercises},'https://example.invalid',async(_url,options)=>{
    calls++;
    const prompt=JSON.parse(options.body).prompt;
    const match={exerciseNumber:1,evidenceMessage:2,reason:'Habit needs present simple.'};
    if(calls===1)match.evidenceQuote='Use present simple for a regular habit. '+('More feedback. '.repeat(20));
    else{
      assert.ok(prompt.includes('[E1001] '+correction));
      match.evidenceRef='E1001';
    }
    return {ok:true,json:async()=>({text:JSON.stringify({confidence:.9,matches:[match]})})};
  });
  assert.equal(calls,2);
  assert.deepEqual(result,[{part:'practice',exerciseId:'habit',evidenceMessage:2,evidenceQuote:correction,reason:'Habit needs present simple.'}]);
});
