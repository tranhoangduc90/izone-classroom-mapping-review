import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeConversation, analyzeInsertionStages } from '../src/speaking-checker.js';
import { analyzeHowTo } from '../src/speaking-how-to-checker.js';
import { analyzeStory } from '../src/speaking-story-checker.js';
import { analyzePracticeConversation } from '../src/speaking-practice-worker.js';
import { conversationSnapshot } from '../src/speaking-conversation-snapshot.js';

const tail = 'Câu trả lời cuối.';
const conversation = size => [
  { role: 'assistant', text: 'a'.repeat(size - tail.length) },
  { role: 'user', text: tail },
];

test('Speaking checkers share the snapshot limit and retain the final turn', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  globalThis.fetch = async (_url, { body }) => {
    assert.match(JSON.parse(body).prompt, /Câu trả lời cuối\./u);
    requests += 1;
    const prompt = JSON.parse(body).prompt;
    const completed = prompt.includes('luyện bài bổ trợ') ? false : [];
    return new Response(JSON.stringify({ text: JSON.stringify({ confidence: 0.9, completed, stages: [], matched: false }) }));
  };
  for (const [name, analyze, code] of [
    ['standard', messages => analyzeConversation('speaking', messages), 'SHARE_TOO_LONG'],
    ['insertion', analyzeInsertionStages, 'SHARE_TOO_LONG'],
    ['how-to', analyzeHowTo, 'SHARE_TOO_LONG'],
    ['story', messages => analyzeStory('story_context', messages), 'SHARE_TOO_LONG'],
    ['practice', messages => analyzePracticeConversation(messages, 'Exercise'), 'PRACTICE_SHARE_TOO_LONG'],
  ]) {
    await t.test(name, async () => {
      const before = requests;
      for (const size of [80_001, 160_000]) {
        const messages = conversation(size);
        await analyze(messages);
        assert.equal(conversationSnapshot({ messages }).messages.at(-1).text, tail);
      }
      await assert.rejects(() => analyze(conversation(160_001)), { message: code });
      assert.equal(requests - before, 2);
    });
  }
});
