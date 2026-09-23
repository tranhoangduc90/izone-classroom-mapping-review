import process from 'node:process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { LarkClient } from './lark-client.js';
import { createWritingTestService } from './writing-tests.js';

const { Pool } = pg;
const LOCK_NAMESPACE = 91_726_310;
const COLLECT_LOCK_KEY = 1;
const PORTAL_LOCK_KEY = 2;
const RECONCILE_LOCK_KEY = 3;
const DEFAULT_SCORE_TABLE_ID = 'tblEBaI33abutdsq';
const DEFAULT_SCORE_VIEW_ID = 'vewDilGbCf';
const DEFAULT_TRACKING_TABLE_NAME = 'Theo dõi điểm Writing Test';
const SOURCE_FIELDS = [
  'Overall', 'Portal', 'Lớp', 'Google User ID', 'Classroom Course ID', 'CourseWork ID',
  'Trạng thái Portal Writing', 'Lý do Portal Writing', 'Kiểm tra Portal Writing lúc',
  'Bỏ qua Portal Writing', 'Thời điểm xong'
];

function required(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`CONFIG_MISSING:${name}`);
  return value;
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`CONFIG_INVALID:${name}`);
  return value;
}

function safeErrorCode(error) {
  const raw = String(error?.code ?? error?.message ?? 'UNKNOWN');
  const match = raw.match(/[A-Z][A-Z0-9_:-]{2,80}/);
  return match?.[0] ?? 'WRITING_WORKER_FAILED';
}

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}

function buildRuntime() {
  const syncSecret = required('WRITING_TEST_SYNC_SECRET');
  if (syncSecret.length < 32) throw new Error('CONFIG_INVALID:WRITING_TEST_SYNC_SECRET');
  const pool = new Pool({
    connectionString: required('DATABASE_URL'),
    max: 4,
    application_name: 'writing_portal_worker',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    query_timeout: 35_000
  });
  return {
    pool,
    service: createWritingTestService({ pool }),
    lark: new LarkClient({
      appId: required('LARK_APP_ID'),
      appSecret: required('LARK_APP_SECRET'),
      baseAppToken: required('LARK_BASE_APP_TOKEN')
    }),
    scoreTableId: String(process.env.WRITING_SCORE_TABLE_ID ?? DEFAULT_SCORE_TABLE_ID),
    scoreViewId: String(process.env.WRITING_SCORE_VIEW_ID ?? DEFAULT_SCORE_VIEW_ID),
    trackingTableId: String(process.env.WRITING_TRACKING_TABLE_ID ?? '').trim() || null,
    trackingTableName: String(process.env.WRITING_TRACKING_TABLE_NAME ?? DEFAULT_TRACKING_TABLE_NAME),
    portalUrl: required('WRITING_PORTAL_WRITER_URL'),
    syncSecret,
    maxBackendCalls: Math.max(1, Math.floor(numberFromEnv('WRITING_COLLECT_MAX_CALLS', 10))),
    portalPaceMs: numberFromEnv('WRITING_PORTAL_PACE_MS', 5_200),
    portalRetryDelayMs: numberFromEnv('WRITING_PORTAL_RETRY_DELAY_MS', 30 * 60_000),
    portalTimeoutMs: numberFromEnv('WRITING_PORTAL_TIMEOUT_MS', 30_000),
    fetchImpl: fetch,
    sleepImpl: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now: () => new Date()
  };
}

async function withLock(pool, key, handler) {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_NAMESPACE, key]
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return { skipped: true };
    return await handler();
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, key]).catch(() => {});
    }
    client.release();
  }
}

async function listSourceRecords(runtime) {
  const records = [];
  let pageToken = '';
  do {
    const data = await runtime.lark.request('GET', `/tables/${runtime.scoreTableId}/records`, {
      query: {
        page_size: 500,
        view_id: runtime.scoreViewId,
        field_names: JSON.stringify(SOURCE_FIELDS),
        page_token: pageToken
      }
    });
    records.push(...(data.items ?? []));
    pageToken = data.has_more ? String(data.page_token ?? '') : '';
  } while (pageToken);
  return records;
}

async function updateSource(runtime, recordId, status, reason, ignored) {
  await runtime.lark.request('PUT', `/tables/${runtime.scoreTableId}/records/${recordId}`, {
    write: true,
    body: {
      fields: {
        'Trạng thái Portal Writing': status,
        'Lý do Portal Writing': reason,
        'Kiểm tra Portal Writing lúc': runtime.now().getTime(),
        'Bỏ qua Portal Writing': ignored
      }
    }
  });
}

export async function runCollectCycle(runtime) {
  return withLock(runtime.pool, COLLECT_LOCK_KEY, async () => {
    // Đầu vào: các dòng điểm trong đúng view Lark. Việc chính: lọc dòng đã xử lý,
    // tạo khóa chống trùng từ record và điểm, rồi lưu qua nghiệp vụ PostgreSQL hiện có.
    // Kết quả: Lark nhận trạng thái dễ hiểu; lỗi hạ tầng làm cả vòng thất bại để lần sau thử lại.
    const records = await listSourceRecords(runtime);
    const counts = {
      scanned: records.length,
      candidates: 0,
      stored: 0,
      duplicate: 0,
      ignoredLocked: 0,
      ignoredMissingIds: 0,
      ignoredNotConfigured: 0,
      ignoredIdentity: 0,
      ignoredClass: 0,
      ignoredOther: 0,
      deferredRateBudget: 0
    };
    let backendCalls = 0;
    for (const record of records) {
      const row = record?.fields ?? {};
      const score = Number(row.Overall);
      if (!Number.isFinite(score) || row.Portal === true) continue;
      const rawModified = Number(
        row['Thời điểm xong']
        ?? record.last_modified_time
        ?? record.updated_at
        ?? runtime.now().getTime()
      );
      const modifiedMs = rawModified > 0 && rawModified < 1_000_000_000_000
        ? rawModified * 1_000
        : rawModified;
      const checkedAt = Number(row['Kiểm tra Portal Writing lúc'] ?? 0);
      const previousStatus = String(row['Trạng thái Portal Writing'] ?? '').trim();
      const alreadyAccepted = /Đã tiếp nhận điểm Writing|Điểm Writing đã được tiếp nhận trước đó/i.test(previousStatus);
      if (alreadyAccepted && Number.isFinite(modifiedMs) && modifiedMs <= checkedAt + 5_000) continue;
      if (previousStatus === 'Chờ đồng bộ cấu hình'
        && checkedAt > 0
        && runtime.now().getTime() - checkedAt < 15 * 60_000) continue;

      const classroomCourseId = String(row['Classroom Course ID'] ?? '').trim();
      const classroomCourseworkId = String(row['CourseWork ID'] ?? '').trim();
      const googleUserId = String(row['Google User ID'] ?? '').trim();
      const previousReason = String(row['Lý do Portal Writing'] ?? '').trim();
      const recoverableLock = /Thiếu Google User ID|chưa được khai báo là bài test chính thức/i.test(previousReason);
      if (row['Bỏ qua Portal Writing'] === true && !recoverableLock) {
        counts.ignoredLocked += 1;
        continue;
      }
      if (!classroomCourseId || !classroomCourseworkId || !googleUserId) {
        await updateSource(
          runtime,
          record.record_id,
          'Chờ đồng bộ ID kỹ thuật',
          'Thiếu Google User ID, Classroom Course ID hoặc CourseWork ID; hệ thống sẽ tự thử lại.',
          false
        );
        counts.ignoredMissingIds += 1;
        continue;
      }
      if (backendCalls >= runtime.maxBackendCalls) {
        counts.deferredRateBudget += 1;
        continue;
      }

      counts.candidates += 1;
      backendCalls += 1;
      const response = await runtime.service.receiveScore({
        version: 1,
        idempotencyKey: `writing:${record.record_id}:${score.toFixed(1)}`,
        sourceRecordId: String(record.record_id),
        classroomCourseId,
        classroomCourseworkId,
        googleUserId,
        className: String(row['Lớp'] ?? '').trim() || undefined,
        score,
        scoredAt: new Date(Number.isFinite(modifiedMs) ? modifiedMs : runtime.now().getTime()).toISOString()
      });

      if (response?.status === 'stored' || response?.status === 'duplicate') {
        await updateSource(
          runtime,
          record.record_id,
          response.status === 'stored' ? 'Đã tiếp nhận điểm Writing' : 'Điểm Writing đã được tiếp nhận trước đó',
          '',
          false
        );
        counts[response.status] += 1;
        continue;
      }

      const rejection = {
        source_not_configured: [
          'Bài Classroom này chưa được khai báo là bài test chính thức; hệ thống sẽ tự thử lại sau khi đồng bộ cấu hình.',
          'ignoredNotConfigured'
        ],
        identity_not_mapped: [
          'Google User ID không khớp một học viên thật đã duyệt; có thể là record chạy thử.',
          'ignoredIdentity'
        ],
        class_not_resolved: [
          'Không tìm được đúng một lớp thật đồng thời khớp ERP và roster Classroom.',
          'ignoredClass'
        ]
      }[String(response?.status ?? '')] ?? [
        response?.error === 'RATE_LIMITED'
          ? 'Backend đang giới hạn số lượt gửi; hệ thống sẽ tự thử lại.'
          : `Backend từ chối record trước bước Portal: ${String(response?.error ?? 'WRITING_UNKNOWN_REJECTION')}`,
        'ignoredOther'
      ];
      const retryable = response?.status === 'source_not_configured' || response?.error === 'RATE_LIMITED';
      await updateSource(
        runtime,
        record.record_id,
        response?.error === 'RATE_LIMITED'
          ? 'Chờ gửi lại do giới hạn hệ thống'
          : (retryable ? 'Chờ đồng bộ cấu hình' : 'Bỏ qua an toàn'),
        rejection[0],
        !retryable
      );
      counts[rejection[1]] += 1;
    }
    return counts;
  });
}

async function callPortal(runtime, record) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.portalTimeoutMs);
  try {
    const response = await runtime.fetchImpl(runtime.portalUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-writing-test-sync': runtime.syncSecret
      },
      body: JSON.stringify({
        version: 1,
        attemptToken: record.id,
        testSlug: `term-test-${Number(record.testNumber)}`,
        classId: record.classId,
        studentId: record.studentId,
        grades: { writing: record.writingOverall },
        portalTestNames: { writing: record.portalTestName }
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, error: 'WRITING_PORTAL_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPortalCycle(runtime) {
  return withLock(runtime.pool, PORTAL_LOCK_KEY, async () => {
    // Đầu vào: hàng đợi Writing bền vững trong PostgreSQL. Việc chính: chốt dòng hết
    // thời gian, gửi từng đúng result ID sang Portal và đọc kết quả trước khi đổi trạng thái.
    // Kết quả: synced/conflict/error gắn lại đúng dòng; lỗi sẽ được thử lại sau thời gian chờ.
    await runtime.service.processDue();
    const records = await runtime.service.listRecords();
    const ready = records.filter(record => {
      if (['ready', 'ready_zero', 'ready_late'].includes(record.status)) return true;
      if (record.status !== 'error') return false;
      const lastAttemptAt = Date.parse(String(record.updatedAt ?? ''));
      return !Number.isFinite(lastAttemptAt)
        || runtime.now().getTime() - lastAttemptAt >= runtime.portalRetryDelayMs;
    });
    const counts = {
      ready: ready.length,
      deferredErrors: records.filter(record => record.status === 'error').length
        - ready.filter(record => record.status === 'error').length,
      synced: 0,
      conflicts: 0,
      errors: 0
    };

    for (const record of ready) {
      await runtime.sleepImpl(runtime.portalPaceMs);
      const portal = await callPortal(runtime, record);
      const success = Boolean(portal?.ok && portal?.status === 'synced');
      const conflict = /CONFLICT|EXISTING_OFFICIAL_GRADE/i.test(String(portal?.error ?? ''));
      await runtime.service.markPortalResult({
        version: 1,
        resultId: record.id,
        expectedGrade: record.writingOverall,
        success,
        conflict,
        errorCode: success ? undefined : String(portal?.error ?? 'WRITING_PORTAL_SYNC_FAILED')
      });
      if (success) counts.synced += 1;
      else if (conflict) counts.conflicts += 1;
      else counts.errors += 1;
    }
    return counts;
  });
}

const TRACKING_STATUS = {
  waiting: 'Chờ điểm Task còn lại',
  ready: 'Sẵn sàng chuyển Portal',
  ready_zero: 'Đã dùng 0 cho Task thiếu',
  ready_late: 'Có điểm muộn - chờ cập nhật',
  synced: 'Đã chuyển Portal',
  paused: 'Tạm dừng - nghi lỗi luồng chấm',
  conflict: 'Xung đột điểm Portal',
  error: 'Lỗi - cần kiểm tra'
};
const TRACKING_ERRORS = {
  WRITING_MASS_MISSING_SUSPECTED: 'Nhiều học viên cùng thiếu một Task; hệ thống tạm dừng dùng điểm 0.',
  WRITING_PORTAL_SYNC_FAILED: 'Chưa ghi hoặc chưa đọc lại được điểm trên Portal.'
};

function toMilliseconds(value) {
  if (!value) return null;
  const milliseconds = Date.parse(String(value));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function remainingText(record, now) {
  if (!['waiting', 'paused'].includes(record.status) || !record.expiresAt) return '';
  const expiresAt = Date.parse(String(record.expiresAt));
  if (!Number.isFinite(expiresAt)) return '';
  const minutes = Math.ceil((expiresAt - now.getTime()) / 60_000);
  if (minutes <= 0) return 'Đã hết thời gian chờ';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `Còn ${hours} giờ ${rest} phút` : `Còn ${rest} phút`;
}

function sourceLink(recordId, label) {
  return recordId
    ? {
        link: `https://rgpp6vyqmyx.sg.larksuite.com/base/${encodeURIComponent(required('LARK_BASE_APP_TOKEN'))}?table=${DEFAULT_SCORE_TABLE_ID}&record=${encodeURIComponent(recordId)}`,
        text: label
      }
    : null;
}

function trackingFields(record, now) {
  const fields = {
    'Mã theo dõi': record.id,
    'Học viên': record.studentName,
    'Lớp Portal': record.className,
    'Khóa': record.courseNumber,
    'Kỳ test': record.portalTestName,
    'Bản ghi Task 1': sourceLink(record.task1SourceRecordId ?? record.directSourceRecordId, 'Mở bài nguồn'),
    'Điểm Task 1': record.task1Score ?? record.directScore,
    'Task 1 có điểm lúc': toMilliseconds(record.task1ScoredAt ?? record.directScoredAt),
    'Bản ghi Task 2': sourceLink(record.task2SourceRecordId, 'Mở Task 2'),
    'Điểm Task 2': record.task2Score,
    'Task 2 có điểm lúc': toMilliseconds(record.task2ScoredAt),
    'Writing Overall': record.writingOverall,
    'Bắt đầu chờ': toMilliseconds(record.firstScoreAt),
    'Hết thời gian chờ': toMilliseconds(record.expiresAt),
    'Thời gian còn lại': remainingText(record, now),
    'Task đang thiếu': record.missingComponent === 'task1'
      ? 'Task 1'
      : (record.missingComponent === 'task2' ? 'Task 2' : ''),
    'Trạng thái xử lý': TRACKING_STATUS[record.status] ?? 'Lỗi - cần kiểm tra',
    'Đã từng dùng điểm 0': Boolean(record.usedZero),
    'Portal': record.status === 'synced',
    'Điểm đã ghi Portal': record.lastPortalGrade,
    'Đồng bộ Portal lúc': toMilliseconds(record.portalSyncedAt),
    'Lỗi gần nhất': TRACKING_ERRORS[record.lastErrorCode] ?? String(record.lastErrorCode ?? ''),
    'Cần xử lý': ['paused', 'conflict', 'error'].includes(record.status),
    'Cập nhật lúc': toMilliseconds(record.updatedAt),
    'Mã học viên ERP': record.studentId,
    'Mã lớp Portal': record.classId,
    'Google User ID': record.googleUserId ?? '',
    'Mã bản ghi Task 1': record.task1SourceRecordId ?? record.directSourceRecordId ?? '',
    'Mã bản ghi Task 2': record.task2SourceRecordId ?? ''
  };
  for (const key of Object.keys(fields)) {
    if (fields[key] === null || fields[key] === undefined) delete fields[key];
  }
  return fields;
}

async function resolveTrackingTableId(runtime) {
  if (runtime.trackingTableId) return runtime.trackingTableId;
  const tables = await runtime.lark.listTables();
  const matches = tables.filter(table => String(table.name ?? '').trim() === runtime.trackingTableName);
  if (matches.length !== 1) throw new Error('WRITING_TRACKING_TABLE_AMBIGUOUS');
  return String(matches[0].table_id);
}

export async function runReconcileCycle(runtime) {
  return withLock(runtime.pool, RECONCILE_LOCK_KEY, async () => {
    // Đầu vào: trạng thái Writing bền vững trong PostgreSQL. Việc chính: tìm đúng
    // một bảng Lark, upsert theo result ID và phản chiếu trạng thái về đúng record nguồn.
    // Kết quả: số dòng đã cập nhật; lỗi danh tính hoặc HTTP làm cả vòng dừng để lần sau chạy bù.
    const records = await runtime.service.listRecords();
    const trackingTableId = await resolveTrackingTableId(runtime);
    let trackingUpserts = 0;
    let sourceUpdates = 0;
    for (const record of records) {
      const search = await runtime.lark.request('POST', `/tables/${trackingTableId}/records/search`, {
        body: {
          field_names: ['Mã theo dõi'],
          filter: {
            conjunction: 'and',
            conditions: [{ field_name: 'Mã theo dõi', operator: 'is', value: [record.id] }]
          }
        }
      });
      const matches = search.items ?? [];
      if (matches.length > 1) throw new Error('WRITING_TRACKING_ID_DUPLICATE');
      const existingId = matches[0]?.record_id;
      const saved = await runtime.lark.request(
        existingId ? 'PUT' : 'POST',
        existingId
          ? `/tables/${trackingTableId}/records/${existingId}`
          : `/tables/${trackingTableId}/records`,
        {
          write: true,
          retry: Boolean(existingId),
          body: { fields: trackingFields(record, runtime.now()) }
        }
      );
      const savedId = String(saved?.record?.record_id ?? saved?.record_id ?? existingId ?? '');
      if (!savedId) throw new Error('WRITING_TRACKING_WRITE_READBACK_MISSING');
      trackingUpserts += 1;

      const sourceIds = [...new Set([
        record.directSourceRecordId,
        record.task1SourceRecordId,
        record.task2SourceRecordId
      ].filter(Boolean).map(String))];
      for (const sourceId of sourceIds) {
        const updated = await runtime.lark.request('PUT', `/tables/${runtime.scoreTableId}/records/${sourceId}`, {
          write: true,
          body: {
            fields: {
              Portal: record.status === 'synced',
              'Trạng thái Portal Writing': TRACKING_STATUS[record.status] ?? 'Lỗi - cần kiểm tra',
              'Lý do Portal Writing': TRACKING_ERRORS[record.lastErrorCode] ?? String(record.lastErrorCode ?? ''),
              'Kiểm tra Portal Writing lúc': runtime.now().getTime(),
              'Bỏ qua Portal Writing': false
            }
          }
        });
        const updatedId = String(updated?.record?.record_id ?? updated?.record_id ?? sourceId);
        if (updatedId !== sourceId) throw new Error('WRITING_SOURCE_READBACK_ID_MISMATCH');
        sourceUpdates += 1;
      }
    }
    return { records: records.length, trackingUpserts, sourceUpdates };
  });
}

export function startWritingPortalWorker(runtime, options = {}) {
  const collectorIntervalMs = options.collectorIntervalMs ?? 5 * 60_000;
  const portalIntervalMs = options.portalIntervalMs ?? 5 * 60_000;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 15 * 60_000;
  let stopped = false;
  const timers = new Set();
  const running = new Set();

  function schedule(name, intervalMs, task) {
    const run = async () => {
      if (stopped) return;
      const promise = task()
        .then(result => log(`${name}_completed`, result?.skipped ? { skipped: true } : result))
        .catch(error => log(`${name}_failed`, { errorCode: safeErrorCode(error) }))
        .finally(() => running.delete(promise));
      running.add(promise);
      await promise;
    };
    void run();
    // Giữ nhịp theo đồng hồ như Schedule Trigger cũ. Nếu vòng trước chưa xong,
    // advisory lock khiến vòng mới bỏ qua an toàn thay vì chạy chồng hoặc dồn việc.
    const timer = setInterval(() => void run(), intervalMs);
    timers.add(timer);
  }

  schedule('collect', collectorIntervalMs, () => runCollectCycle(runtime));
  schedule('portal', portalIntervalMs, () => runPortalCycle(runtime));
  schedule('reconcile', reconcileIntervalMs, () => runReconcileCycle(runtime));
  return {
    async stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      await Promise.allSettled([...running]);
    }
  };
}

export async function main(argv = process.argv.slice(2)) {
  const runtime = buildRuntime();
  const collectorIntervalMs = numberFromEnv('WRITING_COLLECT_INTERVAL_MS', 5 * 60_000);
  const portalIntervalMs = numberFromEnv('WRITING_PORTAL_INTERVAL_MS', 5 * 60_000);
  const reconcileIntervalMs = numberFromEnv('WRITING_RECONCILE_INTERVAL_MS', 15 * 60_000);
  const onceMode = [
    ['--collect-once', 'collect', runCollectCycle],
    ['--portal-once', 'portal', runPortalCycle],
    ['--reconcile-once', 'reconcile', runReconcileCycle]
  ].find(([flag]) => argv.includes(flag));
  if (onceMode) {
    try {
      const [, name, task] = onceMode;
      log(`${name}_completed`, await task(runtime));
    } finally {
      await runtime.pool.end();
    }
    return;
  }
  const worker = startWritingPortalWorker(runtime, {
    collectorIntervalMs,
    portalIntervalMs,
    reconcileIntervalMs
  });
  log('worker_started', { collectorIntervalMs, portalIntervalMs, reconcileIntervalMs });
  await new Promise(resolve => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  await worker.stop();
  await runtime.pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    log('process_failed', { errorCode: safeErrorCode(error) });
    process.exitCode = 1;
  });
}
