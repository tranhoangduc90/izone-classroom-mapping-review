import crypto from 'node:crypto';
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
  completeLearningAttemptSql,
  fetchAssignmentStudentSql,
  fetchAttendanceForUpdateSql,
  fetchLearningAttemptContextSql,
  fetchLearningLibraryItemsSql,
  fetchLearningRosterForClassSql,
  fetchLearningTeacherDashboardSql,
  fetchPublicLearningAssignmentSql,
  findLearningSubmissionSql,
  insertLearningAssignmentRosterSql,
  insertLearningAssignmentSql,
  insertLearningAttemptSql,
  insertLearningAttendanceEventSql,
  insertLearningEvidenceSql,
  insertLearningFormGradingKeySql,
  insertLearningFormTemplateSql,
  insertLearningFormVersionSql,
  insertLearningGradingResultItemSql,
  insertLearningGradingRunSql,
  insertLearningOutboxSql,
  insertLearningResponseItemSql,
  insertLearningSubmissionSql,
  listLearningQuestionLibrarySql,
  listLearningTeacherOptionsSql,
  overrideLearningAttendanceSql,
  saveLearningDraftSql,
  upsertLearningAttendanceSql
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

function asArray(value) {
  if (!value) return [];
  return typeof value === 'string' ? JSON.parse(value) : value;
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
    roster: asArray(row.roster)
  };
}

function internalResultFromRow(row) {
  return asObject(row.result_json);
}

export function createLearningService({ pool }) {
  if (!pool) throw new Error('Learning service cần database pool riêng.');

  return {
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
        return {
          attemptToken: attempt.attempt_token,
          assignmentId: attempt.assignment_id,
          formVersionId: attempt.form_version_id,
          definitionHash: attempt.definition_hash,
          draft: asObject(attempt.draft),
          draftRevision: Number(attempt.draft_revision),
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
              asObject(existing.public_definition)
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

        const definition = parseFormDefinition(asObject(context.public_definition));
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
          quizResult
        });

        await client.query(insertLearningSubmissionSql, [
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
          receivedAt
        ]);

        const itemById = new Map(definition.blocks.flatMap(block => block.items).map(item => [item.itemVersionId, item]));
        for (const resultItem of quizResult.items) {
          const item = itemById.get(resultItem.itemVersionId);
          if (!item || resultItem.itemFamilyId !== item.itemFamilyId) {
            throw new LearningError('RESULT_ITEM_IDENTITY_MISMATCH', 'Kết quả chấm không khớp câu hỏi.', 500);
          }
          await client.query(insertLearningResponseItemSql, [
            submissionId,
            resultItem.itemVersionId,
            resultItem.itemFamilyId,
            resultItem.position,
            item.interactionType,
            resultItem.pedagogicalTypeCode,
            json(resultItem.skillCodes),
            json(resultItem.rawAnswer),
            resultItem.answerState
          ]);
        }

        const operationKey = `grade:${submissionId}:v${quizResult.graderVersion}`;
        const gradingRunResult = await client.query(insertLearningGradingRunSql, [
          submissionId,
          quizResult.graderVersion,
          operationKey,
          `${operationKey}:write`,
          quizResult.gradingStatus,
          json(quizResult)
        ]);
        const gradingRun = assertSingleRow(gradingRunResult, 'GRADING_RUN_NOT_CREATED', 'Không lưu được lượt chấm.', 500);
        for (const resultItem of quizResult.items) {
          await client.query(insertLearningGradingResultItemSql, [
            gradingRun.grading_run_id,
            resultItem.itemVersionId,
            json(resultItem.rawAnswer),
            json(resultItem.normalizedAnswer),
            json(resultItem.expectedAnswer ?? null),
            resultItem.answerState,
            resultItem.verdict,
            resultItem.scoreEarned,
            resultItem.maxScore
          ]);
        }

        const previousAttendance = await client.query(fetchAttendanceForUpdateSql, [
          context.assignment_id,
          context.student_ref
        ]);
        const attendanceStatus = completeness.complete ? 'self_confirmed' : 'pending_teacher';
        const attendanceReason = completeness.complete ? 'Nộp đủ mục bắt buộc.' : 'Phiếu còn thiếu mục bắt buộc.';
        await client.query(upsertLearningAttendanceSql, [
          context.assignment_id,
          context.student_ref,
          attendanceStatus,
          submissionId,
          attendanceReason
        ]);
        await client.query(insertLearningAttendanceEventSql, [
          context.assignment_id,
          context.student_ref,
          previousAttendance.rows[0]?.status || null,
          attendanceStatus,
          submissionId,
          attendanceReason,
          `attendance:${submissionId}:v1`
        ]);

        await client.query(insertLearningEvidenceSql, [
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
          evidence.context.studentRef,
          evidence.context.formVersionId,
          evidence.context.assignmentId,
          evidence.context.submissionId,
          evidence.visibility,
          json(evidence.payload),
          evidence.contentHash,
          evidence.rendererVersion,
          evidence.markdown,
          evidence.occurredAt,
          evidence.ingestedAt
        ]);

        await client.query(insertLearningOutboxSql, [
          'analyze_submission',
          evidence.entityKey,
          evidence.unitKey,
          `analyze:${submissionId}:v1`,
          `analyze:${submissionId}:enqueue:v1`,
          json({
            schemaVersion: 'LearningAnalysisJobV1',
            evidenceId: evidence.evidenceId,
            submissionId,
            studentRef: context.student_ref,
            assignmentId: context.assignment_id
          })
        ]);
        const completed = await client.query(completeLearningAttemptSql, [context.attempt_id, receivedAt]);
        if (completed.rowCount !== 1) {
          throw new LearningError('ATTEMPT_FINALIZE_FAILED', 'Không thể chốt phiên làm bài.', 409);
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
        result: buildStudentQuizResult(internalResultFromRow(row), asObject(row.public_definition))
      };
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
                options: [],
                skillCodes: [],
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
        return {
          assignmentId: assignment.assignment_id,
          publicToken: assignment.public_token,
          formVersionId,
          definitionHash,
          rosterCount: rosterResult.rowCount
        };
      });
    },

    async getTeacherDashboard({ assignmentId, reviewer }) {
      const result = await pool.query(fetchLearningTeacherDashboardSql, [
        assignmentId,
        reviewer.email,
        reviewer.canAccessAllClasses
      ]);
      const row = assertSingleRow(result, 'ASSIGNMENT_ACCESS_DENIED', 'Không tìm thấy phiếu trong phạm vi được cấp quyền.', 404);
      return {
        assignmentId: row.assignment_id,
        title: row.title,
        sessionNumber: Number(row.session_number),
        className: row.class_name,
        publicToken: row.public_token,
        status: row.status,
        students: asArray(row.students)
      };
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
        decidedAt: row.decided_at
      };
    }
  };
}
