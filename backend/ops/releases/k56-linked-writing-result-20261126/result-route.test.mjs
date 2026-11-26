import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { studentWritingGrading } from '../demo-k56-20261020/k56-student-writing-release.mjs';

const modulePath = process.env.K56_LINKED_WRITING_RUNTIME;
if (!modulePath) throw new Error('Set K56_LINKED_WRITING_RUNTIME to the captured or staged runtime module.');
const runningSource = readFileSync(modulePath, 'utf8');
const start = runningSource.indexOf("  router.post('/result', limiter, route(async (req,res,next) => {");
const end = runningSource.indexOf('\n  }));', start);
assert.ok(start >= 0 && end > start, 'Expected the K56 result route in the runtime module');
const registration = runningSource.slice(start, end + '\n  }));'.length);
const supportedSlugs = ['term-test-2-k56', 'term-test-1-k56', 'mini-test-k56'];
const readyAt = '2025-03-02T12:00:00.000Z';
const draft = { attempt_token: 'viewer', exam_session_token: 'viewer-session' };
const accepted = {
  attempt_token: 'official', exam_session_token: 'official-session',
  completed_at: '2025-03-02T11:00:00Z', writing_submitted_at: '2025-03-02T11:30:00Z',
  writing_task_1: 'Synthetic essay.', combined_result: { listening: { correct: 22 }, reading: { correct: 24 } }
};
const grading = { ready: true, status: 'ready', readyAt, writingScore: 6.5, tasks: [{ report: 'Synthetic feedback.' }] };

async function readResult({ slug, official = accepted, owner = draft, now = '2025-03-03T03:00:00Z' }) {
  let handler;
  let response;
  let nextCalled = false;
  let gradingAttempt;
  const dependencies = {
    router: { post(path, _, routeHandler) { assert.equal(path, '/result'); handler = routeHandler; } },
    limiter: null, route: fn => fn, parse: (_, body) => body, tokenSchema: null,
    pool: { query: async (_, [token]) => { assert.equal(token, owner.attempt_token); return { rows: [{
      ...owner, test_slug: slug, term1_parallel_entry: slug === supportedSlugs[1],
      term2_parallel_entry: slug === supportedSlugs[0], mini_cbt_parallel_entry: slug === supportedSlugs[2]
    }] }; } },
    loadSql: 'fixture', slugs: new Set(supportedSlugs), hasPaperAuthority: () => false,
    term1Mode: 'on', term2Mode: 'on', miniCbtMode: 'on',
    findMiniCbtOfficial: () => official, findTerm1Official: () => official, findTerm2Official: () => official,
    load: async (_, testSlug, token) => { assert.equal(testSlug, slug); assert.equal(token, official.attempt_token); return { ...official, test_slug: slug }; },
    serialize: row => ({ attemptToken: row.attempt_token, examSessionToken: row.exam_session_token }),
    resultFor: row => row.combined_result,
    readOnlineWriting: async (_, row) => {
      gradingAttempt = row.attempt_token;
      return { writing: { submitted: true, grading: studentWritingGrading(slug, grading, Date.parse(now)) } };
    },
    readSkillWriting: async () => grading,
    readPortalSyncStatus: async () => 'pending'
  };
  new Function(...Object.keys(dependencies), registration)(...Object.values(dependencies));
  await handler({ body: { attemptToken: owner.attempt_token } }, { json(value) { response = value; } }, () => { nextCalled = true; });
  return { response, nextCalled, gradingAttempt };
}

for (const slug of supportedSlugs) {
  test(`${slug} exposes the released Writing from the official submission when reopened`, async () => {
    const out = await readResult({ slug });
    assert.equal(out.gradingAttempt, accepted.attempt_token);
    assert.equal(out.response.attemptToken, draft.attempt_token);
    assert.equal(out.response.exam.examSessionToken, draft.exam_session_token);
    assert.deepEqual(out.response.result, accepted.combined_result);
    assert.equal(out.response.portalSyncStatus, 'pending');
    assert.deepEqual(out.response.writing?.grading, grading);
  });
}

test('keeps Writing sealed during the existing publication delay on a linked attempt', async () => {
  const { response } = await readResult({ slug: supportedSlugs[0], now: '2025-03-02T13:00:00Z' });
  assert.deepEqual(response.writing?.grading, { status: 'awaiting_release', ready: false, availableAt: '2025-03-02T14:00:00.000Z', tasks: [] });
});

test('a linked in-progress Writing does not load a report', async () => {
  const { response, gradingAttempt } = await readResult({ slug: supportedSlugs[0], official: { ...accepted, writing_submitted_at: null } });
  assert.equal(gradingAttempt, undefined);
  assert.equal(response.writing, null);
});

test('the owner of the official complete attempt keeps the existing result path', async () => {
  const { nextCalled, gradingAttempt } = await readResult({ slug: supportedSlugs[0], owner: accepted });
  assert.equal(nextCalled, true);
  assert.equal(gradingAttempt, undefined);
});

test('an unlinked interrupted Listening attempt keeps its existing Writing read', async () => {
  const owner = { ...draft, listening_interrupted_at: readyAt, writing_started_at: readyAt, writing_submitted_at: readyAt, writing_task_1: 'Synthetic essay.' };
  const { response, gradingAttempt } = await readResult({ slug: supportedSlugs[0], official: null, owner });
  assert.equal(gradingAttempt, undefined);
  assert.equal(response.writing?.submitted, true);
  assert.equal(response.writing?.task1, 'Synthetic essay.');
});
