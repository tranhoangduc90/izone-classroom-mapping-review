import {createHash} from 'node:crypto';
import {gradeLearningSubmission, isAnswered, isConditionallyVisible} from './learning-domain.js';

// Nhận một bài hiện hành mỗi học viên và lần chấm hoàn tất mới nhất, trả thống kê xác định.
// Câu mở/tự khai/điều kiện ẩn không biến thành câu sai; không gọi AI hoặc thay dữ liệu gốc.
export function buildQuestionAnalytics({ assignmentId, definition, gradingKey = null, students, summaryOnly = false,
  itemVersionId = null, includeCheckpoints = false, includeDrafts = false, onCheckpointGradingError = () => {}, capturedAt = new Date().toISOString() }) {
  if (new Set(students.map(s=>s.studentRef)).size !== students.length) throw new Error('ANALYTICS_DUPLICATE_STUDENT');
  const items = definition.blocks.flatMap(block => block.items.map(item => ({blockId:block.blockId,item})))
    .filter(({item}) => !itemVersionId || item.itemVersionId === itemVersionId);
  const participants = includeCheckpoints ? students.map(student => {
    if (student.submissionId) return student;
    const draft = includeDrafts ? {...student.draftResponses} : null;
    if (!student.checkpoints?.length) return draft ? {...student, draft} : student;
    const checkpoints = new Map(student.checkpoints.map(row => [row.blockId, row.checkpointSubmissionId]));
    const responses = Object.assign({}, ...student.checkpoints.map(row => row.responses));
    const submittedItems = itemsInSubmittedBlocks(definition, checkpoints);
    if (draft) {
      // Một phần đã nộp sở hữu cả câu bỏ trống, kể cả khi nháp còn đáp án cũ.
      for (const item of submittedItems) delete draft[item.itemVersionId];
      Object.assign(draft, responses);
    }
    const visibleResponses = Object.fromEntries(submittedItems.filter(item => isConditionallyVisible(item, responses))
      .filter(item => Object.hasOwn(responses, item.itemVersionId)).map(item => [item.itemVersionId, responses[item.itemVersionId]]));
    const fallback = submittedItems.map(item => ({itemVersionId:item.itemVersionId,
      answerState:isAnswered(visibleResponses[item.itemVersionId]) ? 'answered' : 'blank'}));
    let results = [];
    if (gradingKey?.formVersionId) {
      try {
        results = gradeLearningSubmission({definition, gradingKey, responses:visibleResponses}).items;
      } catch (error) {
        onCheckpointGradingError(error.code || 'CHECKPOINT_GRADING_UNAVAILABLE');
      }
    }
    return {...student, checkpoints, draft, responses:visibleResponses,
      responseItems:results.length ? results : fallback, gradingItems:results, gradingStatus:'pending'};
  }) : students;
  const draftCountsByPart = new Map();
  if (includeDrafts) for (const block of definition.blocks) {
    draftCountsByPart.set(block.blockId, participants.filter(student =>
      !student.submissionId && !(student.checkpoints instanceof Map && student.checkpoints.has(block.blockId))
      && block.items.some(item => hasDraftAnswer(student.draft, item))).length);
  }
  const summaries = items.map(({blockId,item}) => {
    const textSlots=item.graderType==='accepted_text_sequence'&&item.layoutType==='numbered_short_texts';
    // Câu điền từ có đáp án dùng kết quả máy chủ; câu chỉ đối chiếu vẫn không tính sai.
    const scoredText=item.graderType==='accepted_text'&&item.interactionType==='short_text';
    const objective = item.maxScore > 0 && (textSlots || scoredText || item.graderType === 'exact_option'
      && item.interactionType === 'single_choice' || ['exact_option_set','exact_sequence'].includes(item.graderType));
    const counts = { roster: students.length, submitted:0, visible:0, hidden:0,
      unanswered:0, answered:0, graded:0, correct:0, incorrect:0, pending:0, manual:0, ungraded:0,
      ...(includeDrafts ? {draftAnswered:0} : {}) };
    const choices = new Map((item.options || []).map(option => [option.id,{optionId:option.id,label:option.label,count:0,incorrect:0,...(includeDrafts ? {draftCount:0} : {})}]));
    const studentResults = [];
    const snapshot = summaryOnly || itemVersionId ? createHash('sha256') : null;
    for (const student of participants) {
      const checkpointSubmissionId = includeCheckpoints && student.checkpoints instanceof Map ? student.checkpoints.get(blockId) : null;
      if (!student.submissionId && !checkpointSubmissionId) {
        if (!includeDrafts || !hasDraftAnswer(student.draft, item)) continue;
        counts.draftAnswered += 1;
        const value = student.draft[item.itemVersionId];
        const optionIds = [...new Set(Array.isArray(value) ? value : [value])].filter(id=>choices.has(id));
        for (const id of optionIds) choices.get(id).draftCount += 1;
        const row = {studentRef:student.studentRef,name:student.name,discriminator:student.discriminator||'',
          submissionId:null,answered:true,verdict:'ungraded',responseStatus:'draft',optionIds};
        snapshot?.update(JSON.stringify([row,'answered',value]));
        if (!summaryOnly) studentResults.push(itemVersionId ? {...row,answerState:'answered',answer:value} : row);
        continue;
      }
      counts.submitted += 1;
      const config = item.interactionConfig || {};
      if (!isConditionallyVisible(item, student.responses || {})) { counts.hidden += 1; continue; }
      counts.visible += 1;
      const response = student.responseItems?.find(answer => answer.itemVersionId === item.itemVersionId);
      const grading = student.gradingItems?.find(answer => answer.itemVersionId === item.itemVersionId);
      const answered = response?.answerState === 'answered';
      counts[answered ? 'answered' : 'unanswered'] += 1;
      const verdict = !objective || (!textSlots && !answered && !item.required && !config.requiredWhenVisible) ? 'ungraded'
        : textSlots && grading?.verdict === 'partial' ? 'incorrect'
        : ['correct','incorrect'].includes(grading?.verdict) ? grading.verdict
        : ['manual_review','failed'].includes(student.gradingStatus) || grading?.verdict === 'manual_review' ? 'manual_review' : 'pending';
      if (['correct','incorrect'].includes(verdict)) { counts.graded += 1; counts[verdict] += 1; }
      else counts[verdict === 'manual_review' ? 'manual' : verdict] += 1;
      const value = student.responses?.[item.itemVersionId];
      const values = Array.isArray(value) ? value : [value];
      for (const optionId of new Set(values)) {
        const choice = choices.get(optionId);
        if (choice) { choice.count += 1; if (verdict === 'incorrect') choice.incorrect += 1; }
      }
      const row = {studentRef:student.studentRef,name:student.name,discriminator:student.discriminator||'',submissionId:student.submissionId,
        ...(checkpointSubmissionId ? {checkpointSubmissionId} : {}), ...(includeDrafts ? {responseStatus:'submitted'} : {}),
        answered,verdict,optionIds:values.filter(id=>choices.has(id))};
      const answerState = response?.answerState || 'blank';
      snapshot?.update(JSON.stringify([row, answerState, value ?? null]));
      if (!summaryOnly) {
        studentResults.push(itemVersionId ? {...row, answerState, answer: value ?? null} : row);
      }
    }
    // Hàm này chỉ được gọi sau kiểm quyền giáo viên; không dùng output cho endpoint học viên.
    const key=gradingKey?.items?.[item.itemVersionId],optionLabel=id=>(item.options||[]).find(option=>option.id===id)?.label||id;
    const correctAnswer=key?.expectedOptionId?[optionLabel(key.expectedOptionId)]:key?.expectedOptionIds?.map(optionLabel)
      ||key?.accepted||key?.acceptedBySlot||null;
    return {itemVersionId:item.itemVersionId,position:item.position,prompt:item.prompt,
      options:(item.options||[]).map(option=>({...option})),correctAnswer,
      correctOptionIds:key?.expectedOptionId?[key.expectedOptionId]:key?.expectedOptionIds||[],
      referenceAnswer:gradingKey?.referenceAnswersBySlot?.[item.itemVersionId]||gradingKey?.referenceAnswers?.[item.itemVersionId]||null,
      explanation:gradingKey?.explanations?.[item.itemVersionId]||'',
      interactionType:item.interactionType,objective,...(textSlots?{gradingUnit:'text_slots'}:{}),counts,
      errorRate:counts.graded ? counts.incorrect/counts.graded : null,
      choices:[...choices.values()].sort((a,b)=>b.incorrect-a.incorrect || b.count-a.count),
      ...(snapshot ? {responseVersion: snapshot.digest('base64url')} : {}),
      ...(!summaryOnly ? {students:studentResults} : {})};
  });
  const submittedCount = participants.filter(student => student.submissionId || (includeCheckpoints && student.checkpoints instanceof Map)).length;
  const parts = includeCheckpoints ? definition.blocks.map(block => ({blockId:block.blockId,
    submittedCount:participants.filter(student => student.submissionId || student.checkpoints instanceof Map && student.checkpoints.has(block.blockId)).length,
    ...(includeDrafts ? {draftCount:draftCountsByPart.get(block.blockId)} : {})})) : null;
  return {assignmentId,formVersionId:definition.formVersionId,capturedAt,rosterCount:students.length,
    submittedCount,...(parts ? {parts} : {}),...(includeDrafts ? {draftAnalytics:true} : {}),items:summaries};
}

function hasDraftAnswer(draft, item) {
  return draft && isConditionallyVisible(item, draft) && isAnswered(draft[item.itemVersionId]);
}

function itemsInSubmittedBlocks(definition, checkpoints) {
  return definition.blocks.filter(block => checkpoints.has(block.blockId)).flatMap(block => block.items);
}

function questionAnalyticsSql(singleItem, includeCheckpoints = false, includeDrafts = false) {
  const target = singleItem ? ' AND response.item_version_id = $2::uuid' : '';
  const gradeTarget = singleItem ? ' AND result.item_version_id = $2::uuid' : '';
  const responses = singleItem ? 'jsonb_build_object($2::uuid::text, submission.response_payload -> $2::uuid::text, COALESCE($3::text, $2::uuid::text), submission.response_payload -> COALESCE($3::text, $2::uuid::text))' : 'submission.response_payload';
  const checkpoints = includeCheckpoints ? `,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('blockId', checkpoint.block_id::text,
    'checkpointSubmissionId', checkpoint.id::text, 'responses', checkpoint.response_payload))
    FROM (SELECT DISTINCT ON (accepted.block_id) accepted.id, accepted.block_id, accepted.response_payload
      FROM learning.checkpoint_submission AS accepted
      WHERE accepted.attempt_id = status.attempt_id AND accepted.assignment_id = assignment.id
        AND accepted.form_version_id = assignment.form_version_id AND accepted.student_ref = status.student_ref
        AND submission.id IS NULL
      ORDER BY accepted.block_id, accepted.checkpoint_revision DESC, accepted.submitted_at DESC, accepted.id DESC
    ) AS checkpoint), '[]'::jsonb) AS checkpoints` : '';
  const draftColumn = includeDrafts ? ', draft.draft AS "draftResponses"' : '';
  const draftJoin = includeDrafts ? `
LEFT JOIN learning.attempt AS draft ON draft.id = status.attempt_id
  AND draft.assignment_id = assignment.id AND draft.student_ref = status.student_ref
  AND draft.form_version_id = assignment.form_version_id
  AND draft.status = 'active' AND draft.draft_revision > 0
  AND submission.id IS NULL` : '';
  return `SELECT
  status.student_ref::text AS "studentRef", status.student_name_snapshot AS name,
  status.display_discriminator AS discriminator,
  submission.id::text AS "submissionId", ${responses} AS responses,
  COALESCE(grading.status, submission.grading_status) AS "gradingStatus",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('itemVersionId', response.item_version_id::text,
    'answerState', response.answer_state)) FROM learning.response_item AS response
    WHERE response.submission_id = submission.id${target}), '[]'::jsonb) AS "responseItems",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('itemVersionId', result.item_version_id::text,
    'verdict', result.verdict)) FROM learning.grading_result_item AS result
    WHERE result.grading_run_id = grading.id${gradeTarget}), '[]'::jsonb) AS "gradingItems"${checkpoints}${draftColumn}
FROM learning.assignment_student_status AS status
JOIN learning.form_assignment AS assignment ON assignment.id = status.assignment_id
LEFT JOIN learning.submission AS submission ON submission.id = status.submission_id
  AND submission.assignment_id = status.assignment_id
  AND submission.student_ref = status.student_ref
  AND submission.form_version_id = assignment.form_version_id${draftJoin}
LEFT JOIN LATERAL (
  SELECT run.id, run.status FROM learning.grading_run AS run
  WHERE run.submission_id = submission.id
  ORDER BY (run.status = 'complete') DESC, run.completed_at DESC NULLS LAST, run.created_at DESC, run.id DESC
  LIMIT 1
) AS grading ON true
WHERE status.assignment_id = $1::uuid
ORDER BY status.student_ref;`;
}

export const fetchQuestionAnalyticsSql = questionAnalyticsSql(false);
export const fetchQuestionResponsesSql = questionAnalyticsSql(true);
export const fetchQuestionAnalyticsWithCheckpointsSql = questionAnalyticsSql(false, true);
export const fetchQuestionResponsesWithCheckpointsSql = questionAnalyticsSql(true, true);
export const fetchQuestionAnalyticsWithDraftsSql = questionAnalyticsSql(false, true, true);
export const fetchQuestionResponsesWithDraftsSql = questionAnalyticsSql(true, true, true);
