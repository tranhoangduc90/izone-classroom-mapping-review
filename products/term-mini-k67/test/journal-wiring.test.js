import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const config = { authMode: 'legacy', trustProxyHops: 0, allowedOrigins: new Set() };
const pool = { query: async () => ({ rows: [], rowCount: 0 }) };

test('K67 registers the journal adapter for Term 1, Term 2 and Mini', async () => {
  let options;
  const app = createApp({ config, pool, journalEnv: { EXAM_JOURNAL_ENABLED: '1' }, mountJournal(server, input) {
    options = input;
    server.post('/api/term-tests/:testSlug/journal-context', (req, res) => {
      res.status(400).json({ error: 'FIXTURE_PROOF_REQUIRED', slug: req.params.testSlug });
    });
  } });

  for (const slug of ['term-test-1', 'term-test-2', 'mini-test-lesson-5']) {
    const response = await request(app).post(`/api/term-tests/${slug}/journal-context`).send({});
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'FIXTURE_PROOF_REQUIRED', slug });
  }
  assert.equal(options.productId, 'term-mini-k67');
  assert.equal(options.schema, 'assessment');
});

test('K67 keeps serving requests when the journal is disabled, missing or throws on mount', async () => {
  const warnings = [];
  const brokenMount = () => { throw new Error('fixture mount failure'); };
  const variants = [
    { journalEnv: {}, mountJournal: brokenMount },
    { journalEnv: { EXAM_JOURNAL_ENABLED: '1' }, mountJournal: null },
    { journalEnv: { EXAM_JOURNAL_ENABLED: '1' }, mountJournal: brokenMount },
  ];
  for (const variant of variants) {
    const app = createApp({ config, pool, logger: { warn: message => warnings.push(message) }, ...variant });
    await request(app).get('/health').expect(200);
    await request(app).post('/api/term-tests/result').send({}).expect(400);
    await request(app).post('/api/term-tests/term-test-2/journal-context').send({}).expect(404);
  }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(value => value.includes('exam_journal') && !value.includes('fixture mount failure')));
});
