// Nhận một bài hiện hành mỗi học viên và lần chấm hoàn tất mới nhất, trả thống kê xác định.
// Câu mở/tự khai/điều kiện ẩn không biến thành câu sai; không gọi AI hoặc thay dữ liệu gốc.
export function buildQuestionAnalytics({ assignmentId, definition, students, capturedAt = new Date().toISOString() }) {
  if (new Set(students.map(s=>s.studentRef)).size !== students.length) throw new Error('ANALYTICS_DUPLICATE_STUDENT');
  const items = definition.blocks.flatMap(block => block.items);
  const summaries = items.map(item => {
    const objective = item.graderType === 'exact_option' && item.maxScore > 0
      && item.interactionType === 'single_choice';
    const counts = { roster: students.length, submitted:0, visible:0, hidden:0,
      unanswered:0, answered:0, graded:0, correct:0, incorrect:0, pending:0, manual:0, ungraded:0 };
    const choices = new Map((item.options || []).map(option => [option.id,{optionId:option.id,label:option.label,count:0,incorrect:0}]));
    const studentResults = [];
    for (const student of students) {
      if (!student.submissionId) continue;
      counts.submitted += 1;
      const config = item.interactionConfig || {};
      const dependency = config.visibleWhenItemVersionId;
      const selection = student.responses?.[dependency];
      const visible = !dependency || (Array.isArray(selection)
        ? selection.includes(config.visibleWhenValue) : selection === config.visibleWhenValue);
      if (!visible) { counts.hidden += 1; continue; }
      counts.visible += 1;
      const response = student.responseItems?.find(answer => answer.itemVersionId === item.itemVersionId);
      const grading = student.gradingItems?.find(answer => answer.itemVersionId === item.itemVersionId);
      const answered = response?.answerState === 'answered';
      counts[answered ? 'answered' : 'unanswered'] += 1;
      const verdict = !objective || (!answered && !item.required && !config.requiredWhenVisible) ? 'ungraded'
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
      studentResults.push({studentRef:student.studentRef,name:student.name,discriminator:student.discriminator||'',submissionId:student.submissionId,
        answered,verdict,optionIds:values.filter(id=>choices.has(id))});
    }
    return {itemVersionId:item.itemVersionId,position:item.position,prompt:item.prompt,
      interactionType:item.interactionType,objective,counts,
      errorRate:counts.graded ? counts.incorrect/counts.graded : null,
      choices:[...choices.values()].sort((a,b)=>b.incorrect-a.incorrect || b.count-a.count),students:studentResults};
  });
  return {assignmentId,formVersionId:definition.formVersionId,capturedAt,rosterCount:students.length,
    submittedCount:students.filter(s=>s.submissionId).length,items:summaries};
}

export const fetchQuestionAnalyticsSql = `SELECT
  status.student_ref::text AS "studentRef", status.student_name_snapshot AS name,
  status.display_discriminator AS discriminator,
  submission.id::text AS "submissionId", submission.response_payload AS responses,
  COALESCE(grading.status, submission.grading_status) AS "gradingStatus",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('itemVersionId', response.item_version_id::text,
    'answerState', response.answer_state)) FROM learning.response_item AS response
    WHERE response.submission_id = submission.id), '[]'::jsonb) AS "responseItems",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('itemVersionId', result.item_version_id::text,
    'verdict', result.verdict)) FROM learning.grading_result_item AS result
    WHERE result.grading_run_id = grading.id), '[]'::jsonb) AS "gradingItems"
FROM learning.assignment_student_status AS status
LEFT JOIN learning.submission AS submission ON submission.id = status.submission_id
LEFT JOIN LATERAL (
  SELECT run.id, run.status FROM learning.grading_run AS run
  WHERE run.submission_id = submission.id
  ORDER BY (run.status = 'complete') DESC, run.completed_at DESC NULLS LAST, run.created_at DESC, run.id DESC
  LIMIT 1
) AS grading ON true
WHERE status.assignment_id = $1::uuid
ORDER BY status.student_ref;`;
