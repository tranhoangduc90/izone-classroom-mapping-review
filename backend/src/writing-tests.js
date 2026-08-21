// Module này giữ toàn bộ đồng hồ chờ và trạng thái ghép điểm Writing trong PostgreSQL.
// Đầu vào chỉ gồm ID kỹ thuật, điểm Band và thời gian; không nhận bài viết hay nhận xét chấm.

export class WritingTestError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.name = 'WritingTestError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sameBand(left, right) {
  return left !== null && right !== null && Math.abs(Number(left) - Number(right)) < 0.001;
}

function shouldReplaceComponent(currentScoredAt, incomingScoredAt) {
  const current = dateOrNull(currentScoredAt);
  const incoming = dateOrNull(incomingScoredAt);
  return !current || !incoming || incoming.getTime() >= current.getTime();
}

export function validateBand(value) {
  const band = Number(value);
  if (!Number.isFinite(band) || band < 0 || band > 9 || Math.round(band * 2) !== band * 2) {
    throw new WritingTestError('WRITING_INVALID_SCORE', 'Điểm Writing phải từ 0 đến 9 và theo bước 0,5.', 400);
  }
  return band;
}

export function calculateWritingOverall(task1, task2) {
  const first = validateBand(task1);
  const second = validateBand(task2);
  return Math.ceil((((first + (2 * second)) / 3) * 2) - 1e-9) / 2;
}

function buildNextState(current, source, definition, input, receivedAt) {
  const incomingScore = validateBand(input.score);
  const incomingScoredAt = dateOrNull(input.scoredAt) ?? receivedAt;
  const next = {
    directScore: numericOrNull(current?.direct_score),
    task1Score: numericOrNull(current?.task1_score),
    task2Score: numericOrNull(current?.task2_score),
    directSourceRecordId: current?.direct_source_record_id ?? null,
    task1SourceRecordId: current?.task1_source_record_id ?? null,
    task2SourceRecordId: current?.task2_source_record_id ?? null,
    directScoredAt: dateOrNull(current?.direct_scored_at),
    task1ScoredAt: dateOrNull(current?.task1_scored_at),
    task2ScoredAt: dateOrNull(current?.task2_scored_at),
    firstScoreAt: dateOrNull(current?.first_score_at) ?? receivedAt,
    expiresAt: dateOrNull(current?.expires_at),
    writingOverall: numericOrNull(current?.writing_overall),
    missingComponent: current?.missing_component ?? null,
    status: current?.status ?? 'waiting',
    usedZero: Boolean(current?.used_zero),
    lastPortalGrade: numericOrNull(current?.last_portal_grade)
  };

  const fieldPrefix = source.component === 'direct' ? 'direct' : source.component;
  const scoredAtKey = `${fieldPrefix}ScoredAt`;
  if (shouldReplaceComponent(next[scoredAtKey], incomingScoredAt)) {
    next[`${fieldPrefix}Score`] = incomingScore;
    next[`${fieldPrefix}SourceRecordId`] = input.sourceRecordId;
    next[scoredAtKey] = incomingScoredAt;
  }

  if (definition.aggregation_mode === 'direct') {
    if (source.component !== 'direct' || next.directScore === null) {
      throw new WritingTestError('WRITING_SOURCE_COMPONENT_MISMATCH', 'Nguồn điểm không khớp cấu hình kỳ test.');
    }
    next.expiresAt = null;
    next.writingOverall = next.directScore;
    next.missingComponent = null;
  } else {
    if (!['task1', 'task2'].includes(source.component)) {
      throw new WritingTestError('WRITING_SOURCE_COMPONENT_MISMATCH', 'Nguồn điểm không khớp cấu hình kỳ test.');
    }
    next.expiresAt ??= new Date(next.firstScoreAt.getTime() + (Number(definition.wait_minutes) * 60_000));
    if (next.task1Score === null || next.task2Score === null) {
      next.writingOverall = null;
      next.missingComponent = next.task1Score === null ? 'task1' : 'task2';
      next.status = current?.status === 'paused' ? 'paused' : 'waiting';
      return next;
    }
    next.writingOverall = calculateWritingOverall(next.task1Score, next.task2Score);
    next.missingComponent = null;
  }

  if (sameBand(next.writingOverall, next.lastPortalGrade)) next.status = 'synced';
  else if (next.lastPortalGrade !== null) next.status = 'ready_late';
  else next.status = 'ready';
  return next;
}

function serializeResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    testKey: row.test_key,
    displayName: row.display_name,
    portalTestName: row.portal_test_name,
    courseNumber: Number(row.course_number),
    testNumber: Number(row.test_number),
    aggregationMode: row.aggregation_mode,
    classId: String(row.erp_course_class_id),
    studentId: String(row.erp_student_contact_id),
    googleUserId: row.google_user_id,
    className: row.class_name_snapshot,
    studentName: row.student_name_snapshot,
    directScore: numericOrNull(row.direct_score),
    task1Score: numericOrNull(row.task1_score),
    task2Score: numericOrNull(row.task2_score),
    directSourceRecordId: row.direct_source_record_id,
    task1SourceRecordId: row.task1_source_record_id,
    task2SourceRecordId: row.task2_source_record_id,
    directScoredAt: row.direct_scored_at,
    task1ScoredAt: row.task1_scored_at,
    task2ScoredAt: row.task2_scored_at,
    firstScoreAt: row.first_score_at,
    expiresAt: row.expires_at,
    writingOverall: numericOrNull(row.writing_overall),
    missingComponent: row.missing_component,
    status: row.status,
    usedZero: Boolean(row.used_zero),
    larkRecordId: row.lark_record_id,
    lastPortalGrade: numericOrNull(row.last_portal_grade),
    portalSyncedAt: row.portal_synced_at,
    lastErrorCode: row.last_error_code,
    updatedAt: row.updated_at,
    allowOverwrite: row.last_portal_grade !== null
      && row.writing_overall !== null
      && !sameBand(numericOrNull(row.writing_overall), numericOrNull(row.last_portal_grade))
  };
}

async function inTransaction(pool, handler) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Lỗi gốc quan trọng hơn lỗi rollback. */ }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === 'function') client.release();
  }
}

async function insertResolutionEvent(client, input, details) {
  const result = await client.query(`INSERT INTO assessment.writing_test_event (
    idempotency_key, result_id, classroom_course_id, classroom_coursework_id,
    google_user_id, source_record_id, component, score, scored_at,
    resolution_status, error_code
  ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9::timestamptz, $10, $11)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id::text;`, [
    input.idempotencyKey,
    details.resultId ?? null,
    input.classroomCourseId,
    input.classroomCourseworkId,
    input.googleUserId,
    input.sourceRecordId,
    details.component ?? null,
    input.score,
    input.scoredAt,
    details.resolutionStatus,
    details.errorCode ?? null
  ]);
  return result.rows.length === 1;
}

export function createWritingTestService({ pool, now = () => new Date() }) {
  async function receiveScore(input) {
    return inTransaction(pool, async client => {
      const duplicate = await client.query(
        'SELECT result_id::text, resolution_status, error_code FROM assessment.writing_test_event WHERE idempotency_key = $1;',
        [input.idempotencyKey]
      );
      if (duplicate.rows.length === 1 && duplicate.rows[0].resolution_status === 'stored') {
        return { ok: true, status: 'duplicate', resultId: duplicate.rows[0].result_id };
      }
      if (duplicate.rows.length === 1) {
        // Sự kiện từng thiếu cấu hình/mapping được phép thử lại sau khi dữ liệu nền đã được sửa.
        await client.query('DELETE FROM assessment.writing_test_event WHERE idempotency_key = $1;', [input.idempotencyKey]);
      }

      const sourceResult = await client.query(`SELECT
        source.classroom_course_id,
        source.classroom_coursework_id,
        source.test_key,
        source.component,
        definition.course_number,
        definition.test_number,
        definition.display_name,
        definition.portal_test_name,
        definition.aggregation_mode,
        definition.wait_minutes
      FROM assessment.writing_test_source AS source
      JOIN assessment.writing_test_definition AS definition USING (test_key)
      WHERE source.classroom_course_id = $1
        AND source.classroom_coursework_id = $2
        AND source.enabled = true
        AND definition.enabled = true;`, [input.classroomCourseId, input.classroomCourseworkId]);
      if (sourceResult.rows.length !== 1) {
        await insertResolutionEvent(client, input, {
          resolutionStatus: 'source_not_configured',
          errorCode: 'WRITING_SOURCE_NOT_CONFIGURED'
        });
        return { ok: false, status: 'source_not_configured', error: 'WRITING_SOURCE_NOT_CONFIGURED' };
      }
      const source = sourceResult.rows[0];

      const identityResult = await client.query(`SELECT
        erp_student_contact_id::text AS student_id,
        COALESCE(erp_name_snapshot, google_name_snapshot, '') AS student_name
      FROM mapping.student_identity_mapping
      WHERE google_user_id = $1 AND status = 'approved';`, [input.googleUserId]);
      if (identityResult.rows.length !== 1) {
        await insertResolutionEvent(client, input, {
          component: source.component,
          resolutionStatus: 'identity_not_mapped',
          errorCode: 'WRITING_IDENTITY_NOT_MAPPED'
        });
        return { ok: false, status: 'identity_not_mapped', error: 'WRITING_IDENTITY_NOT_MAPPED' };
      }
      const identity = identityResult.rows[0];

      // Tìm lớp thật từ dữ liệu mapping hiện tại, không khóa cứng vào một lớp cấu hình.
      // Một học viên chỉ được đi tiếp khi: còn trong lớp ERP, lớp đã ghép Classroom,
      // và đúng tài khoản Google vẫn đang nằm trong roster Classroom của chính lớp đó.
      const classResult = await client.query(`SELECT DISTINCT
        membership.erp_course_class_id::text AS class_id,
        membership.erp_class_name_snapshot AS class_name_snapshot,
        membership.erp_student_name_snapshot AS student_name
      FROM mapping.erp_class_membership_snapshot AS membership
      JOIN mapping.classroom_course_mapping AS course
        ON course.erp_course_class_id = membership.erp_course_class_id
       AND course.status = 'approved'
       AND course.classroom_course_id IS NOT NULL
      JOIN mapping.classroom_roster_snapshot AS roster
        ON roster.classroom_course_id = course.classroom_course_id
       AND roster.classroom_user_id = $2
       AND roster.roster_state = 'active'
      WHERE membership.erp_student_contact_id = $1::bigint
        AND membership.source_state = 'active'
        AND ($3::text IS NULL OR lower(trim(membership.erp_class_name_snapshot)) = lower(trim($3::text)));`, [
        identity.student_id,
        input.googleUserId,
        input.className || null
      ]);
      if (classResult.rows.length !== 1) {
        await insertResolutionEvent(client, input, {
          component: source.component,
          resolutionStatus: 'class_not_resolved',
          errorCode: classResult.rows.length === 0 ? 'WRITING_CLASS_NOT_FOUND' : 'WRITING_CLASS_AMBIGUOUS'
        });
        return {
          ok: false,
          status: 'class_not_resolved',
          error: classResult.rows.length === 0 ? 'WRITING_CLASS_NOT_FOUND' : 'WRITING_CLASS_AMBIGUOUS'
        };
      }
      const targetClass = classResult.rows[0];
      const receivedAt = now();

      await client.query(`INSERT INTO assessment.writing_test_result (
        test_key, erp_course_class_id, erp_student_contact_id, google_user_id,
        class_name_snapshot, student_name_snapshot, first_score_at, status
      ) VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6, $7::timestamptz, 'waiting')
      ON CONFLICT (test_key, erp_course_class_id, erp_student_contact_id) DO NOTHING;`, [
        source.test_key,
        targetClass.class_id,
        identity.student_id,
        input.googleUserId,
        targetClass.class_name_snapshot,
        targetClass.student_name || identity.student_name,
        receivedAt
      ]);

      const locked = await client.query(`SELECT *
      FROM assessment.writing_test_result
      WHERE test_key = $1 AND erp_course_class_id = $2::bigint AND erp_student_contact_id = $3::bigint
      FOR UPDATE;`, [source.test_key, targetClass.class_id, identity.student_id]);
      const next = buildNextState(locked.rows[0], source, source, input, receivedAt);
      const saved = await client.query(`UPDATE assessment.writing_test_result SET
        google_user_id = $2,
        class_name_snapshot = $3,
        student_name_snapshot = $4,
        direct_score = $5::numeric,
        task1_score = $6::numeric,
        task2_score = $7::numeric,
        direct_source_record_id = $8,
        task1_source_record_id = $9,
        task2_source_record_id = $10,
        direct_scored_at = $11::timestamptz,
        task1_scored_at = $12::timestamptz,
        task2_scored_at = $13::timestamptz,
        first_score_at = $14::timestamptz,
        expires_at = $15::timestamptz,
        writing_overall = $16::numeric,
        missing_component = $17,
        status = $18,
        used_zero = $19::boolean,
        last_error_code = NULL,
        last_error_at = NULL,
        updated_at = now()
      WHERE id = $1::uuid
      RETURNING *;`, [
        locked.rows[0].id,
        input.googleUserId,
        targetClass.class_name_snapshot,
        targetClass.student_name || identity.student_name,
        next.directScore,
        next.task1Score,
        next.task2Score,
        next.directSourceRecordId,
        next.task1SourceRecordId,
        next.task2SourceRecordId,
        next.directScoredAt,
        next.task1ScoredAt,
        next.task2ScoredAt,
        next.firstScoreAt,
        next.expiresAt,
        next.writingOverall,
        next.missingComponent,
        next.status,
        next.usedZero
      ]);
      const eventStored = await insertResolutionEvent(client, input, {
        resultId: saved.rows[0].id,
        component: source.component,
        resolutionStatus: 'stored'
      });
      return {
        ok: true,
        status: eventStored ? 'stored' : 'duplicate',
        record: serializeResult({ ...source, ...saved.rows[0] })
      };
    });
  }

  async function processDue() {
    return inTransaction(pool, async client => {
      const due = await client.query(`SELECT result.*, definition.display_name, definition.portal_test_name,
        definition.course_number, definition.test_number, definition.aggregation_mode
      FROM assessment.writing_test_result AS result
      JOIN assessment.writing_test_definition AS definition USING (test_key)
      WHERE result.status IN ('waiting', 'paused')
        AND result.expires_at IS NOT NULL
        AND result.expires_at <= now()
      ORDER BY result.expires_at
      FOR UPDATE OF result SKIP LOCKED;`);
      if (due.rows.length === 0) return { ok: true, processed: [], paused: [] };

      const totals = await client.query(`SELECT test_key, erp_course_class_id::text AS class_id, count(*)::int AS total
      FROM assessment.writing_test_result
      GROUP BY test_key, erp_course_class_id;`);
      const totalMap = new Map(totals.rows.map(row => [`${row.test_key}:${row.class_id}`, Number(row.total)]));
      const groups = new Map();
      for (const row of due.rows) {
        const key = `${row.test_key}:${row.erp_course_class_id}:${row.missing_component}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      const processed = [];
      const paused = [];
      for (const rows of groups.values()) {
        const sample = rows[0];
        const total = totalMap.get(`${sample.test_key}:${sample.erp_course_class_id}`) ?? rows.length;
        const circuitOpen = rows.length >= 3 && (rows.length / Math.max(total, 1)) >= 0.2;
        for (const row of rows) {
          if (circuitOpen) {
            const updated = await client.query(`UPDATE assessment.writing_test_result
            SET status = 'paused', last_error_code = 'WRITING_MASS_MISSING_SUSPECTED',
                last_error_at = now(), updated_at = now()
            WHERE id = $1::uuid RETURNING *;`, [row.id]);
            paused.push(serializeResult({ ...row, ...updated.rows[0] }));
            continue;
          }

          const task1 = numericOrNull(row.task1_score) ?? 0;
          const task2 = numericOrNull(row.task2_score) ?? 0;
          const overall = calculateWritingOverall(task1, task2);
          const previousGrade = numericOrNull(row.last_portal_grade);
          const status = previousGrade === null ? 'ready_zero' : (sameBand(previousGrade, overall) ? 'synced' : 'ready_late');
          const updated = await client.query(`UPDATE assessment.writing_test_result
          SET writing_overall = $2::numeric, status = $3, used_zero = true,
              last_error_code = NULL, last_error_at = NULL, updated_at = now()
          WHERE id = $1::uuid RETURNING *;`, [row.id, overall, status]);
          processed.push(serializeResult({ ...row, ...updated.rows[0] }));
        }
      }
      return { ok: true, processed, paused };
    });
  }

  async function listRecords() {
    const result = await pool.query(`SELECT result.*, definition.display_name, definition.portal_test_name,
      definition.course_number, definition.test_number, definition.aggregation_mode
    FROM assessment.writing_test_result AS result
    JOIN assessment.writing_test_definition AS definition USING (test_key)
    ORDER BY result.updated_at DESC;`);
    return result.rows.map(serializeResult);
  }

  async function markPortalResult(input) {
    return inTransaction(pool, async client => {
      const locked = await client.query(`SELECT result.*, definition.display_name, definition.portal_test_name,
        definition.course_number, definition.test_number, definition.aggregation_mode
      FROM assessment.writing_test_result AS result
      JOIN assessment.writing_test_definition AS definition USING (test_key)
      WHERE result.id = $1::uuid FOR UPDATE OF result;`, [input.resultId]);
      if (locked.rows.length !== 1) {
        throw new WritingTestError('WRITING_RESULT_NOT_FOUND', 'Không tìm thấy kết quả Writing.', 404);
      }
      const row = locked.rows[0];
      const expected = validateBand(input.expectedGrade);
      if (!sameBand(expected, numericOrNull(row.writing_overall))) {
        throw new WritingTestError('WRITING_RESULT_CHANGED', 'Điểm đã thay đổi trước khi xác nhận Portal.');
      }
      const status = input.success ? 'synced' : (input.conflict ? 'conflict' : 'error');
      const updated = await client.query(`UPDATE assessment.writing_test_result SET
        status = $2,
        lark_record_id = COALESCE($3, lark_record_id),
        last_portal_grade = CASE WHEN $4::boolean THEN $5::numeric ELSE last_portal_grade END,
        portal_synced_at = CASE WHEN $4::boolean THEN now() ELSE portal_synced_at END,
        last_error_code = CASE WHEN $4::boolean THEN NULL ELSE $6 END,
        last_error_at = CASE WHEN $4::boolean THEN NULL ELSE now() END,
        updated_at = now()
      WHERE id = $1::uuid RETURNING *;`, [
        input.resultId,
        status,
        input.larkRecordId ?? null,
        input.success,
        expected,
        input.errorCode ?? 'WRITING_PORTAL_SYNC_FAILED'
      ]);
      return serializeResult({ ...row, ...updated.rows[0] });
    });
  }

  async function syncConfig(items) {
    return inTransaction(pool, async client => {
      const saved = [];
      for (const item of items) {
        await client.query(`UPDATE assessment.writing_test_definition SET
          display_name = $2,
          portal_test_name = $3,
          aggregation_mode = $4,
          wait_minutes = $5::integer,
          enabled = $6::boolean,
          config_version = CASE WHEN
            display_name IS DISTINCT FROM $2
            OR portal_test_name IS DISTINCT FROM $3
            OR aggregation_mode IS DISTINCT FROM $4
            OR wait_minutes IS DISTINCT FROM $5::integer
            OR enabled IS DISTINCT FROM $6::boolean
          THEN config_version + 1 ELSE config_version END,
          lark_config_record_id = $7,
          updated_at = now()
        WHERE test_key = $1;`, [
          item.testKey,
          item.displayName,
          item.portalTestName,
          item.aggregationMode,
          item.waitMinutes,
          item.definitionEnabled,
          item.larkConfigRecordId
        ]);
        await client.query(`INSERT INTO assessment.writing_test_source (
          classroom_course_id, classroom_coursework_id, test_key, component,
          source_title_snapshot, enabled, lark_config_record_id
        ) VALUES ($1, $2, $3, $4, $5, $6::boolean, $7)
        ON CONFLICT (classroom_course_id, classroom_coursework_id) DO UPDATE SET
          test_key = EXCLUDED.test_key,
          component = EXCLUDED.component,
          source_title_snapshot = EXCLUDED.source_title_snapshot,
          enabled = EXCLUDED.enabled,
          lark_config_record_id = EXCLUDED.lark_config_record_id,
          updated_at = now();`, [
          item.classroomCourseId,
          item.classroomCourseworkId,
          item.testKey,
          item.component,
          item.sourceTitle,
          item.sourceEnabled,
          item.larkConfigRecordId
        ]);
        // classId cũ vẫn được chấp nhận để tương thích dữ liệu đã tạo,
        // nhưng luồng mới không dùng phạm vi lớp tĩnh để quyết định nơi ghi điểm.
        if (item.classId && item.className) {
          await client.query(`INSERT INTO assessment.writing_test_class_scope (
            test_key, erp_course_class_id, class_name_snapshot, enabled, lark_config_record_id
          ) VALUES ($1, $2::bigint, $3, false, $4)
          ON CONFLICT (test_key, erp_course_class_id) DO UPDATE SET
            class_name_snapshot = EXCLUDED.class_name_snapshot,
            enabled = false,
            lark_config_record_id = EXCLUDED.lark_config_record_id,
            updated_at = now();`, [
            item.testKey,
            item.classId,
            item.className,
            item.larkConfigRecordId
          ]);
        }
        saved.push({ testKey: item.testKey, component: item.component, larkConfigRecordId: item.larkConfigRecordId });
      }
      return saved;
    });
  }

  return { receiveScore, processDue, listRecords, markPortalResult, syncConfig };
}
