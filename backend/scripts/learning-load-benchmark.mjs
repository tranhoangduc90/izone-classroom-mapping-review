import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

// Dữ liệu nhận vào: URL staging và manifest chỉ chứa public token của lớp giả.
// Việc chính: chuẩn bị attempt trước, rồi đo riêng cao điểm open/autosave/submit; retry giữ nguyên identity.
// Kết quả: JSON p50/p95/p99, lỗi, replay và readback tùy chọn; không in token hay nội dung học viên.
// Khi lỗi: chặn mọi phase ghi trên production và fail nếu readback thiếu, trùng hoặc gắn sai identity.

const { Pool } = pg;

export function parseArguments(argv) {
  const options = {
    baseUrl: 'http://127.0.0.1:3000', assignmentsFile: '', phase: 'open', virtualUsers: 1_000,
    durationSeconds: 60, concurrency: 200, checkpointMode: 'open', maxRetries: 2,
    verifyReplay: false, readback: false, confirmWrite: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') options.baseUrl = argv[++index] || '';
    else if (arg === '--assignments-file') options.assignmentsFile = path.resolve(argv[++index] || '');
    else if (arg === '--phase') options.phase = argv[++index] || '';
    else if (arg === '--virtual-users') options.virtualUsers = Number(argv[++index]);
    else if (arg === '--duration-seconds') options.durationSeconds = Number(argv[++index]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (arg === '--checkpoint-mode') options.checkpointMode = argv[++index] || '';
    else if (arg === '--max-retries') options.maxRetries = Number(argv[++index]);
    else if (arg === '--verify-replay') options.verifyReplay = true;
    else if (arg === '--readback') options.readback = true;
    else if (arg === '--confirm-write') options.confirmWrite = argv[++index] || '';
    else throw new Error(`Tham số không hỗ trợ: ${arg}`);
  }
  if (!['open', 'autosave', 'submit'].includes(options.phase)) throw new Error('--phase chỉ nhận open, autosave hoặc submit.');
  if (!['none', 'open', 'required'].includes(options.checkpointMode)) throw new Error('--checkpoint-mode chỉ nhận none, open hoặc required.');
  if (!options.assignmentsFile) throw new Error('Thiếu --assignments-file.');
  if (!Number.isInteger(options.virtualUsers) || options.virtualUsers < 1 || options.virtualUsers > 10_000) {
    throw new Error('--virtual-users phải từ 1 đến 10000.');
  }
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 3_600) {
    throw new Error('--duration-seconds phải từ 1 đến 3600.');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 1_000) {
    throw new Error('--concurrency phải từ 1 đến 1000.');
  }
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 5) {
    throw new Error('--max-retries phải từ 0 đến 5.');
  }
  const target = new URL(options.baseUrl);
  options.baseUrl = target.origin + target.pathname.replace(/\/$/u, '');
  if (options.phase !== 'open') {
    if (target.hostname === 'ducizone.ddns.net') throw new Error('Script cố ý chặn phase ghi trên host production. Hãy dùng staging riêng.');
    if (options.confirmWrite !== target.origin) throw new Error(`Phase ${options.phase} cần --confirm-write ${target.origin}.`);
  }
  if (options.readback && options.phase !== 'submit') throw new Error('--readback chỉ dùng với phase submit.');
  return options;
}

export function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1)];
}

function errorKey(error) { return String(error?.code || error?.status || 'REQUEST_FAILED').slice(0, 100); }
function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function requestJson(url, options) {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    const error = new Error('Không kết nối được API staging.', { cause });
    error.code = 'NETWORK_ERROR';
    error.durationMs = performance.now() - startedAt;
    throw error;
  }
  const payload = await response.json().catch(() => null);
  const durationMs = performance.now() - startedAt;
  if (!response.ok || !payload?.ok) {
    const error = new Error('Request không thành công.');
    error.code = payload?.error || `HTTP_${response.status}`;
    error.status = response.status;
    error.durationMs = durationMs;
    throw error;
  }
  return { payload, durationMs };
}

async function requestWithRetry(url, request, maxRetries) {
  let retryCount = 0;
  while (true) {
    try {
      const result = await requestJson(url, request);
      return { ...result, retryCount };
    } catch (error) {
      const retryable = !error.status || error.status === 429 || error.status >= 500;
      if (!retryable || retryCount >= maxRetries) throw error;
      retryCount += 1;
      await wait(100 * (2 ** (retryCount - 1)) + Math.floor(Math.random() * 250));
    }
  }
}

export function responseMap(definition) {
  const groupIndex = new Map();
  return Object.fromEntries(definition.blocks.flatMap(block => block.items).map(item => {
    if (['short_text', 'long_text'].includes(item.interactionType)) {
      return [item.itemVersionId, 'Dữ liệu giả dùng riêng cho kiểm thử tải staging.'];
    }
    if (item.interactionType === 'number_score') {
      const total = Number(item.interactionConfig?.max);
      return [item.itemVersionId, { correct: Math.max(0, total - 1), total }];
    }
    const groupKey = item.groupId || item.itemVersionId;
    const currentIndex = groupIndex.get(groupKey) || 0;
    groupIndex.set(groupKey, currentIndex + 1);
    const option = item.options[currentIndex % item.options.length] || item.options[0];
    return [item.itemVersionId, option.id];
  }));
}

async function openAssignment(baseUrl, publicToken) {
  return requestJson(`${baseUrl}/api/learning/assignments/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicToken })
  });
}

async function runBounded(tasks, concurrency, runTask) {
  const results = new Array(tasks.length);
  const errors = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await runTask(tasks[index], index); }
      catch (error) { errors.set(errorKey(error), (errors.get(errorKey(error)) || 0) + 1); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return { results, errors: Object.fromEntries(errors) };
}

async function runScheduled(tasks, durationMs, concurrency, runTask) {
  const startedAt = performance.now();
  return runBounded(tasks, concurrency, async (task, index) => {
    const targetAt = startedAt + (durationMs * index / Math.max(1, tasks.length - 1));
    const waitMs = targetAt - performance.now();
    if (waitMs > 0) await wait(waitMs);
    return runTask(task, index);
  });
}

function summarize(phase, targetCount, run, metric = phase) {
  const values = run.results.filter(Boolean).map(item => item[`${metric}Ms`]).filter(Number.isFinite);
  return {
    phase, targetCount, successCount: run.results.filter(Boolean).length,
    errorCount: Object.values(run.errors).reduce((sum, value) => sum + value, 0), errors: run.errors,
    retryCount: run.results.filter(Boolean).reduce((sum, item) => sum + Number(item[`${metric}Retries`] || 0), 0),
    latencyMs: values.length ? {
      [metric]: {
        count: values.length, p50: Math.round(percentile(values, 0.5)), p95: Math.round(percentile(values, 0.95)),
        p99: Math.round(percentile(values, 0.99)), max: Math.round(Math.max(...values))
      }
    } : {}
  };
}

async function startVirtualStudent(baseUrl, assignment, student, maxRetries) {
  const started = await requestWithRetry(`${baseUrl}/api/learning/attempts/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      publicToken: assignment.publicToken, studentRef: student.studentRef,
      clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true
    })
  }, maxRetries);
  return {
    assignment, student, attempt: started.payload.attempt, responses: responseMap(assignment.definition),
    submissionId: crypto.randomUUID(), startMs: started.durationMs, startRetries: started.retryCount
  };
}

async function saveVirtualDraft(baseUrl, state, maxRetries) {
  const revision = Number(state.attempt.draftRevision) + 1;
  const saved = await requestWithRetry(`${baseUrl}/api/learning/attempts/draft`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      attemptToken: state.attempt.attemptToken, revision,
      definitionHash: state.assignment.definitionHash, responses: state.responses
    })
  }, maxRetries);
  state.attempt.draftRevision = Number(saved.payload.draft.revision);
  return { ...state, draftMs: saved.durationMs, draftRetries: saved.retryCount };
}

async function submitOpenCheckpoints(baseUrl, state, mode, maxRetries) {
  if (mode === 'none') return state;
  const releaseByBlock = new Map((state.assignment.blockReleases || []).map(item => [item.blockId, item.status]));
  const blocks = state.assignment.definition.blocks.filter(block => releaseByBlock.get(block.blockId) === 'open');
  if (mode === 'required' && blocks.length !== state.assignment.definition.blocks.length) {
    const error = new Error('Không phải mọi checkpoint đều mở trong lớp benchmark.');
    error.code = 'CHECKPOINT_NOT_OPEN';
    throw error;
  }
  let checkpointMs = 0;
  let checkpointRetries = 0;
  for (const block of blocks) {
    const submitted = await requestWithRetry(`${baseUrl}/api/learning/attempts/checkpoints/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        attemptToken: state.attempt.attemptToken, checkpointSubmissionId: crypto.randomUUID(),
        blockId: block.blockId, checkpoint: block.checkpoint, draftRevision: state.attempt.draftRevision,
        definitionHash: state.assignment.definitionHash, responses: state.responses,
        idempotencyKey: `load:${state.attempt.attemptToken}:${block.blockId}:v1`
      })
    }, maxRetries);
    checkpointMs += submitted.durationMs;
    checkpointRetries += submitted.retryCount;
  }
  return { ...state, checkpointMs, checkpointRetries };
}

async function submitVirtualStudent(baseUrl, state, maxRetries) {
  const request = {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      attemptToken: state.attempt.attemptToken, submissionId: state.submissionId,
      definitionHash: state.assignment.definitionHash,
      draftRevision: state.attempt.draftRevision, responses: state.responses
    })
  };
  const submitted = await requestWithRetry(`${baseUrl}/api/learning/attempts/submit`, request, maxRetries);
  return {
    ...state, submitRequest: request, submitMs: submitted.durationMs,
    receiptSubmissionId: submitted.payload.receipt.submissionId,
    replayed: Boolean(submitted.payload.replayed), submitRetries: submitted.retryCount
  };
}

async function verifyReplays(baseUrl, states, concurrency) {
  return runBounded(states, concurrency, async state => {
    const replay = await requestJson(`${baseUrl}/api/learning/attempts/submit`, state.submitRequest);
    if (!replay.payload.replayed || replay.payload.receipt.submissionId !== state.receiptSubmissionId) {
      const error = new Error('Replay không trả đúng submission đã commit.');
      error.code = 'REPLAY_IDENTITY_MISMATCH';
      throw error;
    }
    return { replayMs: replay.durationMs, replayRetries: 0 };
  });
}

async function readbackSubmissions(states) {
  const connectionString = process.env.LEARNING_DATABASE_URL;
  if (!connectionString) throw new Error('--readback cần biến môi trường LEARNING_DATABASE_URL của staging.');
  const expected = states.map(state => ({
    submission_id: state.receiptSubmissionId, assignment_id: state.assignment.assignmentId,
    student_ref: state.student.studentRef,
    item_count: state.assignment.definition.blocks.flatMap(block => block.items).length
  }));
  const pool = new Pool({ connectionString, max: 2, application_name: 'izone_learning_load_readback' });
  try {
    const result = await pool.query(`WITH expected AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
        submission_id uuid, assignment_id uuid, student_ref uuid, item_count integer
      )
    )
    SELECT count(*)::int AS expected_submissions, count(submission.id)::int AS saved_submissions,
      count(*) FILTER (WHERE submission.id IS NOT NULL AND (
        submission.assignment_id <> expected.assignment_id OR submission.student_ref <> expected.student_ref
      ))::int AS identity_mismatches,
      (SELECT count(*)::int FROM learning.response_item item JOIN expected ON expected.submission_id = item.submission_id) AS response_items,
      (SELECT count(*)::int FROM learning.grading_result_item item JOIN learning.grading_run run ON run.id = item.grading_run_id
        JOIN expected ON expected.submission_id = run.submission_id) AS grading_items,
      (SELECT count(*)::int FROM learning.attendance_event event JOIN expected ON expected.submission_id = event.source_submission_id) AS attendance_events,
      (SELECT count(*)::int FROM learning.evidence_event evidence JOIN expected ON expected.submission_id = evidence.submission_id) AS evidence_events,
      (SELECT count(*)::int FROM learning.outbox_job job JOIN expected ON expected.submission_id::text = job.payload->>'submissionId') AS outbox_jobs,
      (SELECT coalesce(sum(item_count), 0)::int FROM expected) AS expected_items
    FROM expected LEFT JOIN learning.submission submission ON submission.id = expected.submission_id;`, [JSON.stringify(expected)]);
    const row = result.rows[0];
    const verified = Number(row.saved_submissions) === expected.length && Number(row.identity_mismatches) === 0
      && Number(row.response_items) === Number(row.expected_items) && Number(row.grading_items) === Number(row.expected_items)
      && Number(row.attendance_events) === expected.length && Number(row.evidence_events) === expected.length
      && Number(row.outbox_jobs) === expected.length;
    return { ...row, verified };
  } finally { await pool.end(); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const manifest = JSON.parse(await readFile(options.assignmentsFile, 'utf8'));
  if (!Array.isArray(manifest.assignmentTokens) || !manifest.assignmentTokens.length) throw new Error('Manifest cần assignmentTokens không rỗng.');
  const opened = [];
  for (const publicToken of manifest.assignmentTokens) {
    const { payload } = await openAssignment(options.baseUrl, publicToken);
    opened.push(payload.assignment);
  }
  if (options.phase === 'open') {
    const tasks = Array.from({ length: options.virtualUsers }, (_, index) => manifest.assignmentTokens[index % manifest.assignmentTokens.length]);
    const run = await runScheduled(tasks, options.durationSeconds * 1_000, options.concurrency, async publicToken => {
      const openedRequest = await openAssignment(options.baseUrl, publicToken);
      return { openMs: openedRequest.durationMs };
    });
    console.log(JSON.stringify(summarize('open', tasks.length, run), null, 2));
    return;
  }
  const studentTasks = opened.flatMap(assignment => assignment.roster.map(student => ({ assignment, student }))).slice(0, options.virtualUsers);
  if (studentTasks.length < options.virtualUsers) throw new Error(`Manifest chỉ cung cấp ${studentTasks.length} học viên; cần ${options.virtualUsers}.`);
  const preparedAttempts = await runBounded(studentTasks, options.concurrency,
    task => startVirtualStudent(options.baseUrl, task.assignment, task.student, options.maxRetries));
  const startedStates = preparedAttempts.results.filter(Boolean);
  if (startedStates.length !== options.virtualUsers) {
    throw new Error(`Chuẩn bị attempt chỉ thành công ${startedStates.length}/${options.virtualUsers}: ${JSON.stringify(preparedAttempts.errors)}`);
  }
  if (options.phase === 'autosave') {
    const autosaveRun = await runScheduled(startedStates, options.durationSeconds * 1_000, options.concurrency,
      state => saveVirtualDraft(options.baseUrl, state, options.maxRetries));
    console.log(JSON.stringify({ preparation: summarize('start', options.virtualUsers, preparedAttempts), load: summarize('autosave', options.virtualUsers, autosaveRun, 'draft') }, null, 2));
    return;
  }
  const draftPreparation = await runBounded(startedStates, options.concurrency,
    state => saveVirtualDraft(options.baseUrl, state, options.maxRetries));
  const checkpointPreparation = await runBounded(draftPreparation.results.filter(Boolean), options.concurrency,
    state => submitOpenCheckpoints(options.baseUrl, state, options.checkpointMode, options.maxRetries));
  const readyStates = checkpointPreparation.results.filter(Boolean);
  if (readyStates.length !== options.virtualUsers) {
    throw new Error(`Chuẩn bị trước cao điểm chỉ thành công ${readyStates.length}/${options.virtualUsers}: ${JSON.stringify(checkpointPreparation.errors)}`);
  }
  const submitRun = await runScheduled(readyStates, options.durationSeconds * 1_000, options.concurrency,
    state => submitVirtualStudent(options.baseUrl, state, options.maxRetries));
  const submittedStates = submitRun.results.filter(Boolean);
  const output = {
    preparation: {
      start: summarize('start', options.virtualUsers, preparedAttempts),
      draft: summarize('draft', options.virtualUsers, draftPreparation),
      checkpoint: summarize('checkpoint', options.virtualUsers, checkpointPreparation)
    },
    load: summarize('submit', options.virtualUsers, submitRun)
  };
  if (options.verifyReplay) output.replay = summarize('replay', submittedStates.length, await verifyReplays(options.baseUrl, submittedStates, options.concurrency));
  if (options.readback) {
    output.readback = await readbackSubmissions(readyStates.map(state => {
      const submitted = submittedStates.find(item => item.submissionId === state.submissionId);
      return submitted || { ...state, receiptSubmissionId: state.submissionId };
    }));
    if (!output.readback.verified) process.exitCode = 2;
  }
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
