import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSubmission} from '../src/speaking-checker.js';
import {analyzePracticeConversation} from '../src/speaking-practice-worker.js';
import {analyzeChatbotCompletion} from '../src/speaking-completion-policy.js';

// Dữ liệu giả tại ranh giới AI thật: bắt dẫn chứng sai, sửa hữu hạn và giữ luật bài.
const url='https://chatgpt.com/share/11111111-1111-4111-8111-111111111111';
const messages=[],completed=[];
for(const stage of ['opening','before','during','after']){
 const q=messages.length+1;
 messages.push({role:'assistant',text:`Practise the ${stage} stage with these expressions.`},
  {role:'user',text:[1,2,3].map(n=>`My ${stage} complete practice sentence ${n}.`).join('\n')},
  {role:'assistant',text:'Here is feedback on your three sentences.'});
 completed.push({stage,questionMessage:q,questionText:`@m${q}.s1`,answers:[1,2,3].map(n=>({message:q+1,quote:`@m${q+1}.s${n}`})),feedbackMessage:q+2});
}
async function fixture(t,responses){
 const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async(_url,options)=>{
  calls.push(JSON.parse(options.body));
  assert.ok(responses.length,'unexpected extra AI request');
  return Response.json({text:JSON.stringify(responses.shift())});
 };
 t.after(()=>{globalThis.fetch=original;});
 const run=()=>checkSubmission({section:'story_sequence',url,minimum:1},{readShare:async()=>({source:'fixture',messages})});
 return {calls,run};
}
test('AI references are resolved to server-owned text and all original stages still pass',async t=>{
 const f=await fixture(t,[{confidence:0.95,completed}]);
 const result=await f.run();
 assert.equal(result.kind,'pass');assert.equal(result.count,1);assert.equal(result.completedTurns.length,4);
 assert.equal(f.calls.length,1);
});
test('a malformed AI quote gets one corrective request before producing a verified verdict',async t=>{
 const wrong=structuredClone(completed);wrong[0].questionText='This paraphrase does not occur in the chat';
 const f=await fixture(t,[{confidence:0.95,completed:wrong},{confidence:0.95,completed}]);
 assert.equal((await f.run()).kind,'pass');assert.equal(f.calls.length,2);
});
test('source references cannot move an answer to a different message or role',async t=>{
 const wrong=structuredClone(completed);wrong[0].answers[0].quote='@m1.s1';
 const f=await fixture(t,[{confidence:0.95,completed:wrong},{confidence:0.95,completed:wrong}]);
 assert.equal((await f.run()).kind,'error');assert.equal(f.calls.length,2);
});
test('valid incomplete work remains incomplete and does not request an AI repair',async t=>{
 const literal=completed.slice(0,3).map(c=>({...c,questionText:messages[c.questionMessage-1].text,answers:c.answers.map((a,i)=>({...a,quote:messages[a.message-1].text.split('\n')[i]}))}));
 const f=await fixture(t,[{confidence:0.95,completed:literal}]);
 assert.equal((await f.run()).kind,'blocked');assert.equal(f.calls.length,1);
});
test('unknown source references remain a technical error after the bounded repair',async t=>{
 const wrong=structuredClone(completed);wrong[0].questionText='@m999.s1';
 const f=await fixture(t,[{confidence:0.95,completed:wrong},{confidence:0.95,completed:wrong}]);
 assert.equal((await f.run()).kind,'error');assert.equal(f.calls.length,2);
});
test('an invalid repeat before feedback can be corrected to incomplete without granting credit',async()=>{
 const chat=[{role:'assistant',text:'Do you like reading?'},{role:'user',text:'I like reading every evening.'},{role:'assistant',text:'Please improve this answer.'}];
 const replies=[{confidence:.95,matched:true,completed:true,questionMessage:1,questionText:'@m1.s1',answerMessage:2,answerQuote:'@m2.s1',feedbackMessage:3,repeatMessage:2,repeatQuote:'@m2.s1'},
   {confidence:.95,matched:true,completed:false}];
 let calls=0;
 const result=await analyzePracticeConversation(chat,'Luyện đọc',async()=>{calls++;return Response.json({text:JSON.stringify(replies.shift())});});
 assert.equal(calls,2);assert.equal(result.completed,false);
});
test('completion output missing confidence is repaired, without inventing a confidence or completion',async()=>{
 const chat=[{role:'assistant',text:'Bạn đã hoàn thành bước 1; tiếp theo còn phần luyện tự do.'}];
 const replies=[{completed:false},{completed:false,confidence:.95}];let calls=0;
 const result=await analyzeChatbotCompletion(chat,'Luyện đọc',async()=>{calls++;return Response.json({text:JSON.stringify(replies.shift())});});
 assert.equal(calls,2);assert.equal(result.completed,false);assert.equal(result.confidence,.95);
});
