import { randomUUID } from 'node:crypto';

// Dữ liệu vào: lượt ERP K56 hoàn tất trong mapping_db và roster hiện có.
// Việc chính: đối soát bằng ID ERP, thêm học viên/lớp mới và mở đúng ba đề K56.
// Kết quả: một giao dịch giữ UUID/bài cũ, ghi checkpoint sau khi đọc lại.
// Khi lỗi hoặc phạm vi giảm: rollback; log chỉ có mã lỗi và số đếm, không có hồ sơ.
const SOURCE = 'n8n_k56_erp_ongoing';
const SLUGS = Object.freeze(['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56']);

export class K56RosterReconcileError extends Error {
  constructor(code) {
    super(code);
    this.name = 'K56RosterReconcileError';
    this.code = code;
  }
}

const requireGate = (condition, code) => {
  if (!condition) throw new K56RosterReconcileError(code);
};
const rosterKey = row => `${row.test_slug}:${row.class_id}:${row.contact_id}`;
const memberKey = row => `${row.class_id}:${row.contact_id}`;
const accessKey = row => `${row.test_slug}:${row.class_id}`;

function unique(rows, keyOf, code) {
  const result = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    requireGate(!result.has(key), code);
    result.set(key, row);
  }
  return result;
}

async function readState(client) {
  const roster = (await client.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id,
    erp_student_contact_id::text AS contact_id,
    student_ref::text AS student_ref, is_eligible
    FROM assessment.term_test_roster
    WHERE test_slug = ANY($1::text[])`, [SLUGS])).rows;
  const access = (await client.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id, enabled
    FROM assessment.term_test_class_access
    WHERE test_slug = ANY($1::text[])`, [SLUGS])).rows;
  return {
    roster: unique(roster, rosterKey, 'K56_DUPLICATE_ROSTER'),
    access: unique(access, accessKey, 'K56_DUPLICATE_ACCESS')
  };
}

export async function reconcileK56Roster(pool, {
  dryRun = false,
  expectedDatabase = 'mapping_db',
  now = new Date()
} = {}) {
  requireGate(expectedDatabase === 'mapping_db' || expectedDatabase === 'pglite_shared_test',
    'K56_WRONG_TARGET');
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '45s'");
    const database = (await client.query('SELECT current_database() AS name')).rows[0]?.name;
    requireGate(database === expectedDatabase, 'K56_WRONG_DATABASE');
    await client.query(`LOCK TABLE assessment.term_test_roster,
      assessment.term_test_class_access, assessment.k56_roster_sync_checkpoint
      IN SHARE ROW EXCLUSIVE MODE`);

    const runs = (await client.query(`SELECT run.id::text AS id, run.status,
      run.class_names, run.row_count, run.finished_at, run.error_message
      FROM mapping.sync_run AS run
      WHERE run.source = $1 ORDER BY run.id DESC LIMIT 2`, [SOURCE])).rows;
    const run = runs[0];
    requireGate(run?.status === 'completed' && !run.error_message,
      'K56_SOURCE_NOT_COMPLETE');
    const ageMs = new Date(now).getTime() - new Date(run.finished_at).getTime();
    requireGate(Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 36 * 3600_000,
      'K56_SOURCE_STALE');
    const codes = run.class_names?.map(code => String(code).toUpperCase());
    requireGate(Array.isArray(codes) && codes.length > 0
      && new Set(codes).size === codes.length
      && codes.every(code => /^IC\d+$/.test(code)), 'K56_CLASS_SCOPE_INVALID');
    if (runs[1]?.status === 'completed') {
      requireGate(codes.length * 10 >= runs[1].class_names.length * 7
        && Number(run.row_count) * 10 >= Number(runs[1].row_count) * 7,
      'K56_SOURCE_SCOPE_DROPPED');
    }
    const checkpoint = (await client.query(`SELECT last_sync_run_id::text AS id
      FROM assessment.k56_roster_sync_checkpoint WHERE source_name = $1`,
    [SOURCE])).rows[0]?.id;
    requireGate(!checkpoint || BigInt(run.id) >= BigInt(checkpoint),
      'K56_OLDER_SOURCE_RUN');
    const mappings = (await client.query(`SELECT erp_course_class_id::text AS class_id,
      upper(erp_class_name_snapshot) AS class_code
      FROM mapping.classroom_course_mapping
      WHERE upper(erp_class_name_snapshot) = ANY($1::text[])`, [codes])).rows;
    const classes = unique(mappings, row => row.class_id, 'K56_CLASS_ID_CONFLICT');
    requireGate(classes.size === codes.length
      && new Set(mappings.map(row => row.class_code)).size === codes.length
      && mappings.every(row => codes.includes(row.class_code)),
    'K56_CLASS_MAPPING_MISMATCH');
    const membersAll = (await client.query(`SELECT
      erp_course_class_id::text AS class_id,
      upper(erp_class_name_snapshot) AS class_code,
      erp_student_contact_id::text AS contact_id,
      erp_student_name_snapshot AS student_name,
      source_state, registration_status
      FROM mapping.erp_class_membership_snapshot
      WHERE sync_run_id = $1`, [run.id])).rows;
    requireGate(membersAll.length === Number(run.row_count)
      && membersAll.every(row => classes.get(row.class_id)?.class_code === row.class_code),
    'K56_SOURCE_ROWS_MISMATCH');
    const eligible = membersAll.filter(row => row.source_state === 'active'
      && row.registration_status === 'on_going');
    const members = unique(eligible, memberKey, 'K56_DUPLICATE_MEMBER');
    requireGate(members.size > 0 && eligible.every(row => /^\d+$/.test(row.contact_id)
      && typeof row.student_name === 'string' && row.student_name.trim()),
    'K56_MEMBER_INVALID');
    const countByClass = new Map([...classes.keys()].map(id => [id, 0]));
    for (const row of eligible) countByClass.set(row.class_id, countByClass.get(row.class_id) + 1);
    requireGate([...countByClass.values()].every(count => count > 0),
      'K56_EMPTY_CLASS_ROSTER');
    const definitions = (await client.query(`SELECT slug FROM assessment.test_definition
      WHERE slug = ANY($1::text[]) AND is_active = true`, [SLUGS])).rows;
    requireGate(definitions.length === SLUGS.length
      && new Set(definitions.map(row => row.slug)).size === SLUGS.length,
    'K56_DEFINITIONS_NOT_READY');

    const before = await readState(client);
    requireGate([...before.roster.values()].every(row => SLUGS.includes(row.test_slug)
      && /^[0-9a-f-]{36}$/i.test(row.student_ref)), 'K56_ROSTER_INVALID');
    const departing = [...before.roster.values()].filter(row => row.is_eligible
      && !members.has(memberKey(row))).length;
    const closing = [...before.access.values()].filter(row => row.enabled
      && !classes.has(row.class_id)).length;
    requireGate(departing === 0 && closing === 0, 'K56_MANUAL_REVIEW_REQUIRED');
    if (checkpoint === run.id) {
      requireGate(SLUGS.every(slug => [...members.values()].every(member =>
        before.roster.get(`${slug}:${memberKey(member)}`)?.is_eligible === true)
        && [...classes.keys()].every(id => before.access.get(`${slug}:${id}`)?.enabled === true)),
      'K56_CHECKPOINT_TARGET_DRIFT');
      await client.query('ROLLBACK');
      inTransaction = false;
      return { businessOutcome: 'already_reconciled', syncRunId: run.id,
        rosterRowsAdded: 0, classTestPairsEnabled: 0, productionWrites: 0 };
    }

    let rosterRowsAdded = 0;
    let rosterRowsReactivated = 0;
    let classTestPairsEnabled = 0;
    for (const slug of SLUGS) {
      for (const member of members.values()) {
        const key = `${slug}:${memberKey(member)}`;
        const old = before.roster.get(key);
        if (!old) {
          await client.query(`INSERT INTO assessment.term_test_roster
            (test_slug, erp_course_class_id, erp_student_contact_id,
              student_ref, student_name_snapshot, is_eligible)
            VALUES ($1, $2, $3, $4, $5, true)`,
          [slug, member.class_id, member.contact_id, randomUUID(), member.student_name]);
          rosterRowsAdded += 1;
        } else if (!old.is_eligible) {
          await client.query(`UPDATE assessment.term_test_roster SET is_eligible = true
            WHERE test_slug = $1 AND erp_course_class_id = $2
              AND erp_student_contact_id = $3 AND is_eligible = false`,
          [slug, member.class_id, member.contact_id]);
          rosterRowsReactivated += 1;
        }
      }
      for (const row of classes.values()) {
        const old = before.access.get(`${slug}:${row.class_id}`);
        if (!old) {
          await client.query(`INSERT INTO assessment.term_test_class_access
            (test_slug, erp_course_class_id, enabled, source)
            VALUES ($1, $2, true, $3)`, [slug, row.class_id, 'k56_erp_ongoing_sync']);
          classTestPairsEnabled += 1;
        } else if (!old.enabled) {
          await client.query(`UPDATE assessment.term_test_class_access
            SET enabled = true, updated_at = now()
            WHERE test_slug = $1 AND erp_course_class_id = $2 AND enabled = false`,
          [slug, row.class_id]);
          classTestPairsEnabled += 1;
        }
      }
    }
    const after = await readState(client);
    requireGate(after.roster.size === before.roster.size + rosterRowsAdded
      && after.access.size === before.access.size + classTestPairsEnabled
        - [...before.access.values()].filter(row => !row.enabled
          && classes.has(row.class_id)).length,
    'K56_READBACK_COUNTS_MISMATCH');
    requireGate([...before.roster].every(([key, old]) =>
      after.roster.get(key)?.student_ref === old.student_ref)
      && SLUGS.every(slug => [...members.values()].every(member =>
        after.roster.get(`${slug}:${memberKey(member)}`)?.is_eligible === true)
        && [...classes.keys()].every(id => after.access.get(`${slug}:${id}`)?.enabled === true)),
    'K56_READBACK_IDENTITY_MISMATCH');
    await client.query(`INSERT INTO assessment.k56_roster_sync_checkpoint
      (source_name, last_sync_run_id) VALUES ($1, $2)
      ON CONFLICT (source_name) DO UPDATE SET
        last_sync_run_id = EXCLUDED.last_sync_run_id, updated_at = now()`,
    [SOURCE, run.id]);
    const saved = (await client.query(`SELECT last_sync_run_id::text AS id
      FROM assessment.k56_roster_sync_checkpoint WHERE source_name = $1`,
    [SOURCE])).rows[0]?.id;
    requireGate(saved === run.id, 'K56_CHECKPOINT_READBACK_FAILED');
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    inTransaction = false;
    const persistent = (await client.query(`SELECT last_sync_run_id::text AS id
      FROM assessment.k56_roster_sync_checkpoint WHERE source_name = $1`,
    [SOURCE])).rows[0]?.id ?? null;
    requireGate(persistent === (dryRun ? checkpoint ?? null : run.id),
      'K56_PERSISTENT_READBACK_FAILED');
    return { businessOutcome: dryRun ? 'rollback_dry_run_verified' : 'reconciled_verified',
      syncRunId: run.id, classCount: classes.size, eligibleStudents: members.size,
      rosterRowsAdded, rosterRowsReactivated, classTestPairsEnabled,
      productionWrites: dryRun ? 0 : rosterRowsAdded + rosterRowsReactivated
        + classTestPairsEnabled + 1 };
  } catch (error) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch { /* Đọc lại trạng thái trước lần sau. */ }
    }
    throw error instanceof K56RosterReconcileError ? error
      : new K56RosterReconcileError('K56_RECONCILE_TRANSACTION_FAILED');
  } finally {
    client.release();
  }
}

export function startK56RosterReconciler({ pool, enabled = false, pollMs = 300000 }) {
  if (!enabled) return { async stop() {} };
  let stopped = false;
  let running = false;
  let timer;
  let resolveStopped;
  const stoppedPromise = new Promise(resolve => { resolveStopped = resolve; });
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const result = await reconcileK56Roster(pool);
      if (result.businessOutcome === 'reconciled_verified') {
        console.info(`Đã đối soát quyền thi K56: lượt=${result.syncRunId}, lớp=${result.classCount}, `
          + `roster_mới=${result.rosterRowsAdded}, quyền_mới=${result.classTestPairsEnabled}.`);
      }
    } catch (error) {
      console.error(`Đối soát quyền thi K56 cần kiểm tra: ${error.code || 'K56_RECONCILE_FAILED'}`);
    } finally {
      running = false;
      if (stopped) resolveStopped();
      else timer = setTimeout(tick, pollMs).unref();
    }
  }
  timer = setTimeout(tick, 0).unref();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (!running) resolveStopped();
      await stoppedPromise;
    }
  };
}
