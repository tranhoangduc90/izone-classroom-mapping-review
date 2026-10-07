import crypto from 'node:crypto';
import {createJourneyCommentService} from './learning-journey-comments.js';
import { decorateSchedule } from './learning-schedule-plan.js';
import { buildQuestionAnalytics, fetchQuestionAnalyticsSql } from './learning-question-analytics.js';
import { buildCourseOverview, fetchCourseOverviewSql, fetchCourseSessionDetailSql, fetchCourseCurrentRosterSql } from './learning-course-overview.js';
import { withTransaction } from './db.js';
import {
  buildEvidenceEnvelope,
  buildStudentQuizResult,
  buildSubmissionReceipt,
  evaluateCompleteness,
  gradeLearningSubmission,
  sha256,
  stableStringify
} from './learning-domain.js';
import { parseFormDefinition, parseFormGradingKey, parseResponses } from './learning-contracts.js';
import {
  authorizeLearningClassSql,
  authorizeLearningJourneyPlanAssignmentSql,
  authorizeLearningJourneyPlanClassSql,
  authorizeLearningProgressLinkTargetSql,
  authorizeLearningSessionFeedbackTargetSql,
  fetchAssignmentStudentSql,
  fetchLearningBlockReleaseSql,
  fetchLearningAttemptContextSql,
  fetchLearningAttemptCheckpointsSql,
  fetchLearningAssignmentCheckpointScoresSql,
  fetchLearningFormGradingKeySql,
  fetchLearningLibraryItemsSql,
  fetchLearningRosterForClassSql,
  fetchLearningTeacherDashboardSql,
  fetchLearningTeacherLiveDraftsSql,
  fetchPublicLearningAssignmentSql,
  fetchLearningJourneyContextSql,
  fetchLearningJourneyPlanSql,
  fetchStudentCourseJourneySql,
  fetchLatestLearningSessionFeedbackSql,
  findLearningSessionFeedbackByOperationSql,
  findLearningCheckpointSubmissionSql,
  findLearningProgressAccessByOperationSql,
  findLearningSubmissionSql,
  insertLearningAssignmentBlockReleaseSql,
  insertLearningAssignmentRosterSql,
  insertLearningAssignmentSql,
  insertLearningSessionFeedbackSql,
  insertLearningAttemptSql,
  finalizeLearningSubmissionSql,
  insertLearningFormGradingKeySql,
  insertLearningQuizFormTemplateSql,
  insertLearningFormTemplateSql,
  insertLearningFormVersionSql,
  insertLearningCheckpointSubmissionSql,
  listLearningQuestionLibrarySql,
  listLearningTeacherOptionsSql,
  markLearningReportDeliveredSql,
  overrideLearningAttendanceSql,
  revokeLearningProgressAccessSql,
  rotateLearningProgressAccessSql,
  saveLearningDraftSql,
  saveLearningJourneyPlanSql,
  updateLearningBlockReleaseSql,
  upsertLearningTeacherHumanNoteSql
} from './learning-sql.js';

export class LearningError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'LearningError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function asObject(value) {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function legacyPublishConflict(error) {
  if (error.code === '23505' && error.constraint === 'assignment_session_once') {
    throw new LearningError('ASSIGNMENT_SESSION_CONFLICT', 'Buổi này đã có phiếu. Hãy mở phiếu đã phát hành.', 409);
  }
  throw error;
}

function asArray(value) {
  if (!value) return [];
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function studentFeedbackDefinition(definitionInput, override) {
  const definition = parseFormDefinition(asObject(definitionInput));
  return override === 'immediate'
    ? { ...definition, answerReleasePolicy: 'immediate' }
    : definition;
}

function gradeCheckpoint(definition, gradingKey, block, responses) {
  if (definition.answerReleasePolicy !== 'immediate' || !block) return null;
  const scopedDefinition = { ...definition, blocks: [block] };
  const result = gradeLearningSubmission({
    definition: scopedDefinition,
    gradingKey,
    responses: asObject(responses)
  });
  return result.summary.maxScore > 0
    ? buildStudentQuizResult(result, scopedDefinition)
    : null;
}

function teacherLiveStudent(value) {
  const student = asObject(value);
  const gradingResult = student.gradingResult ? asObject(student.gradingResult) : null;
  return {
    ...student,
    gradingResult: gradingResult ? {
      ...gradingResult,
      items: asArray(gradingResult.items).map(item => {
        const safe = { ...item };
        delete safe.expectedAnswer;
        return safe;
      })
    } : null
  };
}

function assertSingleRow(result, code, message, httpStatus = 404) {
  if (result.rowCount !== 1) throw new LearningError(code, message, httpStatus);
  return result.rows[0];
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function publicAssignment(row) {
  return {
    assignmentId: row.assignment_id,
    publicToken: row.public_token,
    organizationKey: row.organization_key,
    courseCode: row.course_code || null,
    class: { id: row.class_id, name: row.class_name },
    sessionNumber: Number(row.session_number),
    title: row.title,
    opensAt: row.opens_at || null,
    closesAt: row.closes_at || null,
    formVersionId: row.form_version_id,
    definitionHash: row.definition_hash,
    definition: parseFormDefinition(asObject(row.public_definition)),
    blockReleases: asArray(row.block_releases),
    roster: asArray(row.roster)
  };
}

function internalResultFromRow(row) {
  return asObject(row.result_json);
}

function parseQuizPublishInput({ title, definition: rawDefinition, gradingKey: rawGradingKey }) {
  let definition;
  let gradingKey;
  try {
    definition = parseFormDefinition(rawDefinition);
    gradingKey = parseFormGradingKey(rawGradingKey);
  } catch {
    throw new LearningError('INVALID_QUIZ_DEFINITION', 'Định nghĩa quiz hoặc grading key không hợp lệ.', 400);
  }
  if (definition.kind !== 'quiz' || definition.answerReleasePolicy !== 'hidden') {
    throw new LearningError('INVALID_QUIZ_DEFINITION', 'Quiz phải là kind quiz và ẩn đáp án.', 400);
  }
  if (definition.title !== title || gradingKey.formVersionId !== definition.formVersionId) {
    throw new LearningError('QUIZ_VERSION_MISMATCH', 'Tiêu đề hoặc grading key không khớp form version.', 400);
  }

  const items = definition.blocks.flatMap(block => block.items);
  const itemById = new Map(items.map(item => [item.itemVersionId, item]));
  for (const [itemVersionId, privateKey] of Object.entries(gradingKey.items)) {
    const item = itemById.get(itemVersionId);
    if (!item || item.graderType === 'none' || item.graderType !== privateKey.graderType) {
      throw new LearningError('GRADING_KEY_MISMATCH', 'Grading key không khớp item quiz.', 400);
    }
  }
  for (const item of items) {
    if (item.graderType === 'none') continue;
    if (item.graderType === 'unordered_group_slot') {
      if (!item.groupId || !gradingKey.groups[item.groupId]) {
        throw new LearningError('GRADING_KEY_MISMATCH', 'Quiz thiếu grading key cho nhóm lựa chọn.', 400);
      }
      continue;
    }
    if (!gradingKey.items[item.itemVersionId]) {
      throw new LearningError('GRADING_KEY_MISMATCH', 'Quiz thiếu grading key cho item.', 400);
    }
  }
  return { definition, gradingKey };
}

function normalizeJourneySessionDates(value) {
  return asArray(value).map(item => ({
    sessionNumber: Number(item.sessionNumber), date: item.date,
    ...(item.erpSessionId ? { erpSessionId: String(item.erpSessionId) } : {})
  }));
}

function normalizeJourneyTestSources(value) {
  return asArray(value).map(item => ({
    sessionNumber: Number(item.sessionNumber), testSlug: String(item.testSlug)
  }));
}

function buildStudentCourseJourney(row) {
  const sessions = asArray(row.sessions);
  const reports = asArray(row.reports);
  const attendedStatuses = new Set(['self_confirmed', 'teacher_confirmed']);
  return {
    schemaVersion: 'StudentCourseJourneyV1',
    student: { studentRef: row.student_ref, name: row.student_name },
    class: { classId: row.class_id, name: row.class_name },
    access: { expiresAt: row.expires_at },
    coverage: {
      knownThroughSession: sessions.at(-1)?.sessionNumber || 0,
      schedule: row.planned_sessions ? 'teacher_confirmed' : 'not_connected',
      plannedSessions: row.planned_sessions ? Number(row.planned_sessions) : null,
      planOutdated: Boolean(row.planned_sessions && sessions.length > Number(row.planned_sessions)),
      testResults: 'not_connected'
    },
    summary: {
      totalSessions: sessions.length,
      submittedComplete: sessions.filter(item => item.completeness === 'complete').length,
      attendedSessions: sessions.filter(item => attendedStatuses.has(item.attendanceStatus)).length,
      availableReports: reports.length
    },
    latestReport: reports.at(-1) || null,
    sessions,
    reports
  };
}

export function createLearningService({ pool, erpScheduleReader = null, testSourceReader = null,
  testResultReader = null, journeyCommentsEnabled = false, progressLinkCipher = null }) {
  if (!pool) throw new Error('Learning service cần database pool riêng.');
  const comments=journeyCommentsEnabled?createJourneyCommentService({pool,ErrorType:LearningError,cipher:progressLinkCipher}):null;
  async function attachComments(view,classId,studentRef=null) {
    if(!comments) return view;
    view={...view,journeyCommentsEnabled:true};
    const notes=await comments.readComments(classId,studentRef,{visibleOnly:!!studentRef});
    const byKey=new Map(notes.map(note=>[note.studentRef+':'+note.sessionNumber,note]));
    if(view.sessions && studentRef) return {...view,sessions:view.sessions.map(session=>({...session,
      sessionComment:byKey.get(studentRef+':'+session.sessionNumber)||null}))};
    return {...view,students:view.students.map(student=>({...student,
      ...(student.cells?{cells:student.cells.map(cell=>({...cell,sessionComment:byKey.get(student.studentRef+':'+cell.sessionNumber)||null}))}
        :{sessionComment:byKey.get(student.studentRef+':'+view.sessionNumber)||null})}))};
  }

  async function readErpSchedule(classId) {
    if (!erpScheduleReader) {
      throw new LearningError('ERP_SCHEDULE_NOT_CONFIGURED',
        'Nguồn lịch ERP chưa được cấu hình. Hãy giữ bản chốt và thử đọc lại sau.', 503);
    }
    try { return await erpScheduleReader(classId); }
    catch {
      throw new LearningError('ERP_SCHEDULE_UNAVAILABLE',
        'Chưa đọc được lịch ERP; bản chốt vẫn được giữ. Hãy thử đọc lại.', 503);
    }
  }

  async function authorizeJourneyTarget(database, {assignmentId,classId,reviewer}) {
    const result=await database.query(classId?authorizeLearningJourneyPlanClassSql:authorizeLearningJourneyPlanAssignmentSql,
      [classId||assignmentId,reviewer.email,reviewer.canAccessAllClasses]);
    return assertSingleRow(result,classId?'CLASS_ACCESS_DENIED':'ASSIGNMENT_ACCESS_DENIED',
      classId?'Lớp không thuộc phạm vi được cấp quyền.':'Không tìm thấy phiếu trong phạm vi được cấp quyền.',classId?403:404);
  }

  return {
    ...(comments||{}),
    async getPublicAssignment(publicToken) {
      const result = await pool.query(fetchPublicLearningAssignmentSql, [publicToken]);
      return publicAssignment(assertSingleRow(
        result,
        'ASSIGNMENT_NOT_AVAILABLE',
        'Phiếu chưa được mở, đã đóng hoặc không còn tồn tại.'
      ));
    },

    async startAttempt({ publicToken, studentRef, clientIdempotencyKey, identityConfirmed }) {
      if (identityConfirmed !== true) {
        throw new LearningError('IDENTITY_NOT_CONFIRMED', 'Bạn cần xác nhận đúng tên trước khi bắt đầu.');
      }
      return withTransaction(pool, async client => {
        const studentResult = await client.query(fetchAssignmentStudentSql, [publicToken, studentRef]);
        const student = assertSingleRow(
          studentResult,
          'STUDENT_NOT_IN_ASSIGNMENT',
          'Không tìm thấy học viên trong đúng phiếu của lớp này.'
        );
        const attemptResult = await client.query(insertLearningAttemptSql, [
          student.assignment_id,
          student.form_version_id,
          student.definition_hash,
          student.student_ref,
          clientIdempotencyKey
        ]);
        const attempt = assertSingleRow(attemptResult, 'ATTEMPT_NOT_CREATED', 'Chưa thể mở phiếu.', 409);
        if (attempt.student_ref !== student.student_ref || attempt.assignment_id !== student.assignment_id) {
          throw new LearningError('ATTEMPT_IDENTITY_MISMATCH', 'Phiên làm bài không khớp học viên.', 409);
        }
        const checkpointResult = await client.query(fetchLearningAttemptCheckpointsSql, [attempt.attempt_id]);
        const definition = studentFeedbackDefinition(student.public_definition, student.answer_release_override);
        const gradingKeyResult = checkpointResult.rowCount
          ? await client.query(fetchLearningFormGradingKeySql, [attempt.form_version_id])
          : null;
        const gradingKey = gradingKeyResult?.rows[0]
          ? parseFormGradingKey(asObject(gradingKeyResult.rows[0].private_definition))
          : null;
        return {
          attemptToken: attempt.attempt_token,
          assignmentId: attempt.assignment_id,
          formVersionId: attempt.form_version_id,
          definitionHash: attempt.definition_hash,
          draft: asObject(attempt.draft),
          draftRevision: Number(attempt.draft_revision),
          checkpointSubmissions: checkpointResult.rows.map(row => ({
            checkpointSubmissionId: row.checkpoint_submission_id,
            blockId: row.block_id,
            checkpoint: Number(row.checkpoint),
            completeness: row.completeness,
            missingItemVersionIds: asArray(row.missing_item_version_ids),
            result: gradingKey ? gradeCheckpoint(
              definition, gradingKey,
              definition.blocks.find(block => block.blockId === row.block_id),
              row.response_payload
            ) : null,
            submittedAt: row.submitted_at
          })),
          identity: {
            studentRef: student.student_ref,
            studentName: student.student_name,
            discriminator: student.display_discriminator || '',
            classId: student.class_id,
            className: student.class_name,
            sessionNumber: Number(student.session_number)
          }
        };
      });
    },

    async saveDraft({ attemptToken, revision, definitionHash, responses: inputResponses }) {
      const responses = parseResponses(inputResponses);
      const responseHash = sha256(stableStringify(responses));
      return withTransaction(pool, async client => {
        const contextResult = await client.query(fetchLearningAttemptContextSql, [attemptToken]);
        const context = assertSingleRow(contextResult, 'ATTEMPT_NOT_FOUND', 'Không tìm thấy phiên đang làm.');
        if (context.attempt_status !== 'active') {
          throw new LearningError('ATTEMPT_ALREADY_SUBMITTED', 'Phiếu này đã được nộp.', 409);
        }
        if (context.definition_hash !== definitionHash) {
          throw new LearningError('FORM_VERSION_MISMATCH', 'Form đã thay đổi; hãy tải lại đúng phiên bản.', 409);
        }
        const definition = parseFormDefinition(asObject(context.public_definition));
        evaluateCompleteness(definition, responses);
        const saved = await client.query(saveLearningDraftSql, [
          attemptToken,
          revision,
          json(responses),
          responseHash,
          definitionHash
        ]);
        if (saved.rowCount !== 1) {
          throw new LearningError('STALE_DRAFT', 'Một bản mới hơn đã được lưu; trang sẽ tải lại draft mới.', 409);
        }
        return {
          revision: Number(saved.rows[0].draft_revision),
          hash: saved.rows[0].draft_hash,
          savedAt: saved.rows[0].draft_updated_at
        };
      });
    },

    async submitCheckpoint({ attemptToken, checkpointSubmissionId, blockId, checkpoint, draftRevision,
      definitionHash, responses: inputResponses, idempotencyKey }) {
      const responses = parseResponses(inputResponses);
      return withTransaction(pool, async client => {
        const contextResult = await client.query(fetchLearningAttemptContextSql, [attemptToken]);
        const context = assertSingleRow(contextResult, 'ATTEMPT_NOT_FOUND', 'Không tìm thấy phiên đang làm.');
        if (context.definition_hash !== definitionHash) {
          throw new LearningError('FORM_VERSION_MISMATCH', 'Form đã thay đổi; hãy tải lại đúng phiên bản.', 409);
        }
        const definition = studentFeedbackDefinition(context.public_definition, context.answer_release_override);
        const block = definition.blocks.find(item => item.blockId === blockId && item.checkpoint === checkpoint);
        if (!block) {
          throw new LearningError('CHECKPOINT_IDENTITY_MISMATCH', 'Phần nộp không thuộc đúng form.', 409);
        }
        const validIds = new Set(block.items.map(item => item.itemVersionId));
        const blockResponses = Object.fromEntries(Object.entries(responses).filter(([id]) => validIds.has(id)));
        const gradingKey = parseFormGradingKey(asObject(context.private_definition));
        const completeness = evaluateCompleteness({ ...definition, blocks: [block] }, blockResponses);
        const responseHash = sha256(stableStringify(blockResponses));
        const existingResult = await client.query(findLearningCheckpointSubmissionSql, [
          attemptToken, blockId, idempotencyKey
        ]);
        if (existingResult.rowCount) {
          const existing = existingResult.rows[0];
          if (existing.response_hash !== responseHash) {
            throw new LearningError('CHECKPOINT_IDEMPOTENCY_CONFLICT', 'Mã nộp phần đã được dùng cho nội dung khác.', 409);
          }
          return {
            checkpointSubmissionId: existing.checkpoint_submission_id,
            blockId: existing.block_id,
            checkpoint: Number(existing.checkpoint),
            completeness: existing.completeness,
            missingItemVersionIds: asArray(existing.missing_item_version_ids),
            result: gradeCheckpoint(definition, gradingKey, block, existing.response_payload),
            submittedAt: existing.submitted_at,
            replayed: true
          };
        }
        if (context.attempt_status !== 'active') {
          throw new LearningError('ATTEMPT_NOT_ACTIVE', 'Phiếu này không còn ở trạng thái đang làm.', 409);
        }
        if (Number(draftRevision) < Number(context.draft_revision)) {
          throw new LearningError('STALE_CHECKPOINT', 'Phần này cũ hơn draft đã lưu trên máy chủ.', 409);
        }
        const releaseResult = await client.query(fetchLearningBlockReleaseSql, [context.assignment_id, blockId]);
        const release = assertSingleRow(releaseResult, 'BLOCK_RELEASE_MISSING', 'Phần này chưa được giảng viên cấu hình.', 409);
        if (release.status !== 'open') {
          throw new LearningError('BLOCK_NOT_OPEN', 'Phần này chưa được giảng viên mở hoặc đã đóng.', 409);
        }
        const submittedAt = new Date().toISOString();
        const inserted = await client.query(insertLearningCheckpointSubmissionSql, [
          checkpointSubmissionId, context.attempt_id, context.assignment_id, context.form_version_id,
          context.student_ref, blockId, checkpoint, 1, json(blockResponses), responseHash,
          completeness.complete ? 'complete' : 'incomplete', json(completeness.missingItemVersionIds),
          `checkpoint:${checkpointSubmissionId}:v1`, idempotencyKey, submittedAt
        ]);
        const row = assertSingleRow(inserted, 'CHECKPOINT_NOT_SAVED', 'Không lưu được phần vừa hoàn thành.', 500);
        return {
          checkpointSubmissionId: row.checkpoint_submission_id,
          blockId,
          checkpoint,
          completeness: completeness.complete ? 'complete' : 'incomplete',
          missingItemVersionIds: completeness.missingItemVersionIds,
          result: gradeCheckpoint(definition, gradingKey, block, blockResponses),
          submittedAt: row.submitted_at,
          replayed: false
        };
      });
    },

    async submit({ attemptToken, submissionId, definitionHash, draftRevision, responses: inputResponses }) {
      const responses = parseResponses(inputResponses);
      const responseHash = sha256(stableStringify(responses));
      return withTransaction(pool, async client => {
        const contextResult = await client.query(fetchLearningAttemptContextSql, [attemptToken]);
        const context = assertSingleRow(contextResult, 'ATTEMPT_NOT_FOUND', 'Không tìm thấy phiên đang làm.');
        if (context.student_ref === null || context.assignment_id === null) {
          throw new LearningError('ATTEMPT_IDENTITY_MISSING', 'Phiên làm bài thiếu identity.', 409);
        }
        if (context.attempt_status === 'submitted') {
          const existingResult = await client.query(findLearningSubmissionSql, [attemptToken]);
          const existing = assertSingleRow(existingResult, 'SUBMISSION_NOT_FOUND', 'Không đọc lại được bài đã nộp.', 409);
          if (existing.response_hash !== responseHash) {
            throw new LearningError('SUBMISSION_ALREADY_FINAL', 'Phiếu đã nộp với nội dung khác; cần giảng viên mở lại.', 409);
          }
          return {
            receipt: asObject(existing.receipt),
            result: buildStudentQuizResult(
              internalResultFromRow(existing),
              studentFeedbackDefinition(existing.public_definition, existing.answer_release_override)
            ),
            replayed: true
          };
        }
        if (context.attempt_status !== 'active') {
          throw new LearningError('ATTEMPT_NOT_ACTIVE', 'Phiên làm bài không còn hoạt động.', 409);
        }
        if (context.definition_hash !== definitionHash) {
          throw new LearningError('FORM_VERSION_MISMATCH', 'Form đã thay đổi; không thể nộp sai version.', 409);
        }
        if (Number(draftRevision) < Number(context.draft_revision)) {
          throw new LearningError('STALE_SUBMISSION', 'Bản nộp cũ hơn draft đã lưu trên máy chủ.', 409);
        }
        if (context.assignment_status !== 'published') {
          throw new LearningError('ASSIGNMENT_CLOSED', 'Phiếu đã đóng.', 409);
        }
        if (context.closes_at && new Date(context.closes_at).getTime() <= Date.now()) {
          throw new LearningError('ASSIGNMENT_CLOSED', 'Phiếu đã hết thời gian nhận.', 409);
        }

        const definition = studentFeedbackDefinition(context.public_definition, context.answer_release_override);
        const gradingKey = parseFormGradingKey(asObject(context.private_definition));
        const completeness = evaluateCompleteness(definition, responses);
        const quizResult = gradeLearningSubmission({ definition, gradingKey, responses });
        const receivedAt = new Date().toISOString();
        const receipt = buildSubmissionReceipt({ submissionId, receivedAt, completeness, quizResult });
        const evidence = buildEvidenceEnvelope({
          evidenceId: crypto.randomUUID(),
          submissionId,
          sourceRevision: 1,
          occurredAt: receivedAt,
          ingestedAt: receivedAt,
          organizationKey: context.organization_key,
          courseCode: context.course_code,
          classId: context.class_id,
          sessionNumber: Number(context.session_number),
          studentRef: context.student_ref,
          formVersionId: context.form_version_id,
          assignmentId: context.assignment_id,
          responses,
          quizResult,
          definition
        });

        const itemById = new Map(definition.blocks.flatMap(block => block.items).map(item => [item.itemVersionId, item]));
        const responseItems = [];
        const gradingItems = [];
        for (const resultItem of quizResult.items) {
          const item = itemById.get(resultItem.itemVersionId);
          if (!item || resultItem.itemFamilyId !== item.itemFamilyId) {
            throw new LearningError('RESULT_ITEM_IDENTITY_MISMATCH', 'Kết quả chấm không khớp câu hỏi.', 500);
          }
          responseItems.push({
            item_version_id: resultItem.itemVersionId,
            item_family_id: resultItem.itemFamilyId,
            position: resultItem.position,
            interaction_type: item.interactionType,
            pedagogical_type_code: resultItem.pedagogicalTypeCode,
            skill_codes: resultItem.skillCodes,
            response_value: resultItem.rawAnswer,
            answer_state: resultItem.answerState
          });
          gradingItems.push({
            item_version_id: resultItem.itemVersionId,
            raw_answer: resultItem.rawAnswer,
            normalized_answer: resultItem.normalizedAnswer,
            expected_answer: resultItem.expectedAnswer ?? null,
            answer_state: resultItem.answerState,
            verdict: resultItem.verdict,
            score_earned: resultItem.scoreEarned,
            max_score: resultItem.maxScore
          });
        }

        const operationKey = `grade:${submissionId}:v${quizResult.graderVersion}`;
        const attendanceStatus = completeness.complete ? 'self_confirmed' : 'pending_teacher';
        const attendanceReason = completeness.complete ? 'Nộp đủ mục bắt buộc.' : 'Phiếu còn thiếu mục bắt buộc.';
        const portalAttendanceUnitKey = `portal-attendance:${context.assignment_id}:session:${context.session_number}`;
        const portalAttendanceOperationKey = `portal-attendance:${submissionId}:v1`;
        const portalAttendanceIdempotencyKey = `portal-attendance:${submissionId}:enqueue:v1`;
        const finalized = await client.query(finalizeLearningSubmissionSql, [
          submissionId,
          context.attempt_id,
          context.assignment_id,
          context.form_version_id,
          context.student_ref,
          json(responses),
          responseHash,
          receipt.completeness,
          receipt.gradingStatus,
          json(receipt),
          receivedAt,
          json(responseItems),
          quizResult.graderVersion,
          operationKey,
          `${operationKey}:write`,
          json(quizResult),
          json(gradingItems),
          attendanceStatus,
          attendanceReason,
          `attendance:${submissionId}:v1`,
          evidence.evidenceId,
          evidence.sourceSystem,
          evidence.sourceRecordId,
          evidence.sourceRevision,
          evidence.entityKey,
          evidence.unitKey,
          evidence.operationKey,
          evidence.idempotencyKey,
          evidence.context.organizationKey,
          evidence.context.courseCode,
          evidence.context.classId,
          evidence.context.sessionNumber,
          evidence.visibility,
          json(evidence.payload),
          evidence.contentHash,
          evidence.rendererVersion,
          evidence.markdown,
          `analyze:${submissionId}:v1`,
          `analyze:${submissionId}:enqueue:v1`,
          json({
            schemaVersion: 'LearningAnalysisJobV1',
            evidenceId: evidence.evidenceId,
            submissionId,
            studentRef: context.student_ref,
            assignmentId: context.assignment_id
          }),
          portalAttendanceUnitKey,
          portalAttendanceOperationKey,
          portalAttendanceIdempotencyKey,
          json({
            schemaVersion: 'LearningPortalAttendanceJobV1',
            submissionId,
            assignmentId: context.assignment_id,
            classId: context.class_id,
            studentId: context.student_id,
            studentRef: context.student_ref,
            sessionNumber: Number(context.session_number),
            attendanceStatus: 'PRESENT'
          })
        ]);
        const finalizedRow = assertSingleRow(finalized, 'SUBMISSION_NOT_SAVED', 'Không thể lưu bài nộp.', 500);
        if (!finalizedRow.attempt_completed) {
          throw new LearningError('ATTEMPT_FINALIZE_FAILED', 'Không thể chốt phiên làm bài.', 409);
        }
        const isDemoAssignment = ['DEMO-56', 'DEMO-67'].includes(context.course_code)
          && String(context.class_id) === '990000567';
        if (Number(finalizedRow.response_item_count) !== responseItems.length
          || Number(finalizedRow.grading_item_count) !== gradingItems.length
          || !finalizedRow.attendance_event_saved
          || !finalizedRow.evidence_saved
          || !finalizedRow.outbox_saved
          || Boolean(finalizedRow.attendance_outbox_saved) !== (completeness.complete && !isDemoAssignment)) {
          throw new LearningError('SUBMISSION_WRITE_INCOMPLETE', 'Bài nộp chưa được ghi đủ dữ liệu liên quan.', 500);
        }
        return {
          receipt,
          result: buildStudentQuizResult(quizResult, definition),
          replayed: false
        };
      });
    },

    async getResult({ attemptToken }) {
      const result = await pool.query(findLearningSubmissionSql, [attemptToken]);
      const row = assertSingleRow(result, 'RESULT_NOT_READY', 'Chưa có bài nộp hoàn chỉnh.', 404);
      return {
        receipt: asObject(row.receipt),
        result: buildStudentQuizResult(internalResultFromRow(row),
          studentFeedbackDefinition(row.public_definition, row.answer_release_override))
      };
    },

    async getLearningJourneyContext(publicToken) {
      const result = await pool.query(fetchLearningJourneyContextSql, [publicToken]);
      const row = assertSingleRow(result, 'PROGRESS_LINK_INVALID',
        'Link phiếu không còn mở được hành trình.', 404);
      return {
        assignmentId: row.assignment_id,
        class: { id: row.class_id, name: row.class_name },
        courseCode: row.course_code || null,
        sessionNumber: Number(row.session_number),
        title: row.title,
        roster: asArray(row.roster)
      };
    },

    async getStudentCourseJourney({ accessToken, publicToken, studentRef }) {
      const result = await pool.query(fetchStudentCourseJourneySql, [
        accessToken ? sha256(accessToken) : null, publicToken || null, studentRef || null
      ]);
      const row = assertSingleRow(
        result,
        'PROGRESS_LINK_INVALID',
        accessToken ? 'Link hành trình không hợp lệ, đã hết hạn hoặc đã được thay thế.'
          : 'Không tìm thấy hành trình cho người học và lớp đã chọn.',
        404
      );
      const journey = buildStudentCourseJourney(row);
      const mapped = normalizeJourneyTestSources(row.test_sources);
      if (mapped.length) {
        if (!testResultReader) {
          journey.coverage.testResults = 'temporarily_unavailable';
        } else {
          try {
            const results = await testResultReader({ classId: row.class_id,
              studentRef: row.student_ref, testSlugs: mapped.map(item => item.testSlug) });
            const bySlug = new Map(results.map(item => [item.testSlug, item]));
            const byNumber = new Map(mapped.map(item => [item.sessionNumber, bySlug.get(item.testSlug)]));
            journey.sessions = journey.sessions.map(session => ({ ...session,
              ...(byNumber.get(session.sessionNumber)
                ? { testResult: byNumber.get(session.sessionNumber) } : {}) }));
            journey.coverage.testResults = 'connected';
          } catch {
            journey.coverage.testResults = 'temporarily_unavailable';
          }
        }
      }
      return attachComments(journey,row.class_id,row.student_ref);
    },

    // Link/tên được kiểm bằng cùng nguồn Journey; chỉ trả bài nộp của đúng lớp/người/buổi.
    // Không tạo attempt, đọc khóa chấm, gửi Portal hoặc thay chính sách mở phần.
    async getStudentCourseSessionDetail(input) {
      const journey = await this.getStudentCourseJourney(input);
      const session = journey.sessions.find(item => item.sessionNumber === input.sessionNumber);
      if (!session) throw new LearningError('JOURNEY_SESSION_NOT_FOUND', 'Không tìm thấy buổi học trong hành trình.', 404);
      if (session.completeness !== 'complete' && session.sessionComment) return {
        classId:journey.class.classId,student:journey.student,sessionNumber:input.sessionNumber,
        sessionDate:session.sessionDate,status:session.assignmentId?'not_submitted':'no_assignment',
        definition:null,responses:{},gradingItems:[],sessionComment:session.sessionComment,
        testResult:session.testResult||null};
      if (session.completeness !== 'complete') throw new LearningError('JOURNEY_SUBMISSION_NOT_READY',
        'Buổi này chưa có phiếu hoàn tất; hãy mở Progress Log theo lịch học.', 409);
      const result = await pool.query(fetchCourseSessionDetailSql,
        [journey.class.classId, input.sessionNumber, journey.student.studentRef]);
      if (result.rowCount > 1) throw new LearningError('JOURNEY_SESSION_CONFLICT',
        'Buổi có nhiều phiếu; giảng viên cần đối chiếu trước khi mở bài.', 409);
      const row = assertSingleRow(result, 'JOURNEY_SUBMISSION_NOT_READY', 'Chưa đọc được bài đã nộp.', 404);
      if (row.assignment_id !== session.assignmentId || row.student_ref !== journey.student.studentRef
        || !row.submission_id) throw new LearningError('JOURNEY_DETAIL_MISMATCH',
        'Dữ liệu buổi học đã thay đổi; hãy tải lại hành trình.', 409);
      return {classId:journey.class.classId, student:journey.student, sessionNumber:input.sessionNumber,
        sessionDate:session.sessionDate, status:'complete', definition:parseFormDefinition(asObject(row.public_definition)),
        submissionId:row.submission_id, responses:asObject(row.responses), gradingItems:asArray(row.grading_items),
        teacherSessionFeedback:session.teacherSessionFeedback || null,sessionComment:session.sessionComment||null,
        attendanceStatus:session.attendanceStatus, portalSync:session.portalSync};
    },

    async listTeacherOptions({ email, canAccessAllClasses }) {
      const result = await pool.query(listLearningTeacherOptionsSql, [email, canAccessAllClasses]);
      return asObject(result.rows[0]?.response || { classes: [], assignments: [] });
    },

    async listQuestionLibrary() {
      const result = await pool.query(listLearningQuestionLibrarySql);
      return result.rows.map(row => ({
        id: row.id,
        code: row.code,
        title: row.title,
        prompt: row.prompt,
        interactionType: row.interaction_type,
        pedagogicalTypeCode: row.pedagogical_type_code,
        layoutType: row.layout_type,
        graderType: row.grader_type,
        skillCodes: asArray(row.skill_codes),
        sharingScope: row.sharing_scope,
        approvedBy: row.approved_by_email || null,
        defaultConfig: asObject(row.default_config)
      }));
    },

    async publishReflectionForm({ reviewer, title, courseCode, classId, sessionNumber, opensAt, closesAt, items }) {
      return withTransaction(pool, async client => {
        const classResult = await client.query(authorizeLearningClassSql, [
          reviewer.email,
          reviewer.canAccessAllClasses,
          classId
        ]);
        const targetClass = assertSingleRow(classResult, 'CLASS_ACCESS_DENIED', 'Bạn không có quyền tạo phiếu cho lớp này.', 403);
        const requestedIds = items.map(item => item.libraryItemId);
        if (new Set(requestedIds).size !== requestedIds.length) {
          throw new LearningError('DUPLICATE_LIBRARY_ITEM', 'Một câu hỏi thư viện không được chọn hai lần.');
        }
        const libraryResult = await client.query(fetchLearningLibraryItemsSql, [requestedIds]);
        if (libraryResult.rowCount !== requestedIds.length) {
          throw new LearningError('LIBRARY_ITEM_MISMATCH', 'Có câu hỏi thư viện không còn hợp lệ.', 409);
        }
        const rosterResult = await client.query(fetchLearningRosterForClassSql, [classId]);
        if (!rosterResult.rowCount) {
          throw new LearningError('CLASS_ROSTER_EMPTY', 'Lớp chưa có học viên hợp lệ để chốt roster.', 409);
        }

        const formVersionId = crypto.randomUUID();
        const itemInputs = new Map(items.map(item => [item.libraryItemId, item]));
        const blocks = [...new Set(items.map(item => item.checkpoint))].sort((a, b) => a - b).map(checkpoint => {
          const blockItems = libraryResult.rows
            .filter(row => itemInputs.get(row.id)?.checkpoint === checkpoint)
            .map((row, index) => {
              const input = itemInputs.get(row.id);
              const defaultConfig = asObject(row.default_config);
              return {
                itemFamilyId: row.id,
                itemVersionId: crypto.randomUUID(),
                position: Number(row.ordinality),
                prompt: row.prompt,
                helpText: '',
                interactionType: row.interaction_type,
                pedagogicalTypeCode: row.pedagogical_type_code,
                layoutType: row.layout_type,
                graderType: row.grader_type,
                groupId: null,
                required: input.required,
                maxScore: 0,
                options: asArray(defaultConfig.options),
                interactionConfig: defaultConfig.interactionConfig || {},
                skillCodes: asArray(row.skill_codes),
                evidenceSource: defaultConfig.evidenceSource || 'student_self_report',
                releasePolicy: 'inherit'
              };
            });
          return {
            blockId: crypto.randomUUID(),
            checkpoint,
            title: `Ghi nhanh ${checkpoint}`,
            instructions: 'Điền ngắn gọn ngay khi giảng viên yêu cầu.',
            items: blockItems
          };
        });
        const definition = parseFormDefinition({
          schemaVersion: 'FormDefinitionV1',
          formVersionId,
          title,
          kind: 'reflection',
          answerReleasePolicy: 'hidden',
          blocks
        });
        const gradingKey = parseFormGradingKey({
          schemaVersion: 'FormGradingKeyV1',
          formVersionId,
          graderVersion: 1,
          items: {},
          groups: {}
        });
        const definitionHash = sha256(stableStringify(definition));
        const gradingHash = sha256(stableStringify(gradingKey));
        const templateResult = await client.query(insertLearningFormTemplateSql, [title, reviewer.email]);
        const template = assertSingleRow(templateResult, 'FORM_TEMPLATE_NOT_CREATED', 'Không tạo được mẫu phiếu.', 500);
        await client.query(insertLearningFormVersionSql, [
          formVersionId,
          template.template_id,
          json(definition),
          definitionHash,
          reviewer.email
        ]);
        await client.query(insertLearningFormGradingKeySql, [
          formVersionId,
          json(gradingKey),
          gradingHash
        ]);
        const assignmentResult = await client.query(insertLearningAssignmentSql, [
          formVersionId,
          courseCode || null,
          classId,
          targetClass.class_name,
          sessionNumber,
          title,
          opensAt || null,
          closesAt || null,
          reviewer.email
        ]);
        const assignment = assertSingleRow(assignmentResult, 'ASSIGNMENT_NOT_CREATED', 'Không gán được phiếu cho lớp.', 500);
        for (const roster of rosterResult.rows) {
          await client.query(insertLearningAssignmentRosterSql, [
            assignment.assignment_id,
            roster.student_ref,
            roster.student_id,
            roster.student_name,
            roster.display_discriminator
          ]);
        }
        for (const block of definition.blocks) {
          await client.query(insertLearningAssignmentBlockReleaseSql, [
            assignment.assignment_id,
            block.blockId,
            block.checkpoint,
            block.checkpoint === 1 ? 'open' : 'locked',
            reviewer.email
          ]);
        }
        return {
          assignmentId: assignment.assignment_id,
          publicToken: assignment.public_token,
          formVersionId,
          definitionHash,
          rosterCount: rosterResult.rowCount
        };
      }).catch(legacyPublishConflict);
    },

    async publishQuizForm({ reviewer, title, courseCode, classId, sessionNumber, opensAt, closesAt, definition: rawDefinition, gradingKey: rawGradingKey }) {
      const { definition, gradingKey } = parseQuizPublishInput({ title, definition: rawDefinition, gradingKey: rawGradingKey });
      const definitionHash = sha256(stableStringify(definition));
      const gradingHash = sha256(stableStringify(gradingKey));
      return withTransaction(pool, async client => {
        const classResult = await client.query(authorizeLearningClassSql, [
          reviewer.email,
          reviewer.canAccessAllClasses,
          classId
        ]);
        const targetClass = assertSingleRow(classResult, 'CLASS_ACCESS_DENIED', 'Bạn không có quyền tạo phiếu cho lớp này.', 403);
        const rosterResult = await client.query(fetchLearningRosterForClassSql, [classId]);
        if (!rosterResult.rowCount) {
          throw new LearningError('CLASS_ROSTER_EMPTY', 'Lớp chưa có học viên hợp lệ để chốt roster.', 409);
        }

        const templateResult = await client.query(insertLearningQuizFormTemplateSql, [title, reviewer.email]);
        const template = assertSingleRow(templateResult, 'FORM_TEMPLATE_NOT_CREATED', 'Không tạo được mẫu phiếu.', 500);
        await client.query(insertLearningFormVersionSql, [
          definition.formVersionId,
          template.template_id,
          json(definition),
          definitionHash,
          reviewer.email
        ]);
        await client.query(insertLearningFormGradingKeySql, [
          definition.formVersionId,
          json(gradingKey),
          gradingHash
        ]);
        const assignmentResult = await client.query(insertLearningAssignmentSql, [
          definition.formVersionId,
          courseCode || null,
          classId,
          targetClass.class_name,
          sessionNumber,
          title,
          opensAt || null,
          closesAt || null,
          reviewer.email
        ]);
        const assignment = assertSingleRow(assignmentResult, 'ASSIGNMENT_NOT_CREATED', 'Không gán được quiz cho lớp.', 500);
        for (const roster of rosterResult.rows) {
          await client.query(insertLearningAssignmentRosterSql, [
            assignment.assignment_id,
            roster.student_ref,
            roster.student_id,
            roster.student_name,
            roster.display_discriminator
          ]);
        }
        for (const block of definition.blocks) {
          await client.query(insertLearningAssignmentBlockReleaseSql, [
            assignment.assignment_id,
            block.blockId,
            block.checkpoint,
            block.checkpoint === 1 ? 'open' : 'locked',
            reviewer.email
          ]);
        }
        return {
          assignmentId: assignment.assignment_id,
          publicToken: assignment.public_token,
          formVersionId: definition.formVersionId,
          definitionHash,
          rosterCount: rosterResult.rowCount
        };
      }).catch(legacyPublishConflict);
    },

    async getTeacherErpSchedule({ assignmentId, classId, reviewer }) {
      const target = await authorizeJourneyTarget(pool, {assignmentId,classId,reviewer});
      const schedule = await readErpSchedule(target.class_id);
      const current = await pool.query(fetchLearningJourneyPlanSql, [target.class_id]);
      return { classId: target.class_id, className: target.class_name,
        assignmentSessionNumbers: asArray(target.assignment_session_numbers).map(Number),
        ...decorateSchedule(target.class_id, schedule,
          normalizeJourneySessionDates(current.rows[0]?.session_dates)) };
    },

    async getTeacherTestSources({ assignmentId, classId, reviewer }) {
      const target = await authorizeJourneyTarget(pool, {assignmentId,classId,reviewer});
      if (!testSourceReader) {
        throw new LearningError('TEST_SOURCE_NOT_CONFIGURED',
          'Nguồn kết quả Test chưa được kết nối.', 503);
      }
      try {
        const tests = await testSourceReader(target.class_id);
        return { classId: target.class_id, className: target.class_name, tests };
      } catch {
        throw new LearningError('TEST_SOURCE_UNAVAILABLE',
          'Chưa đọc được nguồn kết quả Test; hãy thử lại sau.', 503);
      }
    },

    async getTeacherJourneyPlan({ assignmentId, classId, reviewer }) {
      const target = await authorizeJourneyTarget(pool, {assignmentId,classId,reviewer});
      const result = await pool.query(fetchLearningJourneyPlanSql, [target.class_id]);
      const plan = result.rows[0];
      return {
        classId: target.class_id,
        className: target.class_name,
        highestKnownSession: Number(target.highest_known_session || 0),
        totalSessions: plan ? Number(plan.total_sessions) : null,
        testSessionNumbers: plan ? asArray(plan.test_session_numbers).map(Number) : [],
        testSources: plan ? normalizeJourneyTestSources(plan.test_sources) : [],
        sessionDates: plan ? normalizeJourneySessionDates(plan.session_dates) : [],
        revision: plan ? Number(plan.revision) : 0,
        confirmedBy: plan?.confirmed_by_email || null,
        confirmedAt: plan?.confirmed_at || null
      };
    },

    async saveTeacherJourneyPlan({ assignmentId, classId, totalSessions, testSessionNumbers,
      testSources, sessionDates, expectedRevision, expectedScheduleFingerprint, reviewer }) {
      let validatedSchedule = null;
      if (expectedScheduleFingerprint) {
        const target = await authorizeJourneyTarget(pool, {assignmentId,classId,reviewer});
        const schedule = decorateSchedule(target.class_id, await readErpSchedule(target.class_id));
        validatedSchedule = schedule;
        if (schedule.fingerprint !== expectedScheduleFingerprint) {
          throw new LearningError('ERP_SCHEDULE_STALE',
            'Lịch ERP đã đổi sau lần đọc. Hãy đọc lại lịch để đối chiếu; bản chỉnh chưa bị xóa.', 409);
        }
      }
      const newMappings = (sessionDates || []).filter(item => item.erpSessionId);
      if (newMappings.length) {
        const target = await authorizeJourneyTarget(pool, {assignmentId,classId,reviewer});
        const current = await pool.query(fetchLearningJourneyPlanSql, [target.class_id]);
        const previousByNumber = new Map(normalizeJourneySessionDates(current.rows[0]?.session_dates)
          .map(item => [item.sessionNumber, item]));
        const changed = newMappings.filter(item => {
          const prior = previousByNumber.get(item.sessionNumber);
          return prior?.erpSessionId !== item.erpSessionId || prior?.date !== item.date;
        });
        if (changed.length) {
          const schedule = validatedSchedule || await readErpSchedule(target.class_id);
          const byId = new Map(schedule.sessions.map(item => [item.erpSessionId, item]));
          if (changed.some(item => byId.get(item.erpSessionId)?.date !== item.date)) {
            throw new LearningError('ERP_SCHEDULE_MAPPING_CHANGED',
              'Dòng lịch ERP không thuộc lớp này hoặc ngày đã đổi; hãy tải lại lịch để xác nhận.', 409);
          }
        }
      }
      if ((testSources || []).length) {
        const target = await authorizeJourneyTarget(pool, {assignmentId,classId,reviewer});
        const current = await pool.query(fetchLearningJourneyPlanSql, [target.class_id]);
        const previousByNumber = new Map(normalizeJourneyTestSources(current.rows[0]?.test_sources)
          .map(item => [item.sessionNumber, item.testSlug]));
        const changed = testSources.filter(item => previousByNumber.get(item.sessionNumber) !== item.testSlug);
        if (changed.length) {
          if (!testSourceReader) {
            throw new LearningError('TEST_SOURCE_NOT_CONFIGURED',
              'Nguồn kết quả Test chưa được kết nối.', 503);
          }
          let available;
          try { available = await testSourceReader(target.class_id); }
          catch {
            throw new LearningError('TEST_SOURCE_UNAVAILABLE',
              'Chưa đọc được nguồn kết quả Test; hãy thử lại sau.', 503);
          }
          const slugs = new Set(available.map(item => item.testSlug));
          if (changed.some(item => !slugs.has(item.testSlug))) {
            throw new LearningError('TEST_SOURCE_MAPPING_CHANGED',
              'Bài Test không có kết quả thuộc lớp này; hãy tải lại nguồn Test.', 409);
          }
        }
      }
      return withTransaction(pool, async client => {
        const target = await authorizeJourneyTarget(client, {assignmentId,classId,reviewer});
        if (totalSessions < Number(target.highest_known_session || 0)) {
          throw new LearningError('JOURNEY_PLAN_TOO_SHORT',
            'Tổng số buổi nhỏ hơn số buổi cao nhất đã có dữ liệu.', 409);
        }
        const current = await client.query(fetchLearningJourneyPlanSql, [target.class_id]);
        const prior = current.rows[0];
        const datesToSave = normalizeJourneySessionDates(sessionDates ?? prior?.session_dates ?? []);
        const assignedNumbers = new Set(asArray(target.assignment_session_numbers).map(Number));
        const newByNumber = new Map(datesToSave.map(item => [item.sessionNumber, item]));
        for (const old of normalizeJourneySessionDates(prior?.session_dates)) {
          if (!assignedNumbers.has(old.sessionNumber)) continue;
          const next = newByNumber.get(old.sessionNumber);
          if (next?.erpSessionId !== old.erpSessionId || next?.date !== old.date) {
            throw new LearningError('ERP_ASSIGNED_SESSION_LOCKED',
              'Buổi đã có phiếu phải giữ ánh xạ đã chốt. Cần đối chiếu riêng trước khi đổi đích điểm danh.', 409);
          }
        }
        const sourcesToSave = normalizeJourneyTestSources(testSources ?? prior?.test_sources ?? []);
        if (sourcesToSave.some(item => !testSessionNumbers.includes(item.sessionNumber))
          || new Set(sourcesToSave.map(item => item.sessionNumber)).size !== sourcesToSave.length
          || new Set(sourcesToSave.map(item => item.testSlug)).size !== sourcesToSave.length) {
          throw new LearningError('TEST_SOURCE_MAPPING_INVALID',
            'Mỗi bài Test phải ghép với đúng một buổi Test của lớp.', 409);
        }
        const mappedIds = datesToSave.map(item => item.erpSessionId).filter(Boolean);
        if (new Set(mappedIds).size !== mappedIds.length) {
          throw new LearningError('ERP_SCHEDULE_DUPLICATE_MAPPING',
            'Một dòng lịch ERP không thể gắn với hai buổi.', 409);
        }
        if (datesToSave.some(item => item.sessionNumber > totalSessions)) {
          throw new LearningError('JOURNEY_DATE_OUT_OF_RANGE',
            'Ngày đã xác nhận nằm ngoài tổng số buổi; hãy kiểm tra lại kế hoạch.', 409);
        }
        const same = prior && Number(prior.total_sessions) === totalSessions
          && JSON.stringify(asArray(prior.test_session_numbers).map(Number))
            === JSON.stringify(testSessionNumbers)
          && JSON.stringify(normalizeJourneyTestSources(prior.test_sources)) === JSON.stringify(sourcesToSave)
          && JSON.stringify(normalizeJourneySessionDates(prior.session_dates)) === JSON.stringify(datesToSave);
        if (Number(prior?.revision || 0) !== expectedRevision) {
          if (same && Number(prior.revision) === expectedRevision + 1) {
            return {
              classId: target.class_id, className: target.class_name,
              highestKnownSession: Number(target.highest_known_session || 0),
              totalSessions, testSessionNumbers, testSources: sourcesToSave,
              sessionDates: datesToSave, revision: Number(prior.revision),
              confirmedBy: prior.confirmed_by_email, confirmedAt: prior.confirmed_at, replayed: true
            };
          }
          throw new LearningError('JOURNEY_PLAN_STALE',
            'Kế hoạch lớp đã được cập nhật; hãy tải lại trước khi lưu.', 409);
        }
        const saved = await client.query(saveLearningJourneyPlanSql,
          [target.class_id, totalSessions, testSessionNumbers, expectedRevision, reviewer.email,
            JSON.stringify(datesToSave), JSON.stringify(sourcesToSave)]);
        if (!saved.rowCount) {
          throw new LearningError('JOURNEY_PLAN_STALE',
            'Kế hoạch lớp đã được cập nhật; hãy tải lại trước khi lưu.', 409);
        }
        const readback = await client.query(fetchLearningJourneyPlanSql, [target.class_id]);
        const row = assertSingleRow(readback, 'JOURNEY_PLAN_READBACK_FAILED',
          'Chưa xác nhận được kế hoạch vừa lưu.', 500);
        if (Number(row.revision) !== expectedRevision + 1
          || Number(row.total_sessions) !== totalSessions
          || JSON.stringify(asArray(row.test_session_numbers).map(Number))
            !== JSON.stringify(testSessionNumbers)
          || JSON.stringify(normalizeJourneyTestSources(row.test_sources)) !== JSON.stringify(sourcesToSave)
          || JSON.stringify(normalizeJourneySessionDates(row.session_dates)) !== JSON.stringify(datesToSave)) {
          throw new LearningError('JOURNEY_PLAN_READBACK_MISMATCH',
            'Kế hoạch lưu không khớp dữ liệu đã gửi.', 500);
        }
        return {
          classId: target.class_id, className: target.class_name,
          highestKnownSession: Number(target.highest_known_session || 0),
          totalSessions, testSessionNumbers, testSources: sourcesToSave,
          sessionDates: datesToSave, revision: Number(row.revision),
          confirmedBy: row.confirmed_by_email, confirmedAt: row.confirmed_at, replayed: false
        };
      });
    },

    async getCourseOverview({classId,reviewer}) {
      const access=await pool.query(authorizeLearningClassSql,[reviewer.email,reviewer.canAccessAllClasses,classId]);
      const target=assertSingleRow(access,'CLASS_ACCESS_DENIED','Lớp không thuộc phạm vi được cấp quyền.',403);
      const [plan,roster,status]=await Promise.all([
        pool.query(fetchLearningJourneyPlanSql,[classId]),pool.query(fetchCourseCurrentRosterSql,[classId]),
        pool.query(fetchCourseOverviewSql,[classId])]);
      const overview=buildCourseOverview({classId:target.class_id,className:target.class_name,plan:plan.rows[0],
        currentRoster:roster.rows,rows:status.rows});
      const mapped=normalizeJourneyTestSources(plan.rows[0]?.test_sources);
      if (mapped.length) {
        overview.testCoverage='temporarily_unavailable';
        if (testResultReader?.readClass) {
          try {
            const results=await testResultReader.readClass({classId,studentRefs:overview.students.map(s=>s.studentRef),
              testSlugs:mapped.map(source=>source.testSlug)});
            const bySlug=new Map(mapped.map(source=>[source.testSlug,source.sessionNumber]));
            return attachComments(buildCourseOverview({classId:target.class_id,className:target.class_name,plan:plan.rows[0],
              currentRoster:roster.rows,rows:status.rows,testCoverage:'connected',
              testResults:results.map(item=>({...item,sessionNumber:bySlug.get(item.result.testSlug)}))}),target.class_id);
          } catch { /* Nguồn Test lỗi không chặn xem dữ liệu Progress Log của lớp. */ }
        }
      }
      return attachComments(overview,target.class_id);
    },

    async getCourseSessionDetail({classId,sessionNumber,studentRef,reviewer}) {
      const overview=await this.getCourseOverview({classId,reviewer});
      const student=overview.students.find(person=>person.studentRef===studentRef);
      const cell=student?.cells.find(item=>item.sessionNumber===sessionNumber);
      if (!cell) throw new LearningError('JOURNEY_STUDENT_NOT_FOUND','Không tìm thấy học viên/buổi trong lớp này.',404);
      const result=await pool.query(fetchCourseSessionDetailSql,[classId,sessionNumber,studentRef]);
      if (result.rowCount>1) throw new LearningError('JOURNEY_SESSION_CONFLICT','Buổi có nhiều phiếu; cần đối chiếu trước khi mở bài.',409);
      const row=result.rows[0];
      return {classId,student:{studentRef,name:student.name,discriminator:student.discriminator},sessionNumber,
        status:cell.status,sessionDate:overview.sessions.find(item=>item.sessionNumber===sessionNumber)?.sessionDate||null,
        testResult:cell.testResult,testCoverage:overview.testCoverage,
        definition:row?parseFormDefinition(asObject(row.public_definition)):null,
        submissionId:row?.submission_id||null,responses:asObject(row?.responses),
        gradingItems:asArray(row?.grading_items),teacherSessionFeedback:row?.teacher_session_feedback||null,
        sessionComment:cell.sessionComment||null};
    },

    async getQuestionAnalytics({assignmentId, reviewer}) {
      const access = await pool.query(authorizeLearningJourneyPlanAssignmentSql,
        [assignmentId,reviewer.email,reviewer.canAccessAllClasses]);
      assertSingleRow(access,'ASSIGNMENT_ACCESS_DENIED','Không tìm thấy phiếu trong phạm vi được cấp quyền.',404);
      const definition = await pool.query(`SELECT version.public_definition FROM learning.form_assignment AS assignment
        JOIN learning.form_version AS version ON version.id = assignment.form_version_id WHERE assignment.id = $1::uuid;`,[assignmentId]);
      const students = await pool.query(fetchQuestionAnalyticsSql,[assignmentId]);
      return buildQuestionAnalytics({assignmentId,definition:definition.rows[0].public_definition,students:students.rows});
    },

    async getTeacherDashboard({ assignmentId, reviewer }) {
      const result = await pool.query(fetchLearningTeacherDashboardSql, [
        assignmentId,
        reviewer.email,
        reviewer.canAccessAllClasses
      ]);
      const row = assertSingleRow(result, 'ASSIGNMENT_ACCESS_DENIED', 'Không tìm thấy phiếu trong phạm vi được cấp quyền.', 404);
      const scoreRows = await pool.query(fetchLearningAssignmentCheckpointScoresSql, [assignmentId]);
      const commentClass=comments?await pool.query('SELECT erp_course_class_id::text AS class_id FROM learning.form_assignment WHERE id=$1::uuid',[assignmentId]):null;
      const notes=comments?await comments.readComments(commentClass.rows[0].class_id):[];
      const noteMap=new Map(notes.filter(note=>note.sessionNumber===Number(row.session_number)).map(note=>[note.studentRef,note]));
      const scoresByStudent = new Map();
      for (const scoreRow of scoreRows.rows) {
        const definition = studentFeedbackDefinition(scoreRow.public_definition, scoreRow.answer_release_override);
        const block = definition.blocks.find(item => item.blockId === scoreRow.block_id);
        if (!block) continue;
        const gradingKey = parseFormGradingKey(asObject(scoreRow.private_definition));
        const graded = gradeCheckpoint(definition, gradingKey, block, scoreRow.response_payload);
        if (!graded) continue;
        const current = scoresByStudent.get(scoreRow.student_ref) || [];
        current.push({ blockId: block.blockId, checkpoint: block.checkpoint,
          correct: graded.items.filter(item => item.verdict === 'correct').length,
          total: graded.items.filter(item => item.maxScore > 0).length });
        scoresByStudent.set(scoreRow.student_ref, current);
      }
      return {
        assignmentId: row.assignment_id,
        title: row.title,
        sessionNumber: Number(row.session_number),
        classId:commentClass?.rows[0]?.class_id||null,
        journeyCommentsEnabled,
        className: row.class_name,
        publicToken: row.public_token,
        status: row.status,
        formVersionId: row.form_version_id,
        definition: parseFormDefinition(asObject(row.public_definition)),
        blockReleases: asArray(row.block_releases),
        classInsights: asArray(row.class_insights),
        students: asArray(row.students).map(student => ({
          ...student,
          sessionComment:noteMap.get(student.studentRef)||null,
          checkpointScores: scoresByStudent.get(student.studentRef) || []
        }))
      };
    },

    async getTeacherLiveDrafts({ assignmentId, reviewer }) {
      const result = await pool.query(fetchLearningTeacherLiveDraftsSql, [
        assignmentId,
        reviewer.email,
        reviewer.canAccessAllClasses
      ]);
      const row = assertSingleRow(
        result,
        'ASSIGNMENT_ACCESS_DENIED',
        'Không tìm thấy phiếu trong phạm vi được cấp quyền.',
        404
      );
      const assignment=comments?await pool.query('SELECT erp_course_class_id::text AS class_id,session_number FROM learning.form_assignment WHERE id=$1::uuid',[assignmentId]):null;
      const notes=comments?await comments.readComments(assignment.rows[0].class_id):[];
      const noteMap=new Map(notes.filter(note=>note.sessionNumber===Number(assignment?.rows[0]?.session_number)).map(note=>[note.studentRef,note]));
      return {
        assignmentId: row.assignment_id,
        generatedAt: row.generated_at,
        students: asArray(row.students).map(student=>({...teacherLiveStudent(student),...(comments?{sessionComment:noteMap.get(student.studentRef)||null}:{})}))
      };
    },

    async sendTeacherSessionFeedback({ assignmentId, studentRef, noteText, expectedRevision,
      operationId, reviewer }) {
      return withTransaction(pool, async client => {
        // Khóa bản ghi lớp–học viên để hai lần gửi đồng thời không ghi đè nhau.
        const target = await client.query(authorizeLearningSessionFeedbackTargetSql, [
          assignmentId, studentRef, reviewer.email, reviewer.canAccessAllClasses
        ]);
        assertSingleRow(target, 'SESSION_FEEDBACK_ACCESS_DENIED',
          'Không tìm thấy học viên trong phiếu bạn được phân công.', 403);

        const prior = await client.query(findLearningSessionFeedbackByOperationSql, [operationId]);
        if (prior.rowCount) {
          const row = prior.rows[0];
          if (row.assignment_id !== assignmentId || row.student_ref !== studentRef
            || row.note_text !== noteText || row.revision !== expectedRevision + 1) {
            throw new LearningError('SESSION_FEEDBACK_IDEMPOTENCY_CONFLICT',
              'Mã thao tác đã được dùng cho nhận xét khác.', 409);
          }
          return { revision: row.revision, noteText: row.note_text, sentAt: row.sent_at,
            studentRef: row.student_ref, replayed: true };
        }

        const latest = await client.query(fetchLatestLearningSessionFeedbackSql,
          [assignmentId, studentRef]);
        const currentRevision = Number(latest.rows[0]?.revision || 0);
        if (currentRevision !== expectedRevision) {
          throw new LearningError('SESSION_FEEDBACK_STALE',
            'Nhận xét đã thay đổi; hãy mở lại bài trước khi gửi.', 409);
        }
        await client.query(insertLearningSessionFeedbackSql, [
          crypto.randomUUID(), assignmentId, studentRef, currentRevision + 1,
          noteText, reviewer.email, operationId
        ]);
        const readback = await client.query(findLearningSessionFeedbackByOperationSql,
          [operationId]);
        const saved = assertSingleRow(readback, 'SESSION_FEEDBACK_READBACK_FAILED',
          'Chưa xác nhận được nhận xét vừa gửi.', 500);
        if (saved.assignment_id !== assignmentId || saved.student_ref !== studentRef
          || saved.note_text !== noteText || Number(saved.revision) !== currentRevision + 1) {
          throw new LearningError('SESSION_FEEDBACK_READBACK_MISMATCH',
            'Nhận xét lưu không khớp dữ liệu đã gửi.', 500);
        }
        return { revision: Number(saved.revision), noteText: saved.note_text,
          sentAt: saved.sent_at, studentRef: saved.student_ref, replayed: false };
      });
    },

    async createStudentProgressLink({ assignmentId, studentRef, accessToken, expiresInDays,
      reviewer, operationId }) {
      const tokenHash = sha256(accessToken);
      const operationKey = `student-progress-link:${operationId}`;
      const idempotencyKey = `${operationKey}:write`;
      const expiresAt = new Date(Date.now() + (expiresInDays * 86_400_000)).toISOString();
      return withTransaction(pool, async client => {
        const targetResult = await client.query(authorizeLearningProgressLinkTargetSql, [
          assignmentId,
          studentRef,
          reviewer.email,
          reviewer.canAccessAllClasses
        ]);
        const target = assertSingleRow(
          targetResult,
          'STUDENT_PROGRESS_ACCESS_DENIED',
          'Không tìm thấy học viên trong lớp bạn được phân công.',
          403
        );

        const existingResult = await client.query(findLearningProgressAccessByOperationSql, [operationKey]);
        if (existingResult.rowCount) {
          const existing = existingResult.rows[0];
          if (existing.class_id !== target.class_id
            || existing.student_ref !== target.student_ref
            || existing.token_hash !== tokenHash) {
            throw new LearningError(
              'PROGRESS_LINK_IDEMPOTENCY_CONFLICT',
              'Mã thao tác đã được dùng cho một link khác.',
              409
            );
          }
          return {
            accessId: existing.id,
            accessToken,
            studentRef: existing.student_ref,
            studentName: target.student_name,
            classId: existing.class_id,
            className: target.class_name,
            status: existing.status,
            expiresAt: existing.expires_at,
            replayed: true
          };
        }

        const accessId = crypto.randomUUID();
        await client.query(revokeLearningProgressAccessSql, [target.class_id, target.student_ref]);
        const savedResult = await client.query(rotateLearningProgressAccessSql, [
          accessId,
          target.class_id,
          target.student_ref,
          tokenHash,
          expiresAt,
          reviewer.email,
          operationKey,
          idempotencyKey
        ]);
        assertSingleRow(savedResult, 'PROGRESS_LINK_NOT_CREATED', 'Không tạo được link hành trình.', 500);

        const readbackResult = await client.query(findLearningProgressAccessByOperationSql, [operationKey]);
        const readback = assertSingleRow(
          readbackResult,
          'PROGRESS_LINK_READBACK_FAILED',
          'Không xác nhận được link vừa tạo.',
          500
        );
        if (readback.id !== accessId
          || readback.class_id !== target.class_id
          || readback.student_ref !== target.student_ref
          || readback.token_hash !== tokenHash
          || readback.status !== 'active') {
          throw new LearningError('PROGRESS_LINK_IDENTITY_MISMATCH', 'Link vừa tạo không khớp học viên.', 500);
        }
        return {
          accessId,
          accessToken,
          studentRef: target.student_ref,
          studentName: target.student_name,
          classId: target.class_id,
          className: target.class_name,
          status: readback.status,
          expiresAt: readback.expires_at,
          replayed: false
        };
      });
    },

    async overrideAttendance({ assignmentId, studentRef, status, reason, reviewer, operationKey }) {
      const result = await pool.query(overrideLearningAttendanceSql, [
        assignmentId,
        studentRef,
        status,
        reason,
        reviewer.email,
        reviewer.canAccessAllClasses,
        operationKey
      ]);
      const row = assertSingleRow(result, 'ATTENDANCE_OVERRIDE_DENIED', 'Không thể cập nhật điểm danh cho học viên này.', 403);
      return {
        assignmentId: row.assignment_id,
        studentRef: row.student_ref,
        status: row.status,
        reason: row.current_reason,
        decidedBy: row.decided_by_email,
        decidedAt: row.decided_at,
        portalSyncQueued: row.portal_sync_queued,
        replayed: row.replayed
      };
    },

    async setBlockRelease({ assignmentId, blockId, status, reviewer, operationId }) {
      const idempotencyKey = `block-release:${operationId}`;
      const result = await pool.query(updateLearningBlockReleaseSql, [
        assignmentId,
        blockId,
        status,
        idempotencyKey,
        reviewer.email,
        reviewer.canAccessAllClasses,
        `block-release:${assignmentId}:${blockId}:${operationId}`
      ]);
      const row = assertSingleRow(result, 'BLOCK_RELEASE_DENIED', 'Không thể đổi trạng thái phần này.', 403);
      return {
        assignmentId: row.assignment_id,
        blockId: row.block_id,
        checkpoint: Number(row.checkpoint),
        status: row.status,
        releaseVersion: Number(row.release_version),
        releasedAt: row.released_at || null
      };
    },

    async markReportDelivered({ reportId, assignmentId, studentRef, reviewer, operationId }) {
      const idempotencyKey = `report-delivery:${operationId}`;
      const result = await pool.query(markLearningReportDeliveredSql, [
        reportId,
        assignmentId,
        studentRef,
        idempotencyKey,
        `report-delivery:${reportId}:${operationId}`,
        reviewer.email,
        reviewer.canAccessAllClasses
      ]);
      const row = assertSingleRow(result, 'REPORT_DELIVERY_DENIED', 'Không thể xác nhận đã gửi tổng kết này.', 403);
      return {
        reportId: row.report_id,
        studentRef: row.student_ref,
        channel: row.channel,
        status: row.status,
        sentBy: row.sent_by_email,
        sentAt: row.sent_at
      };
    },

    async saveTeacherHumanNote({ reportId, assignmentId, studentRef, noteText, reviewer }) {
      const result = await pool.query(upsertLearningTeacherHumanNoteSql, [
        reportId,
        assignmentId,
        studentRef,
        noteText,
        reviewer.email,
        reviewer.canAccessAllClasses
      ]);
      const row = assertSingleRow(result, 'TEACHER_NOTE_DENIED', 'Không thể lưu lời nhắn cho tổng kết này.', 403);
      return {
        reportId: row.report_id,
        teacherEmail: row.teacher_email,
        noteText: row.note_text,
        updatedAt: row.updated_at
      };
    }
  };
}
