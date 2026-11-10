import assert from 'node:assert/strict';
import test from 'node:test';
import {checkSubmission} from '../src/speaking-checker.js';
import {withSpeakingProviderJournal} from '../src/speaking-provider-journal.js';

const stages = {
  person_intro: ['identity', 'reason', 'introduction', 'transfer'],
  person_traits: ['attribute_proof', 'attributes', 'setup', 'action', 'resolution', 'recollection', 'transfer'],
  person_ending: ['trait', 'influence', 'bridge', 'ending', 'transfer'],
};
const url = 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111';

function fixture(section) {
  const messages = [];
  const completed = stages[section].map(stage => {
    const question = messages.push({role: 'assistant', text: `Bạn hãy tự luyện bước ${stage}.`});
    const answer = messages.push({role: 'user', text: `Tôi tự thực hành ${stage} về người được chọn.`});
    const feedback = messages.push({role: 'assistant', text: `Góp ý sau khi bạn luyện ${stage}.`});
    return {stage, questionMessage: question, questionText: `@m${question}.s1`,
      answerMessage: answer, answerQuote: `@m${answer}.s1`, feedbackMessage: feedback};
  });
  return {messages, completed};
}

async function run(t, section, responses) {
  const chat = fixture(section);
  const requests = [];
  const events = [];
  t.mock.method(globalThis, 'fetch', async (_endpoint, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const completed = responses(requests.length, chat);
    return Response.json({text: JSON.stringify({confidence: 0.95, completed})});
  });
  const result = await withSpeakingProviderJournal(event => events.push(event), () =>
    checkSubmission({section, minimum: 1, url}, {
      readShare: async () => ({messages: chat.messages, source: 'fixture'}),
      analyzeCompletion: async () => ({completed: false, confidence: 1}),
    }));
  return {result, requests, events};
}

for (const section of Object.keys(stages)) {
  test(`${section}: source references pass the existing complete-practice rules`, async t => {
    const {result, requests} = await run(t, section, (_n, chat) => chat.completed);
    assert.equal(result.kind, 'pass');
    assert.equal(result.acceptanceBasis, 'standard');
    assert.equal(requests.length, 1);
    assert.match(requests[0].prompt, /@m1\.s1/);
  });

  test(`${section}: malformed quotation is corrected once through the normal checker`, async t => {
    const {result, requests, events} = await run(t, section, (n, chat) => {
      if (n === 2) return chat.completed;
      return chat.completed.map(row => ({...row, questionText: 'AI paraphrase absent from the conversation'}));
    });
    assert.equal(result.kind, 'pass');
    assert.equal(requests.length, 2);
    assert.match(requests[1].prompt, /PERSON_EVIDENCE_INVALID/);
    const started = events.filter(event => event.data.phase === 'started');
    assert.deepEqual(started.map(event => event.data.reason), ['initial', 'correction']);
    assert.deepEqual(started.map(event => event.data.attempt), [1, 2]);
    assert.ok(events.every(event => !JSON.stringify(event).includes('AI paraphrase')));
  });

  test(`${section}: a valid partial practice remains incomplete after quotation correction`, async t => {
    const {result, requests} = await run(t, section, (_n, chat) => chat.completed.slice(0, -1));
    assert.equal(result.kind, 'blocked');
    assert.equal(result.count, 0);
    assert.equal(requests.length, 1);
  });
}

test('Tả người: persistent wrong source positions return a diagnostic and stop after one correction', async t => {
  const {result, requests} = await run(t, 'person_ending', (_n, chat) =>
    chat.completed.map(row => ({...row, questionText: '@m2.s1'})));
  assert.equal(result.kind, 'error');
  assert.equal(result.errorCode, 'AI_EVIDENCE_MESSAGE_MISMATCH');
  assert.equal(requests.length, 2);
});

test('Tả người: repeated stage, wrong role, or changed order cannot be accepted through repair', async t => {
  const {result, requests} = await run(t, 'person_traits', (_n, chat) => {
    const completed = structuredClone(chat.completed);
    completed[1] = completed[0];
    return completed;
  });
  assert.equal(result.kind, 'error');
  assert.equal(result.errorCode, 'PERSON_EVIDENCE_INVALID');
  assert.equal(requests.length, 2);
});
