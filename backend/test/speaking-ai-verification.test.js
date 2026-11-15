import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSubmission} from '../src/speaking-checker.js';
import {analyzePracticeConversation,runPracticeCheckJob} from '../src/speaking-practice-worker.js';
import {analyzeChatbotCompletion} from '../src/speaking-completion-policy.js';
import {bindFixtureReferences} from '../test-support/speaking-reference-fixture.js';

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
  return Response.json({text:JSON.stringify(bindFixtureReferences(responses.shift(),calls.at(-1).prompt))});
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
 const f=await fixture(t,[{confidence:0.95,completed:completed.slice(0,3)}]);
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
 const result=await analyzePracticeConversation(chat,'Luyện đọc',async(_url,options)=>{
  calls++;return Response.json({text:JSON.stringify(bindFixtureReferences(replies.shift(),JSON.parse(options.body).prompt))});
 });
 assert.equal(calls,2);assert.equal(result.completed,false);
});
test('a code from an older snapshot cannot select a same-numbered message in the current snapshot',async t=>{
 const wrong=structuredClone(completed);wrong[0].questionText='@m1.s1.k0000000000000000';
 const f=await fixture(t,[{confidence:0.95,completed:wrong},{confidence:0.95,completed:wrong}]);
 const result=await f.run();
 assert.equal(result.kind,'error');assert.equal(result.errorCode,'AI_EVIDENCE_SOURCE_MISMATCH');
 assert.match(f.calls[1].prompt,/AI_EVIDENCE_SOURCE_MISMATCH/);
});
test('completion output missing confidence is repaired, without inventing a confidence or completion',async()=>{
 const chat=[{role:'assistant',text:'Bạn đã hoàn thành bước 1; tiếp theo còn phần luyện tự do.'}];
 const replies=[{completed:false},{completed:false,confidence:.95}];let calls=0;
 const result=await analyzeChatbotCompletion(chat,'Luyện đọc',async()=>{calls++;return Response.json({text:JSON.stringify(replies.shift())});});
 assert.equal(calls,2);assert.equal(result.completed,false);assert.equal(result.confidence,.95);
});

test('strict supplemental prompts never use unscoped evidence references as JSON examples',async()=>{
  const messages=[
    {role:'assistant',text:'What do you do to stay healthy?'},
    {role:'user',text:'I walk every morning because it gives me more energy.'},
    {role:'assistant',text:'Good. Add a concrete example from your routine.'},
    {role:'user',text:'I walk every morning. For example, I take a long walk before work.'}
  ];
  const result=await analyzePracticeConversation(messages,'Luyện nói',async(_url,options)=>{
    const {prompt}=JSON.parse(options.body);
    assert.doesNotMatch(prompt, /"@m[0-9]+[.]s[0-9]+"/);
    return Response.json({text:JSON.stringify(bindFixtureReferences({
      confidence:0.95,matched:true,completed:true,questionMessage:1,questionText:'@m1.s1',
      answerMessage:2,answerQuote:'@m2.s1',feedbackMessage:3,repeatMessage:4,repeatQuote:'@m4.s1'
    },prompt))});
  });
  assert.equal(result.completed,true);
});

test('an explicit incomplete supplemental result with unusable references is persisted without a retry', async () => {
  const conversation = { source: 'fixture', messages: [
    { role: 'assistant', text: 'What do you do to stay healthy?' },
    { role: 'user', text: 'I walk in the park every morning.' },
    { role: 'assistant', text: 'Add one benefit to your answer.' }
  ] };
  let providerCalls = 0;
  const failCodes = [];
  const completedChecks = [];
  const service = {
    async completePracticeCheck(result) {
      completedChecks.push(result);
      return { status: result.qualityPassed ? 'accepted' : 'rejected' };
    },
    async failPracticeCheckJob(result) { failCodes.push(result.errorCode); }
  };
  const outcome = await runPracticeCheckJob(service, {
    job_id: 'practice-fixture', share_url: url, exercise_id: 'walking', exercise_title: 'Hobbies'
  }, {
    readShare: async () => conversation,
    analyze: (messages, title) => analyzePracticeConversation(messages, title, async () => {
      providerCalls++;
      return Response.json({ text: JSON.stringify({
        confidence: 0.95, matched: true, completed: false,
        questionMessage: 1, questionText: '@m1.s1', answerQuote: 'I walk in the park.', repeatQuote: ''
      }) });
    }),
    analyzeCompletion: async () => ({ completed: false, confidence: 0.95 })
  });
  assert.deepEqual(outcome, { status: 'rejected' });
  assert.equal(providerCalls, 1);
  assert.deepEqual(failCodes, []);
  assert.equal(completedChecks.length, 1);
  assert.equal(completedChecks[0].qualityPassed, false);
  assert.equal(completedChecks[0].questionCount, 0);
  assert.equal(completedChecks[0].matchedExerciseId, 'walking');
  assert.deepEqual(completedChecks[0].evidence.completedTurns, []);
});

test('supplemental verdicts still require valid flags and evidence before accepting', async () => {
  const messages = [
    { role: 'assistant', text: 'What do you do to stay healthy?' },
    { role: 'user', text: 'I walk in the park every morning.' },
    { role: 'assistant', text: 'Add one benefit to your answer.' },
    { role: 'user', text: 'I walk in the park every morning to get more exercise.' }
  ];
  const claimedCompletion = {
    confidence: 0.95, matched: true, completed: true,
    questionMessage: 1, questionText: '@m1.s1', answerMessage: 2, answerQuote: '@m2.s1',
    feedbackMessage: 3, repeatMessage: 4, repeatQuote: '@m4.s1'
  };
  for (const [proposal, code] of [
    [{ ...claimedCompletion, repeatQuote: '' }, 'AI_EVIDENCE_REFERENCE_INVALID'],
    [{ ...claimedCompletion, repeatQuote: undefined }, 'PRACTICE_AI_EVIDENCE_INVALID'],
    [{ ...claimedCompletion, repeatQuote: '@m4.s1.k0000000000000000' }, 'AI_EVIDENCE_SOURCE_MISMATCH'],
    [{ completed: false, matched: 'true', confidence: 0.95 }, 'PRACTICE_AI_UNCERTAIN'],
    [{ completed: 'false', matched: true, confidence: 0.95 }, 'PRACTICE_AI_UNCERTAIN'],
    [{ completed: false, matched: true }, 'PRACTICE_AI_UNCERTAIN']
  ]) {
    await assert.rejects(analyzePracticeConversation(messages, 'Hobbies', async (_url, options) => {
      const { prompt } = JSON.parse(options.body);
      return Response.json({ text: JSON.stringify(bindFixtureReferences(proposal, prompt)) });
    }), { code });
  }
});
