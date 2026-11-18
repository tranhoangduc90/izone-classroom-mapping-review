export function term1SubmissionGuardError(cause) {
  const competing = ['P6741','P6751','P6761'].includes(cause?.code) || (
    cause?.code === '23505' && ['uq_term1_new_official_attempt','uq_term2_new_official_attempt','uq_pretest_new_official_attempt'].includes(cause.constraint)
  );
  if (competing || ['P6742','P6752','P6762'].includes(cause?.code)) {
    return Object.assign(new Error('Bài này đã có lần nộp hợp lệ. Hãy mở lại bài để xem tiến độ chính thức.'), {
      code: 'EXAM_FIRST_SUBMISSION_ACCEPTED', status: 409,
    });
  }
  return null;
}
