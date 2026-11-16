import { createHash, randomUUID } from 'node:crypto';
import { audioTransaction } from './audio-incidents.js';
import { assertAudioOwner } from './audio-owner.js';
import { buildCombinedResult } from './term-tests.js';

export class Term1ContinuationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 409;
  }
}

export async function openTerm1ListeningContinuation(db, official, token) {
  const args = [official.id, official.generation, token || null];
  const previous = (await db.query(`SELECT s.* FROM assessment.term1_listening_continuation c
    JOIN assessment.term_test_exam_session s ON s.id=c.exam_session_id
    WHERE c.official_attempt_id=$1 AND c.official_generation=$2 AND c.exam_session_id=$3
      AND s.superseded_at IS NULL`,args)).rows[0];
  if (previous) return previous;

  const session = (await db.query(`INSERT INTO assessment.term_test_exam_session
    (test_slug,definition_version,erp_course_class_id,erp_student_contact_id,class_name_snapshot,
      student_name_snapshot,attempt_mode,exam_mode,term1_parallel_entry)
    VALUES('term-test-1',$1,$2,$3,$4,$5,'cbt','lis_first',true) RETURNING *`,
  [official.definition_version,official.erp_course_class_id,official.erp_student_contact_id,
    official.class_name_snapshot,official.student_name_snapshot])).rows[0];
  await db.query(`INSERT INTO assessment.term1_listening_continuation
    (exam_session_id,official_attempt_id,official_generation) VALUES($1,$2,$3)`,
  [session.id,official.id,official.generation]);
  return session;
}

export async function commitTerm1ListeningContinuation(pool, session, input, definition, evaluateSubmission) {
  const {examSessionToken,clientSubmissionId} = input;
  const ref = await pool.query(`SELECT 1 FROM assessment.term1_listening_continuation WHERE exam_session_id=$1`,[examSessionToken]);
  if (!ref.rowCount) return null;
  const payloadHash = createHash('sha256').update(JSON.stringify({
    answers:Object.entries(input.answers).sort(([a],[b])=>Number(a)-Number(b)),revision:input.draftRevision ?? null,
  })).digest('hex');

  return audioTransaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`term-test-1:${session.class_id}:${session.student_id}`]);
    const grant = (await db.query(`SELECT * FROM assessment.term1_listening_continuation
      WHERE exam_session_id=$1 FOR UPDATE`,[examSessionToken])).rows[0];
    if (!grant) throw new Term1ContinuationError('EXAM_SESSION_REQUIRED','Hãy xác nhận lại tên để mở phần còn lại.');
    const official = (await db.query(`SELECT * FROM assessment.term_test_attempt
      WHERE id=$1 AND generation=$2 AND test_slug='term-test-1' AND definition_version=$3
        AND erp_course_class_id=$4 AND erp_student_contact_id=$5 AND superseded_at IS NULL FOR UPDATE`,
    [grant.official_attempt_id,grant.official_generation,session.definition_version,session.class_id,session.student_id])).rows[0];
    const child = (await db.query(`SELECT * FROM assessment.term_test_exam_session
      WHERE id=$1 AND superseded_at IS NULL FOR UPDATE`,[examSessionToken])).rows[0];
    if (!official?.reading_submitted_at || !child?.listening_started_at || !official.exam_session_id) {
      throw new Term1ContinuationError('EXAM_SESSION_REQUIRED','Lượt đã thay đổi. Hãy xác nhận lại tên để đọc tiến độ.');
    }
    assertAudioOwner(child);
    if (grant.receipt) {
      if (grant.operation_id===clientSubmissionId && grant.payload_hash===payloadHash) return {receipt:grant.receipt};
      throw new Term1ContinuationError('EXAM_FIRST_SUBMISSION_ACCEPTED','Listening đã có bài được ghi nhận.');
    }
    if (official.listening_submitted_at || official.listening_interrupted_at || child.listening_audio_incident_id) {
      throw new Term1ContinuationError('EXAM_FIRST_SUBMISSION_ACCEPTED','Tiến độ Listening đã thay đổi. Hãy mở lại bài.');
    }
    const {rows:[clock]} = await db.query(`SELECT clock_timestamp() > $1::timestamptz AS listening_timed_out,
      clock_timestamp() <= $1::timestamptz + interval '5 minutes' AS listening_submission_grace_active`,[child.listening_deadline_at]);
    const {answers, listeningResult, source} = evaluateSubmission({...child,...clock});
    const combined = buildCombinedResult(definition,listeningResult,official.reading_result);
    await db.query("SELECT set_config('k67.term1_listening_continuation',$1,true)",[child.id]);
    const received = (await db.query(`UPDATE assessment.term_test_attempt
      SET listening_answers=$2, listening_result=$3, listening_submitted_at=clock_timestamp(),
        combined_result=$4, completed_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE id=$1 RETURNING listening_submitted_at`,
    [official.id,JSON.stringify(answers),JSON.stringify(listeningResult),JSON.stringify(combined)])).rows[0].listening_submitted_at;
    const marked = await db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=$3,
      listening_deadline_at=$4,listening_submitted_at=$5,updated_at=clock_timestamp()
      WHERE id=$1 AND generation=$2 AND superseded_at IS NULL`,
    [official.exam_session_id,official.generation,child.listening_started_at,child.listening_deadline_at,received]);
    if (marked.rowCount!==1) throw new Term1ContinuationError('EXAM_SESSION_REQUIRED','Lượt đã thay đổi. Hãy xác nhận lại tên.');
    await db.query(`UPDATE assessment.term_test_exam_session SET listening_submitted_at=$2,updated_at=clock_timestamp()
      WHERE id=$1`,[child.id,received]);
    const completed = official.writing_scope==='lr_only';
    const receipt = {receiptId:randomUUID(),operationId:clientSubmissionId,section:'listening',nextSection:completed?'result':'writing',
      completed,result:combined,examSessionToken:child.id,receivedAt:new Date(received).toISOString()};
    await db.query(`UPDATE assessment.term1_listening_continuation SET operation_id=$2,payload_hash=$3,receipt=$4
      WHERE exam_session_id=$1`,[child.id,clientSubmissionId,payloadHash,JSON.stringify(receipt)]);
    return {receipt, official, answers, source, timedOut:clock.listening_timed_out};
  });
}
