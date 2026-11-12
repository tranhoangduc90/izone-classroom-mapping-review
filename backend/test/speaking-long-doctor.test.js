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
    const match={exerciseNumber:1,reason:'Habit needs present simple.'};
    const found=prompt.match(/\[(E[a-f0-9]{16}\.1)\] Use /);
    assert.ok(found);
    if(calls===1)match.evidenceQuote='Use present simple for a regular habit. '+('More feedback. '.repeat(20));
    else{
      assert.ok(prompt.includes('['+found[1]+'] '+correction));
      match.evidenceRef=found[1];
    }
    return {ok:true,json:async()=>({text:JSON.stringify({confidence:.9,matches:[match]})})};
  });
  assert.equal(calls,2);
  assert.deepEqual(result,[{part:'practice',exerciseId:'habit',evidenceMessage:2,evidenceQuote:correction,reason:'Habit needs present simple.'}]);
});

test('Doctor rejects a reference from another snapshot after one correction',async()=>{
  const catalog={exercises:[{id:'habit',title:'Present simple for habits'}]};
  const source=[{role:'user',text:'I am going there every day.'},{role:'assistant',text:'Use present simple.'}];
  let priorRef;
  await analyzeDoctorConversation('practice',{messages:source},catalog,'https://example.invalid',async(_url,options)=>{
    priorRef=JSON.parse(options.body).prompt.match(/\[(E[a-f0-9]{16}\.1)\]/)[1];
    return Response.json({text:'{"confidence":0.9,"matches":[]}'});
  });
  const changed=[{...source[0],text:source[0].text+' '},source[1]];
  let attempts=0;
  await assert.rejects(analyzeDoctorConversation('practice',{messages:changed},catalog,'https://example.invalid',async()=>{
    attempts++;
    return Response.json({text:JSON.stringify({confidence:0.9,matches:[{
      exerciseNumber:1,evidenceRef:priorRef,reason:'Present simple.',
    }]})});
  }),{message:'DOCTOR_AI_EVIDENCE_INVALID'});
  assert.equal(attempts,2);
});
