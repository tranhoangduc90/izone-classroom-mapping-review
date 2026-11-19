import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const writingFile = 'term-online-writing.mjs';
export const servingWritingSha = '605b05e736755bc437d726ed4974d2760076a4f96bde43ea2b421affa16805a7';
const servingSqlSha = '2e9812eb5654248f8671e2dc2280a052e1fd58e49fd0a882cc7f8f91412a198f';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length,2,before);
  return source.replace(before, () => after);
}

export function paperWritingSql(bytes) {
  assert.equal(sha256(bytes),servingSqlSha,'Unexpected serving K56 Writing SQL');
  const file = bytes.toString('utf8').replaceAll('\r\n','\n');
  const original = /^export const saveK56TermWritingSql = `([^`]+)`;/m.exec(file)?.[1];
  assert.ok(original,'Cannot read serving Writing SQL');
  let sql = replaceOnce(original,`  SELECT * FROM assessment.term_test_attempt
  WHERE id=$1::uuid AND completed_at IS NOT NULL
    AND test_slug IN ('term-test-1-k56','term-test-2-k56') AND superseded_at IS NULL
  FOR UPDATE`,
    `  SELECT source.* FROM assessment.term_test_attempt source
  JOIN assessment.term_test_exam_session session
    ON session.id=source.exam_session_id AND session.generation=source.generation
  JOIN assessment.term_test_attempt official
    ON official.id=$8::uuid AND official.test_slug=source.test_slug AND official.attempt_mode=source.attempt_mode
    AND official.erp_course_class_id=source.erp_course_class_id AND official.erp_student_contact_id=source.erp_student_contact_id
    AND official.generation=source.generation AND official.definition_version=source.definition_version
  WHERE source.id=$1::uuid AND source.test_slug='term-test-2-k56' AND source.superseded_at IS NULL
    AND session.term2_paper_profile_id IS NOT NULL AND session.superseded_at IS NULL
    AND official.superseded_at IS NULL AND official.term2_official_submission AND official.completed_at IS NOT NULL
  FOR UPDATE OF source`);
  // The decision, revision and late fallback all come from the submitting
  // profile. Only an accepted finalize can write into the official row.
  for (const column of ['writing_outline','writing_task_1','writing_task_2']) {
    sql = replaceOnce(sql,column==='writing_outline'
      ? 'coalesce($7::text,attempt.writing_outline) ELSE attempt.writing_outline'
      : 'ELSE attempt.'+column,column==='writing_outline'
      ? 'coalesce($7::text,decision.writing_outline) ELSE decision.writing_outline' : 'ELSE decision.'+column);
  }
  sql = replaceOnce(sql,'    updated_at=decision.request_at',
    `    term2_paper_private_writing=attempt.term2_paper_private_writing OR
      ($4::text <> 'submit' AND decision.id <> $8::uuid),
    updated_at=decision.request_at`);
  sql = replaceOnce(sql,'  WHERE attempt.id=decision.id',
    `  WHERE attempt.id=CASE WHEN $4::text='submit' THEN $8::uuid ELSE decision.id END
    AND attempt.writing_submitted_at IS NULL`);
  return replaceOnce(sql,'FROM resolved JOIN decision ON decision.id=resolved.id;',
    'FROM resolved CROSS JOIN decision;');
}

export function assembleWriting(bytes, sqlBytes) {
  assert.equal(sha256(bytes),servingWritingSha,'Unexpected serving online Writing route');
  let source = bytes.toString('utf8').replaceAll('\r\n','\n');
  function edit(before, after) {
    source = replaceOnce(source,before,after);
  }
  edit('const reviewCodes = {',`const paperDraftSchema = requestSchema.omit({ recovery:true }).extend({
  generation: z.number().int().nonnegative().safe(),
  action: z.enum(['start','draft'])
});
const paperSql = ${JSON.stringify(paperWritingSql(sqlBytes))};

const reviewCodes = {`);
  edit(`  onWriting, readWritingResponse, serializeWriting, notifyWriting
}) {
  router.post('/:testSlug/writing/finalize'`,
    `  onWriting, readWritingResponse, serializeWriting, notifyWriting, lockPaperWriting, loadPaperWriting, paperTarget
}) {
  function writingMinutes(a) {
    const minutes = (a.mini_definition_snapshot?.timing || assets?.getTiming(a.test_slug))?.writingDurationMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw failure('DEFINITION_CHANGED', 'Chưa xác minh được thời gian của đề Writing.', 409);
    return minutes;
  }

  router.post('/:testSlug/writing/draft', limiter, route(async (req,res,next) => {
    const slug = req.params.testSlug;
    if (slug !== 'term-test-2-k56') return next();
    const parsed = paperDraftSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.task2 !== '')
      throw failure('INVALID_WRITING', 'Bản nháp Writing không hợp lệ.', 400);
    const {attemptToken, generation, action, task1, task2, outline, baseRevision} = parsed.data;
    const saved = await transaction(async client => {
      await lockPaperWriting(client,slug,attemptToken);
      const scope = await loadPaperWriting(client,slug,attemptToken,generation);
      const official = await paperTarget(client,scope,true);
      if (official.writing_submitted_at) {
        return {writing:(await readWritingResponse(client,official)).writing,
          accepted:false,reason:'already_submitted',officialToken:official.attempt_token};
      }
      const {rows:[row]} = await client.query(paperSql,[attemptToken,task1,task2,action,
        writingMinutes(scope),baseRevision,outline,official.attempt_token]);
      if (!row) throw failure('WRITING_ATTEMPT_NOT_READY', 'Hãy hoàn tất Nghe và Đọc trước khi làm Writing.', 409);
      return {writing:serializeWriting(row,null), accepted:row.writing_accepted === true,
        reason:row.writing_reason,officialToken:official.attempt_token};
    });
    record('draft_saved',slug,attemptToken,{section:'writing',revision:saved.writing.revision,
      accepted:saved.accepted,reason:saved.reason,
      ...(saved.officialToken !== attemptToken ? {officialAttemptToken:saved.officialToken} : {})});
    res.set('Cache-Control','no-store, private').json({ok:true,attemptToken,
      writing:{...saved.writing,accepted:saved.accepted,reason:saved.reason}});
  }));

  router.post('/:testSlug/writing/finalize'`);
  edit(`      const a = await recovery.admit(client, slug, proof, 'writing', true);
      const response = await recovery.finishIfReplayed(client, a, retained);
      if (response) return { receipt: response, row: a, writing: (await readWritingResponse(client, a)).writing };
      const timing = a.mini_definition_snapshot?.timing || assets?.getTiming(slug);
      if (!Number.isFinite(timing?.writingDurationMinutes) || timing.writingDurationMinutes <= 0) {
        throw failure('DEFINITION_CHANGED', 'Chưa xác minh được thời gian của đề Writing.', 409);
      }
      const { rows: [row] } = await client.query(saveK56TermWritingSql, [
        attemptToken, task1, task2, 'submit', timing.writingDurationMinutes, baseRevision, outline
      ]);`,
    `      await lockPaperWriting(client,slug,attemptToken);
      const scope = await recovery.admit(client, slug, proof, 'writing', true);
      const a = await paperTarget(client,scope,true);
      const paper = Boolean(scope.term2_paper_profile_id);
      const response = await recovery.finishIfReplayed(client, scope, retained);
      if (response) {
        if (response.officialAttemptToken && response.officialAttemptToken !== a.attempt_token)
          throw failure('SUBMISSION_RECOVERY_SCOPE', 'Không tìm thấy bài chính thức của biên nhận này.', 409);
        return {receipt:response,row:a,writing:(await readWritingResponse(client,a)).writing};
      }
      if (paper && a.writing_submitted_at)
        return {row:a,review:'WRITING_ALREADY_RECEIVED',reason:'already_submitted'};
      const { rows: [row] } = await client.query(paper ? paperSql : saveK56TermWritingSql, [
        attemptToken, task1, task2, 'submit', writingMinutes(scope), baseRevision, outline,
        ...(paper ? [a.attempt_token] : [])
      ]);`);
  edit('await recovery.finish(client, { ...a, ...row }, retained);',
    'await recovery.finish(client, { ...a, ...row }, retained, scope);');
  edit('[attemptToken, grading.version]) : { rows: [] };',
    '[a.attempt_token, grading.version]) : { rows: [] };');
  edit(`    record('offline_operation_committed', slug, attemptToken, { ...meta, phase: 'after_commit',
      receiptId: saved.receipt.receiptId, accepted: true, replayed: !saved.canonicalCommitted });`,
    `    const linked = saved.receipt.officialAttemptToken ? {officialAttemptToken:saved.receipt.officialAttemptToken} : {};
    record('offline_operation_committed', slug, attemptToken, { ...meta, ...linked, phase: 'after_commit',
      receiptId: saved.receipt.receiptId, accepted: true, replayed: !saved.canonicalCommitted });`);
  edit('      ...meta, phase: \'after_commit\', receiptId: saved.receipt.receiptId, jobId:',
    '      ...meta, ...linked, phase: \'after_commit\', receiptId: saved.receipt.receiptId, jobId:');
  return source;
}
