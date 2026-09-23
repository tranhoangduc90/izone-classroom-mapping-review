import process from 'node:process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { LarkClient } from './lark-client.js';
import {
  allFields,
  checksum,
  DATASETS,
  hasFieldDrift,
  normalizeSourceFields,
  partNumberFromName,
  safeErrorCode,
  STATUS_TABLE,
} from './lark-replica-definitions.js';

const { Pool } = pg;
const LOCK_NAMESPACE = 12_961_242;
const LOCK_KEY = 20_260_813;
const SCHEDULE_SLOTS = new Map([
  ['05:30', 'full'],
  ['13:30', 'incremental'],
  ['23:30', 'incremental'],
]);

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

function buildRuntime() {
  const pool = new Pool({
    connectionString: required('DATABASE_URL'),
    max: 2,
    application_name: 'mapping-lark-sync',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  });
  const lark = new LarkClient({
    appId: required('LARK_APP_ID'),
    appSecret: required('LARK_APP_SECRET'),
    baseAppToken: required('LARK_BASE_APP_TOKEN'),
  });
  return {
    pool,
    lark,
    batchSize: Math.min(200, Math.max(1, numberFromEnv('LARK_WRITE_BATCH_SIZE', 200))),
    maxChangeRatio: numberFromEnv('LARK_MAX_CHANGE_RATIO', 0.5),
    maxChangeCount: numberFromEnv('LARK_MAX_CHANGE_COUNT', 500),
    maxTombstoneRatio: numberFromEnv('LARK_MAX_TOMBSTONE_RATIO', 0.1),
    maxTombstoneCount: numberFromEnv('LARK_MAX_TOMBSTONE_COUNT', 50),
  };
}

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...details,
  })}\n`);
}

function textValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ');
  if (typeof value === 'object') return textValue(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

function validateSchema(definition, fields) {
  const expected = allFields(definition);
  const byName = new Map();
  for (const field of fields) {
    const name = String(field.field_name ?? '').trim();
    if (byName.has(name)) throw new Error(`LARK_DUPLICATE_FIELD:${definition.key}`);
    byName.set(name, field);
  }
  if (byName.size !== expected.length) throw new Error(`LARK_SCHEMA_FIELD_COUNT:${definition.key}`);
  for (const expectedField of expected) {
    const actual = byName.get(expectedField.name);
    if (!actual || Number(actual.type) !== expectedField.type) {
      throw new Error(`LARK_SCHEMA_FIELD_MISMATCH:${definition.key}`);
    }
  }
  const primary = fields.find((field) => field.is_primary) ?? fields[0];
  if (String(primary?.field_name ?? '') !== 'Khóa đồng bộ' || Number(primary?.type) !== 1) {
    throw new Error(`LARK_SCHEMA_PRIMARY_MISMATCH:${definition.key}`);
  }
}

async function ensureSingleTable(lark, definition, name, tables, createMissing) {
  const matches = tables.filter((table) => String(table.name ?? '').trim() === name);
  if (matches.length > 1) throw new Error(`LARK_DUPLICATE_TABLE:${definition.key}`);
  let table = matches[0];
  if (!table) {
    if (!createMissing) throw new Error(`LARK_TABLE_MISSING:${definition.key}`);
    table = await lark.createTable(name, allFields(definition));
    if (!table?.table_id) throw new Error(`LARK_TABLE_CREATE_FAILED:${definition.key}`);
    tables.push(table);
  }
  const fields = await lark.listFields(table.table_id);
  validateSchema(definition, fields);
  return {
    tableId: table.table_id,
    name,
    part: partNumberFromName(definition.tableName, name) ?? 1,
  };
}

async function resolveManagedTables(lark, { createMissing = false } = {}) {
  const tables = await lark.listTables();
  const registry = new Map();
  for (const definition of [...DATASETS, STATUS_TABLE]) {
    const managed = [];
    const base = await ensureSingleTable(
      lark,
      definition,
      definition.tableName,
      tables,
      createMissing,
    );
    managed.push(base);
    if (definition.partitionAt) {
      const partTables = tables
        .map((table) => ({
          table,
          part: partNumberFromName(definition.tableName, String(table.name ?? '').trim()),
        }))
        .filter((item) => item.part && item.part >= 2)
        .sort((left, right) => left.part - right.part);
      for (const item of partTables) {
        const expectedName = `${definition.tableName} - Phần ${item.part}`;
        managed.push(await ensureSingleTable(
          lark,
          definition,
          expectedName,
          tables,
          false,
        ));
      }
      managed.sort((left, right) => left.part - right.part);
      for (let index = 0; index < managed.length; index += 1) {
        if (managed[index].part !== index + 1) {
          throw new Error(`LARK_PART_SEQUENCE_INVALID:${definition.key}`);
        }
      }
    }
    registry.set(definition.key, managed);
  }
  return { registry, tables };
}

async function bootstrap(runtime) {
  const result = await resolveManagedTables(runtime.lark, { createMissing: true });
  log('bootstrap_completed', {
    tableCount: [...result.registry.values()].reduce((sum, entries) => sum + entries.length, 0),
  });
}

async function smokeTest(runtime) {
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const definition = {
    key: 'anonymized_smoke_test',
    tableName: `Kiểm thử bản sao ẩn danh - ${suffix}`,
    fields: [{ name: 'Nội dung kiểm thử', type: 1 }],
  };
  let tableId;
  try {
    const table = await runtime.lark.createTable(definition.tableName, allFields(definition));
    tableId = table.table_id;
    validateSchema(definition, await runtime.lark.listFields(tableId));
    const now = Date.now();
    const created = await runtime.lark.createRecords(tableId, [{ fields: {
      'Khóa đồng bộ': 'anonymized:student-001',
      'Nội dung kiểm thử': 'Dữ liệu giả, không thuộc học viên thật',
      'Trạng thái nguồn': 'Đang có trong nguồn',
      'Cập nhật tại PostgreSQL': now,
      'Mã kiểm tra nguồn': checksum({ anonymized: true }),
      'Đồng bộ lên Lark lúc': now,
    } }]);
    const records = await runtime.lark.listRecords(tableId);
    if ((created.records ?? []).length !== 1 || records.length !== 1) {
      throw new Error('LARK_SMOKE_READBACK_FAILED');
    }
    log('smoke_test_completed', { recordCount: 1 });
  } finally {
    if (tableId) await runtime.lark.deleteTable(tableId);
  }
}

async function lastSuccessfulCursor(client) {
  const result = await client.query(`
    SELECT max(finished_at) AS cursor
    FROM mapping.lark_replica_run
    WHERE status = 'completed'
      AND mode IN ('full', 'incremental')
  `);
  return result.rows[0]?.cursor ?? null;
}

async function sourceRows(client, definition, { full, classId, cursor }) {
  const conditions = [];
  const values = [];
  if (classId !== null) {
    values.push(classId);
    conditions.push(`$${values.length}::bigint = ANY(scope_class_ids)`);
  }
  if (!full && cursor) {
    values.push(new Date(new Date(cursor).getTime() - 300_000).toISOString());
    conditions.push(`source_updated_at >= $${values.length}::timestamptz`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await client.query(`
    SELECT source_key, scope_class_ids, source_updated_at, source_status, payload
    FROM ${definition.viewName}
    ${where}
    ORDER BY source_key
  `, values);
  const seen = new Set();
  for (const row of result.rows) {
    if (seen.has(row.source_key)) throw new Error(`SOURCE_DUPLICATE_KEY:${definition.key}`);
    seen.add(row.source_key);
  }
  return result.rows;
}

async function totalSourceRows(client, definition, classId) {
  const values = [];
  let where = '';
  if (classId !== null) {
    values.push(classId);
    where = 'WHERE $1::bigint = ANY(scope_class_ids)';
  }
  const result = await client.query(`
    SELECT count(*)::integer AS total
    FROM ${definition.viewName}
    ${where}
  `, values);
  return Number(result.rows[0]?.total ?? 0);
}

async function listReplicaRecords(lark, tables, datasetKey) {
  const records = [];
  const byKey = new Map();
  for (const table of tables) {
    const tableRecords = await lark.listRecords(table.tableId);
    table.recordCount = tableRecords.length;
    for (const record of tableRecords) {
      const key = textValue(record.fields?.['Khóa đồng bộ']);
      if (!key) throw new Error(`LARK_EMPTY_SYNC_KEY:${datasetKey}`);
      if (byKey.has(key)) throw new Error(`LARK_DUPLICATE_SYNC_KEY:${datasetKey}`);
      const enriched = { ...record, tableId: table.tableId };
      byKey.set(key, enriched);
      records.push(enriched);
    }
  }
  return { records, byKey };
}

function buildExpected(definition, row, syncedAt) {
  const sourceFields = normalizeSourceFields(definition, row.payload);
  const sourceChecksum = buildSourceChecksum(definition, sourceFields, row.source_status);
  return {
    sourceFields,
    sourceChecksum,
    larkFields: {
      'Khóa đồng bộ': row.source_key,
      ...sourceFields,
      'Trạng thái nguồn': row.source_status,
      'Cập nhật tại PostgreSQL': new Date(row.source_updated_at).getTime(),
      'Mã kiểm tra nguồn': sourceChecksum,
      'Đồng bộ lên Lark lúc': syncedAt,
    },
  };
}

export function recordHasDrift(definition, expected, actualFields) {
  const ignoredFields = new Set(definition.driftIgnoredFields ?? []);
  const comparison = {
    ...definition,
    fields: [
      ...definition.fields.filter((field) => !ignoredFields.has(field.name)),
      { name: 'Trạng thái nguồn', type: 1 },
    ],
  };
  return textValue(actualFields?.['Mã kiểm tra nguồn']) !== expected.sourceChecksum
    || hasFieldDrift(comparison, expected.larkFields, actualFields);
}

export function buildSourceChecksum(definition, sourceFields, sourceStatus) {
  const ignoredFields = new Set(definition.driftIgnoredFields ?? []);
  const stableFields = Object.fromEntries(
    Object.entries(sourceFields).filter(([name]) => !ignoredFields.has(name)),
  );
  return checksum({ ...stableFields, sourceStatus });
}

function guardAnomalies(runtime, {
  existingCount,
  createCount,
  updateCount,
  tombstoneCount,
  allowBaseline,
}) {
  if (existingCount === 0 || allowBaseline) return;
  const changed = createCount + updateCount + tombstoneCount;
  const ratio = changed / Math.max(1, existingCount);
  if (changed > runtime.maxChangeCount || (changed >= 20 && ratio > runtime.maxChangeRatio)) {
    throw new Error('ANOMALOUS_CHANGE_VOLUME');
  }
  const tombstoneRatio = tombstoneCount / Math.max(1, existingCount);
  if (tombstoneCount > runtime.maxTombstoneCount
    || (tombstoneCount >= 10 && tombstoneRatio > runtime.maxTombstoneRatio)) {
    throw new Error('ANOMALOUS_TOMBSTONE_VOLUME');
  }
}

async function upsertState(client, rows) {
  if (!rows.length) return;
  await client.query(`
    INSERT INTO mapping.lark_replica_state (
      dataset, source_key, lark_table_id, lark_record_id, source_checksum,
      source_updated_at, source_present, first_synced_at, last_seen_at, last_synced_at
    )
    SELECT
      item.dataset, item.source_key, item.lark_table_id, item.lark_record_id,
      item.source_checksum, item.source_updated_at, item.source_present,
      now(), now(), now()
    FROM jsonb_to_recordset($1::jsonb) AS item(
      dataset text,
      source_key text,
      lark_table_id text,
      lark_record_id text,
      source_checksum text,
      source_updated_at timestamptz,
      source_present boolean
    )
    ON CONFLICT (dataset, source_key) DO UPDATE SET
      lark_table_id = EXCLUDED.lark_table_id,
      lark_record_id = EXCLUDED.lark_record_id,
      source_checksum = EXCLUDED.source_checksum,
      source_updated_at = EXCLUDED.source_updated_at,
      source_present = EXCLUDED.source_present,
      last_seen_at = now(),
      last_synced_at = now()
  `, [JSON.stringify(rows)]);
}

function stateRow(datasetKey, source, larkTableId, larkRecordId, sourcePresent = true) {
  return {
    dataset: datasetKey,
    source_key: source.row.source_key,
    lark_table_id: larkTableId,
    lark_record_id: larkRecordId,
    source_checksum: source.expected.sourceChecksum,
    source_updated_at: new Date(source.row.source_updated_at).toISOString(),
    source_present: sourcePresent,
  };
}

async function createNextPart(runtime, definition, tables, allTables) {
  const part = tables.length + 1;
  const name = `${definition.tableName} - Phần ${part}`;
  if (allTables.some((table) => String(table.name ?? '').trim() === name)) {
    throw new Error(`LARK_PART_REGISTRY_STALE:${definition.key}`);
  }
  const table = await runtime.lark.createTable(name, allFields(definition));
  validateSchema(definition, await runtime.lark.listFields(table.table_id));
  const entry = { tableId: table.table_id, name, part, recordCount: 0 };
  tables.push(entry);
  allTables.push(table);
  return entry;
}

async function applyCreates(runtime, dbClient, definition, entries, tables, allTables) {
  const state = [];
  let current = tables.at(-1);
  if (!definition.partitionAt && current.recordCount + entries.length > 15_000) {
    throw new Error(`LARK_TABLE_CAPACITY_GUARD:${definition.key}`);
  }
  for (let index = 0; index < entries.length;) {
    if (definition.partitionAt && current.recordCount >= definition.partitionAt) {
      current = await createNextPart(runtime, definition, tables, allTables);
    }
    const remainingCapacity = definition.partitionAt
      ? definition.partitionAt - current.recordCount
      : runtime.batchSize;
    const size = Math.min(runtime.batchSize, remainingCapacity, entries.length - index);
    const batch = entries.slice(index, index + size);
    const response = await runtime.lark.createRecords(current.tableId, batch.map((entry) => ({
      fields: entry.expected.larkFields,
    })));
    const created = response.records ?? [];
    if (created.length !== batch.length) throw new Error(`LARK_CREATE_READBACK_COUNT:${definition.key}`);
    for (let offset = 0; offset < batch.length; offset += 1) {
      state.push(stateRow(
        definition.key,
        batch[offset],
        current.tableId,
        created[offset].record_id,
      ));
    }
    await upsertState(dbClient, state.splice(0));
    current.recordCount += batch.length;
    index += batch.length;
  }
}

async function applyUpdates(runtime, dbClient, definition, entries) {
  for (let index = 0; index < entries.length; index += runtime.batchSize) {
    const batch = entries.slice(index, index + runtime.batchSize);
    await runtime.lark.updateRecords(batch[0].existing.tableId, batch.map((entry) => ({
      record_id: entry.existing.record_id,
      fields: buildUpdateFields(definition, entry.expected),
    })));
    await upsertState(dbClient, batch.map((entry) => stateRow(
      definition.key,
      entry,
      entry.existing.tableId,
      entry.existing.record_id,
    )));
  }
}

export function buildUpdateFields(definition, expected) {
  const fields = { ...expected.larkFields };
  for (const field of definition.fields) {
    if (!Object.hasOwn(expected.sourceFields, field.name)) fields[field.name] = null;
  }
  return fields;
}

async function applyTombstones(runtime, dbClient, definition, entries, syncedAt) {
  const byTable = Map.groupBy(entries, (entry) => entry.tableId);
  for (const [tableId, tableEntries] of byTable) {
    for (let index = 0; index < tableEntries.length; index += runtime.batchSize) {
      const batch = tableEntries.slice(index, index + runtime.batchSize);
      await runtime.lark.updateRecords(tableId, batch.map((entry) => ({
        record_id: entry.record_id,
        fields: {
          'Trạng thái nguồn': 'Không còn trong nguồn',
          'Mã kiểm tra nguồn': checksum({
            key: textValue(entry.fields?.['Khóa đồng bộ']),
            sourceStatus: 'Không còn trong nguồn',
          }),
          'Đồng bộ lên Lark lúc': syncedAt,
        },
      })));
      await upsertState(dbClient, batch.map((entry) => ({
        dataset: definition.key,
        source_key: textValue(entry.fields?.['Khóa đồng bộ']),
        lark_table_id: tableId,
        lark_record_id: entry.record_id,
        source_checksum: textValue(entry.fields?.['Mã kiểm tra nguồn']) || 'tombstone',
        source_updated_at: new Date().toISOString(),
        source_present: false,
      })));
    }
  }
}

async function syncDataset(runtime, dbClient, definition, tables, allTables, options) {
  const source = await sourceRows(dbClient, definition, options);
  const sourceTotal = await totalSourceRows(dbClient, definition, options.classId);
  const lark = await listReplicaRecords(runtime.lark, tables, definition.key);
  const syncedAt = Date.now();
  const creates = [];
  const updates = [];
  const unchanged = [];
  const sourceKeys = new Set();

  for (const row of source) {
    sourceKeys.add(row.source_key);
    const expected = buildExpected(definition, row, syncedAt);
    const entry = { row, expected, existing: lark.byKey.get(row.source_key) };
    if (!entry.existing) creates.push(entry);
    else if (recordHasDrift(definition, expected, entry.existing.fields)) updates.push(entry);
    else unchanged.push(entry);
  }

  const tombstones = options.full && options.classId === null
    ? lark.records.filter((record) => !sourceKeys.has(textValue(record.fields?.['Khóa đồng bộ']))
      && textValue(record.fields?.['Trạng thái nguồn']) !== 'Không còn trong nguồn')
    : [];

  guardAnomalies(runtime, {
    existingCount: lark.records.length,
    createCount: creates.length,
    updateCount: updates.length,
    tombstoneCount: tombstones.length,
    allowBaseline: options.allowBaseline,
  });

  if (!options.dryRun) {
    const updatesByTable = Map.groupBy(updates, (entry) => entry.existing.tableId);
    for (const tableEntries of updatesByTable.values()) {
      await applyUpdates(runtime, dbClient, definition, tableEntries);
    }
    await applyCreates(runtime, dbClient, definition, creates, tables, allTables);
    await applyTombstones(runtime, dbClient, definition, tombstones, syncedAt);
    await upsertState(dbClient, unchanged.map((entry) => stateRow(
      definition.key,
      entry,
      entry.existing.tableId,
      entry.existing.record_id,
    )));
  }

  const stats = {
    source: sourceTotal,
    considered: source.length,
    created: creates.length,
    updated: updates.length,
    tombstoned: tombstones.length,
    skipped: unchanged.length,
  };
  log('dataset_checked', { dataset: definition.key, ...stats, dryRun: options.dryRun });
  return stats;
}

function statusFields(dataset, stats, context) {
  return {
    'Khóa đồng bộ': `status:${dataset.key}`,
    'Bảng dữ liệu': dataset.tableName,
    'Trạng thái lần chạy': 'Thành công',
    'Chế độ': context.mode,
    'Số dòng nguồn': stats.source,
    'Số dòng tạo mới': stats.created,
    'Số dòng cập nhật': stats.updated,
    'Số dòng ngừng trong nguồn': stats.tombstoned,
    'Số dòng bỏ qua': stats.skipped,
    'Bắt đầu lúc': context.startedAt,
    'Kết thúc lúc': context.finishedAt,
    'Mã lỗi gần nhất': '',
    'Thông báo vận hành': 'PostgreSQL là nguồn chuẩn; Lark là bản sao một chiều.',
    'Trạng thái nguồn': 'Đang có trong nguồn',
    'Cập nhật tại PostgreSQL': context.finishedAt,
    'Mã kiểm tra nguồn': checksum({ dataset: dataset.key, stats, finishedAt: context.finishedAt }),
    'Đồng bộ lên Lark lúc': context.finishedAt,
  };
}

async function writeStatus(runtime, table, statsByDataset, context) {
  const existing = await runtime.lark.listRecords(table.tableId);
  const byKey = new Map(existing.map((record) => [
    textValue(record.fields?.['Khóa đồng bộ']),
    record,
  ]));
  const creates = [];
  const updates = [];
  for (const dataset of DATASETS) {
    const fields = statusFields(dataset, statsByDataset[dataset.key], context);
    const record = byKey.get(fields['Khóa đồng bộ']);
    if (record) updates.push({ record_id: record.record_id, fields });
    else creates.push({ fields });
  }
  if (updates.length) await runtime.lark.updateRecords(table.tableId, updates);
  if (creates.length) await runtime.lark.createRecords(table.tableId, creates);
}

async function startRun(client, mode) {
  const result = await client.query(`
    INSERT INTO mapping.lark_replica_run (mode, status)
    VALUES ($1, 'running')
    RETURNING id, run_key, started_at
  `, [mode]);
  return result.rows[0];
}

async function finishRun(client, runId, status, stats, errorCode = null) {
  await client.query(`
    UPDATE mapping.lark_replica_run
    SET status = $2,
        finished_at = now(),
        dataset_stats = $3::jsonb,
        error_code = $4,
        error_message = $4
    WHERE id = $1
  `, [runId, status, JSON.stringify(stats), errorCode]);
}

export async function runSync(runtime, {
  mode = 'incremental',
  full = false,
  dryRun = false,
  classId = null,
  onlyDataset = null,
} = {}) {
  const dbClient = await runtime.pool.connect();
  let locked = false;
  let run;
  const stats = {};
  try {
    const lockResult = await dbClient.query(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_NAMESPACE, LOCK_KEY],
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) {
      log('run_skipped_locked');
      return { skipped: true };
    }
    run = await startRun(dbClient, mode);
    const cursor = full ? null : await lastSuccessfulCursor(dbClient);
    const baselineResult = await dbClient.query(`
      SELECT EXISTS (
        SELECT 1
        FROM mapping.lark_replica_run
        WHERE status = 'completed'
          AND mode IN ('full', 'incremental')
      ) AS exists
    `);
    const allowBaseline = baselineResult.rows[0]?.exists !== true;
    const { registry, tables: allTables } = await resolveManagedTables(runtime.lark);
    const selected = onlyDataset
      ? DATASETS.filter((dataset) => dataset.key === onlyDataset)
      : DATASETS;
    if (!selected.length) throw new Error('DATASET_NOT_FOUND');
    for (const definition of selected) {
      stats[definition.key] = await syncDataset(
        runtime,
        dbClient,
        definition,
        registry.get(definition.key),
        allTables,
        { full, dryRun, classId, cursor, allowBaseline },
      );
    }
    for (const definition of DATASETS) {
      stats[definition.key] ??= {
        source: 0,
        considered: 0,
        created: 0,
        updated: 0,
        tombstoned: 0,
        skipped: 0,
      };
    }
    if (!dryRun) {
      await writeStatus(runtime, registry.get(STATUS_TABLE.key)[0], stats, {
        mode,
        startedAt: new Date(run.started_at).getTime(),
        finishedAt: Date.now(),
      });
    }
    await finishRun(dbClient, run.id, 'completed', stats);
    log('run_completed', { mode, runKey: run.run_key, dryRun, classId, stats });
    return { runKey: run.run_key, stats };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    if (run) await finishRun(dbClient, run.id, 'failed', stats, errorCode).catch(() => {});
    log('run_failed', { mode, errorCode });
    throw error;
  } finally {
    if (locked) {
      await dbClient.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_KEY])
        .catch(() => {});
    }
    dbClient.release();
  }
}

function parseArguments(argv) {
  const args = new Set(argv);
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const classRaw = valueAfter('--class-id');
  const classId = classRaw === null ? null : Number(classRaw);
  if (classRaw !== null && (!Number.isInteger(classId) || classId <= 0)) {
    throw new Error('INVALID_CLASS_ID');
  }
  return {
    bootstrap: args.has('--bootstrap'),
    smokeTest: args.has('--smoke-test'),
    schedule: args.has('--schedule'),
    dryRun: args.has('--dry-run'),
    full: args.has('--full') || args.has('--dry-run'),
    classId,
    onlyDataset: valueAfter('--dataset'),
  };
}

function vietnamTimeParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
}

async function schedule(runtime) {
  let lastSlot = null;
  let running = false;
  const tick = async () => {
    const parts = vietnamTimeParts();
    const time = `${parts.hour}:${parts.minute}`;
    const scheduleMode = SCHEDULE_SLOTS.get(time);
    const slot = `${parts.year}-${parts.month}-${parts.day}T${time}`;
    if (!scheduleMode || slot === lastSlot || running) return;
    lastSlot = slot;
    running = true;
    try {
      await runSync(runtime, {
        mode: scheduleMode,
        full: scheduleMode === 'full',
      });
    } catch {
      // Lỗi đã được ghi bằng mã an toàn. Process tiếp tục chờ lịch sau, không chạy bù dồn dập.
    } finally {
      running = false;
    }
  };
  await tick();
  const timer = setInterval(tick, 15_000);
  log('scheduler_started', { timezone: 'Asia/Ho_Chi_Minh', slots: [...SCHEDULE_SLOTS.keys()] });
  await new Promise((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  clearInterval(timer);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const runtime = buildRuntime();
  try {
    if (options.smokeTest) await smokeTest(runtime);
    if (options.bootstrap) await bootstrap(runtime);
    if (options.schedule) {
      await schedule(runtime);
      return;
    }
    if (!options.smokeTest && !options.bootstrap) {
      const mode = options.dryRun
        ? 'dry_run'
        : options.classId !== null
          ? 'canary'
          : options.full
            ? 'full'
            : 'incremental';
      await runSync(runtime, { ...options, mode });
    }
  } finally {
    await runtime.pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log('process_failed', { errorCode: safeErrorCode(error) });
    process.exitCode = 1;
  });
}
