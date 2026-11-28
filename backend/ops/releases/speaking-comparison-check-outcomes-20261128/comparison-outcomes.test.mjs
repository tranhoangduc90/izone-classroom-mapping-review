import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const defaultBackend = fileURLToPath(new URL('../../../', import.meta.url));
const backend = process.env.SPEAKING_FIXTURE_BACKEND || defaultBackend;
const load = (file) => import(pathToFileURL(resolve(backend, 'src', file)).href);
const { runSpeakingCheckJob } = await load('speaking-check-worker.js');

const messages = [];
const completed = [];
for (const stage of ['guided', 'free']) {
  for (const topic of ['books', 'films', 'music']) {
    const questionText = 'How has interest in ' + topic + ' changed?';
    const questionMessage = messages.push({
      role: 'assistant',
      text: stage + ': ' + questionText,
    });
    const answerMessage = messages.push({
      role: 'user',
      text: 'Interest in ' + topic + ' has grown faster than interest in sports.',
    });
    const proposal = { stage, stageEvidenceMessage: questionMessage, questionMessage, questionText, answerMessage };
    if (stage === 'free') {
      proposal.reflectionMessage = messages.push({ role: 'user', text: 'I compared a related leisure activity.' });
      proposal.feedbackMessage = messages.push({ role: 'assistant', text: 'The comparison explains a useful distinction.' });
    }
    completed.push(proposal);
  }
}

const input = { section: 'comparison_extended', url: 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111' };
const readShare = async () => ({ messages, source: 'fixture' });
const analysis = (rows = completed, confidence = 0.95) => async () => ({ confidence, completed: rows });

for (const mode of ['independent', 'legacy']) {
  const file = 'speaking-comparison-checker.' + mode + '-fixture.js';
  const { checkComparisonSubmission: check } = await load(file);

  test(mode + ': 3+3 still passes and a verified shortfall stays a shortfall', async () => {
    const pass = await check(input, { readShare, analyze: analysis() });
    assert.equal(pass.kind, 'pass');
    assert.deepEqual(pass.stageCounts, { guided: 3, free: 3 });
    const partial = await check(input, { readShare, analyze: analysis(completed.slice(0, -1)) });
    assert.equal(partial.kind, 'blocked');
    assert.deepEqual(partial.stageCounts, { guided: 3, free: 2 });
    assert.equal(partial.errorCode, undefined);
    assert.equal(partial.fingerprint, pass.fingerprint);
  });

  test(mode + ': transient Share, invalid snapshot, low confidence and invalid result remain separate', async () => {
    const cases = [
      [{ readShare: async () => { throw new Error('fixture timeout'); }, analyze: analysis() }, 'SHARE_READ_UNAVAILABLE'],
      [{ readShare: async () => ({ messages: 'invalid' }), analyze: analysis() }, 'SHARE_SNAPSHOT_INVALID'],
      [{ readShare, analyze: analysis(completed, 0.3) }, 'AI_CHECK_OUTCOME_UNCERTAIN'],
      [{ readShare, analyze: async () => ({ confidence: 0.95 }) }, 'AI_CHECK_RESULT_INVALID'],
      [{ readShare, analyze: async () => { throw new Error('AI_HTTP_429'); } }, 'AI_HTTP_429'],
    ];
    for (const [dependencies, errorCode] of cases) {
      const result = await check(input, dependencies);
      assert.equal(result.kind, 'error');
      assert.equal(result.errorCode, errorCode);
      assert.equal(result.count, undefined);
    }
  });

  test(mode + ': wrong quote, wrong role and out-of-order reflection are verification failures', async () => {
    const [first] = completed;
    const last = completed.at(-1);
    const cases = [
      [{ ...first, questionText: 'A question absent from the snapshot' }, ...completed.slice(1)],
      [{ ...first, answerMessage: first.questionMessage + 2 }, ...completed.slice(1)],
      [...completed.slice(0, -1), { ...last, reflectionMessage: last.feedbackMessage }],
    ];
    for (const rows of cases) {
      const result = await check(input, { readShare, analyze: analysis(rows) });
      assert.equal(result.kind, 'error');
      assert.equal(result.errorCode, 'AI_EVIDENCE_INVALID');
      assert.equal(result.count, undefined);
    }
  });

  test(mode + ': worker stores the verification reason and does not complete a failed check', async () => {
    const seen = [];
    const service = {
      async failCheckJob(fields) { seen.push(fields); },
      async completeCheck() { assert.fail('Verification failure cannot complete the check'); },
      async rejectCheckJob() { assert.fail('Verification failure must not reject the student evidence'); },
    };
    const job = { job_id: 'fixture-job', part: input.section, share_url: input.url, min_questions: 6 };
    const outcome = await runSpeakingCheckJob(service, job,
      (request) => check(request, { readShare, analyze: analysis(completed, 0.3) }));
    assert.equal(outcome, 'retry');
    assert.deepEqual(seen, [{ checkJobId: job.job_id, errorCode: 'AI_CHECK_OUTCOME_UNCERTAIN' }]);
  });
}
