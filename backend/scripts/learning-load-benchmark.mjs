import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Dữ liệu nhận vào: URL staging và file chỉ chứa public assignment token của dữ liệu thử nghiệm.
// Việc chính: mở form theo lịch, tùy chọn start/autosave/submit bằng roster giả của staging và đo p50/p95.
// Kết quả: JSON tổng hợp độ trễ/lỗi, không in token, tên học viên hoặc nội dung câu trả lời.
// Khi lỗi: dừng phase ghi nếu target chưa được xác nhận chính xác; từng request lỗi chỉ được đếm theo mã.

function parseArguments(argv) {
  const options = {
    baseUrl: 'http://127.0.0.1:3000',
    assignmentsFile: '',
    phase: 'open',
    virtualUsers: 1_650,
    durationSeconds: 300,
    concurrency: 100,
    confirmWrite: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') options.baseUrl = argv[++index] || '';
    else if (arg === '--assignments-file') options.assignmentsFile = path.resolve(argv[++index] || '');
    else if (arg === '--phase') options.phase = argv[++index] || '';
    else if (arg === '--virtual-users') options.virtualUsers = Number(argv[++index]);
    else if (arg === '--duration-seconds') options.durationSeconds = Number(argv[++index]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (arg === '--confirm-write') options.confirmWrite = argv[++index] || '';
    else throw new Error(`Tham số không hỗ trợ: ${arg}`);
  }
  if (!['open', 'submit'].includes(options.phase)) throw new Error('--phase chỉ nhận open hoặc submit.');
  if (!options.assignmentsFile) throw new Error('Thiếu --assignments-file.');
  if (!Number.isInteger(options.virtualUsers) || options.virtualUsers < 1 || options.virtualUsers > 10_000) {
    throw new Error('--virtual-users phải từ 1 đến 10000.');
  }
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 3_600) {
    throw new Error('--duration-seconds phải từ 1 đến 3600.');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 500) {
    throw new Error('--concurrency phải từ 1 đến 500.');
  }
  const target = new URL(options.baseUrl);
  options.baseUrl = target.origin + target.pathname.replace(/\/$/u, '');
  if (options.phase === 'submit') {
    if (target.hostname === 'ducizone.ddns.net') {
      throw new Error('Script cố ý chặn phase submit trên host production. Hãy dùng staging riêng.');
    }
    if (options.confirmWrite !== target.origin) {
      throw new Error(`Phase submit cần --confirm-write ${target.origin}.`);
    }
  }
  return options;
}

export function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1)];
}

function errorKey(error) {
  return String(error?.code || error?.status || 'REQUEST_FAILED').slice(0, 100);
}

async function requestJson(url, options) {
  const startedAt = performance.now();
  const response = await fetch(url, options);
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

function responseMap(definition) {
  const groupIndex = new Map();
  return Object.fromEntries(definition.blocks.flatMap(block => block.items).map(item => {
    if (['short_text', 'long_text'].includes(item.interactionType)) {
      return [item.itemVersionId, 'Dữ liệu giả dùng riêng cho kiểm thử tải staging.'];
    }
    const currentIndex = groupIndex.get(item.groupId) || 0;
    groupIndex.set(item.groupId, currentIndex + 1);
    const option = item.options[currentIndex % item.options.length] || item.options[0];
    return [item.itemVersionId, option.id];
  }));
}

async function openAssignment(baseUrl, publicToken) {
  return requestJson(`${baseUrl}/api/learning/assignments/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicToken })
  });
}

async function submitVirtualStudent(baseUrl, assignment, student) {
  const started = await requestJson(`${baseUrl}/api/learning/attempts/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicToken: assignment.publicToken,
      studentRef: student.studentRef,
      clientIdempotencyKey: crypto.randomUUID(),
      identityConfirmed: true
    })
  });
  const responses = responseMap(assignment.definition);
  const saved = await requestJson(`${baseUrl}/api/learning/attempts/draft`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      attemptToken: started.payload.attempt.attemptToken,
      revision: started.payload.attempt.draftRevision + 1,
      definitionHash: assignment.definitionHash,
      responses
    })
  });
  const submitted = await requestJson(`${baseUrl}/api/learning/attempts/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      attemptToken: started.payload.attempt.attemptToken,
      submissionId: crypto.randomUUID(),
      definitionHash: assignment.definitionHash,
      draftRevision: saved.payload.draft.revision,
      responses
    })
  });
  return {
    startMs: started.durationMs,
    draftMs: saved.durationMs,
    submitMs: submitted.durationMs
  };
}

async function runScheduled(tasks, durationMs, concurrency, runTask) {
  const latencies = { open: [], start: [], draft: [], submit: [] };
  const errors = new Map();
  let cursor = 0;
  const startTime = performance.now();
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const targetTime = startTime + (durationMs * index / Math.max(1, tasks.length - 1));
      const waitMs = targetTime - performance.now();
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      try {
        const result = await runTask(tasks[index]);
        for (const [key, value] of Object.entries(result)) {
          const metric = key.replace(/Ms$/u, '');
          if (latencies[metric]) latencies[metric].push(value);
        }
      } catch (error) {
        const key = errorKey(error);
        errors.set(key, (errors.get(key) || 0) + 1);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return { latencies, errors: Object.fromEntries(errors) };
}

function summarize(phase, targetCount, result) {
  return {
    phase,
    targetCount,
    errorCount: Object.values(result.errors).reduce((sum, value) => sum + value, 0),
    errors: result.errors,
    latencyMs: Object.fromEntries(Object.entries(result.latencies)
      .filter(([, values]) => values.length)
      .map(([key, values]) => [key, {
        count: values.length,
        p50: Math.round(percentile(values, 0.5)),
        p95: Math.round(percentile(values, 0.95)),
        max: Math.round(Math.max(...values))
      }]))
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const manifest = JSON.parse(await readFile(options.assignmentsFile, 'utf8'));
  if (!Array.isArray(manifest.assignmentTokens) || !manifest.assignmentTokens.length) {
    throw new Error('Manifest cần assignmentTokens không rỗng.');
  }
  const tokens = manifest.assignmentTokens.slice(0, options.virtualUsers);
  const opened = [];
  for (const token of tokens) {
    const { payload } = await openAssignment(options.baseUrl, token);
    opened.push(payload.assignment);
  }

  if (options.phase === 'open') {
    const tasks = Array.from({ length: options.virtualUsers }, (_, index) => tokens[index % tokens.length]);
    const result = await runScheduled(tasks, options.durationSeconds * 1_000, options.concurrency, async token => {
      const openedRequest = await openAssignment(options.baseUrl, token);
      return { openMs: openedRequest.durationMs };
    });
    console.log(JSON.stringify(summarize('open', tasks.length, result), null, 2));
    return;
  }

  const tasks = opened.flatMap(assignment => assignment.roster.map(student => ({ assignment, student })))
    .slice(0, options.virtualUsers);
  if (tasks.length < options.virtualUsers) {
    throw new Error(`Manifest chỉ cung cấp ${tasks.length} học viên; cần ${options.virtualUsers}.`);
  }
  const result = await runScheduled(tasks, options.durationSeconds * 1_000, options.concurrency,
    task => submitVirtualStudent(options.baseUrl, task.assignment, task.student));
  console.log(JSON.stringify(summarize('submit', tasks.length, result), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
