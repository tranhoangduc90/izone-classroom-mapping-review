export function term1SubmissionGuardError(cause) {
  const competing = cause?.code === 'P6741' || (
    cause?.code === '23505' && cause.constraint === 'uq_term1_new_official_attempt'
  );
  if (competing || cause?.code === 'P6742') {
    return Object.assign(new Error('Bài này đã có lần nộp hợp lệ. Hãy mở lại bài để xem tiến độ chính thức.'), {
      code: 'EXAM_FIRST_SUBMISSION_ACCEPTED', status: 409,
    });
  }
  return null;
}
