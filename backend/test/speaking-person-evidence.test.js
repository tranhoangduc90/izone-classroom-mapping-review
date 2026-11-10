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
  const completed = Object.fromEntries(stages[section].map(stage => {
    const question = messages.push({role: 'assistant', text: `Bạn hãy tự luyện bước ${stage}.`});
    const answer = messages.push({role: 'user', text: `Tôi tự thực hành ${stage} về người được chọn.`});
    const feedback = messages.push({role: 'assistant', text: `Góp ý sau khi bạn luyện ${stage}.`});
    return [stage, [question, answer, feedback]];
  }));
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
  test(`${section}: message positions pass the existing complete-practice rules`, async t => {
    const {result, requests} = await run(t, section, (_n, chat) => chat.completed);
    assert.equal(result.kind, 'pass');
    assert.equal(result.acceptanceBasis, 'standard');
    assert.equal(requests.length, 1);
    assert.match(requests[0].prompt, /\[1\] CHATBOT:/);
  });

  test(`${section}: missing feedback position is corrected once through the normal checker`, async t => {
    const {result, requests, events} = await run(t, section, (n, chat) => {
      if (n === 2) return chat.completed;
      return Object.fromEntries(Object.entries(chat.completed).map(([stage, positions]) => [stage, positions.slice(0, 2)]));
    });
    assert.equal(result.kind, 'pass');
    assert.equal(requests.length, 2);
    assert.match(requests[1].prompt, /PERSON_MESSAGE_POSITIONS_INVALID/);
    const started = events.filter(event => event.data.phase === 'started');
    assert.deepEqual(started.map(event => event.data.reason), ['initial', 'correction']);
    assert.deepEqual(started.map(event => event.data.attempt), [1, 2]);
    assert.ok(events.every(event => !JSON.stringify(event).includes('Bạn hãy tự luyện')));
  });

  test(`${section}: valid partial practice remains incomplete`, async t => {
    const {result, requests} = await run(t, section, (_n, chat) => {
      delete chat.completed.transfer;
      return chat.completed;
    });
    assert.equal(result.kind, 'blocked');
    assert.equal(result.count, 0);
    assert.equal(requests.length, 1);
  });
}

test('Tả người: persistent wrong source positions return a diagnostic and stop after one correction', async t => {
  const {result, requests} = await run(t, 'person_ending', (_n, chat) => ({...chat.completed, trait: [2, 1, 3]}));
  assert.equal(result.kind, 'error');
  assert.equal(result.errorCode, 'PERSON_EVIDENCE_INVALID');
  assert.equal(requests.length, 2);
});

test('Tả người: stage labels cannot override the order in the conversation', async t => {
  const {result, requests} = await run(t, 'person_traits', (_n, chat) => ({...chat.completed,
    attribute_proof: chat.completed.action, action: chat.completed.attribute_proof,
  }));
  assert.equal(result.kind, 'error');
  assert.equal(result.errorCode, 'PERSON_EVIDENCE_INVALID');
  assert.equal(requests.length, 2);
});
