import { createHash, randomUUID } from 'node:crypto';
import { audioTransaction } from './audio-incidents.js';
import { assertAudioOwner } from './audio-owner.js';
import { buildCombinedResult } from './term-tests.js';

export function term1ParallelEntryInUse(config) {
  return config.term1ParallelEntryMode==='on' || config.term1ParallelEntryMode==='drain';
}

export function continuationTable(slug) {
  return slug==='term-test-2' ? 'assessment.term2_section_continuation' : 'assessment.term1_section_continuation';
}

export class Term1ContinuationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 409;
  }
}

export async function createParallelReadingDraft(db, session) {
  const {rows:[attempt]} = await db.query(`INSERT INTO assessment.term_test_attempt
    (client_submission_id,test_slug,definition_version,erp_course_class_id,erp_student_contact_id,
      class_name_snapshot,student_name_snapshot,exam_session_id,attempt_mode,exam_mode,exam_delivery,generation)
    VALUES($1,$9,$2,$3,$4,$5,$6,$7,'cbt','read_first','cbt',$8) RETURNING id`,
  [randomUUID(),session.definition_version,session.erp_course_class_id,session.erp_student_contact_id,
    session.class_name_snapshot,session.student_name_snapshot,session.id,session.generation,session.test_slug]);
  await db.query('UPDATE assessment.term_test_exam_session SET attempt_id=$2 WHERE id=$1',[session.id,attempt.id]);
  return attempt.id;
}

export async function openTermSectionContinuation(db, official, token, section) {
  const table = continuationTable(official.test_slug);
  const parallelFlag = official.test_slug==='term-test-2' ? 'term2_parallel_entry' : 'term1_parallel_entry';
  const args = [official.id, official.generation, token || null, section];
  const previous = (await db.query(`SELECT s.* FROM ${table} c
    JOIN assessment.term_test_exam_session s ON s.id=c.exam_session_id
    WHERE c.official_attempt_id=$1 AND c.official_generation=$2 AND c.exam_session_id=$3
      AND c.section=$4 AND s.superseded_at IS NULL`,args)).rows[0];
  if (previous) return previous;

  const examMode = section==='reading' ? 'read_first' : 'lis_first';
  const key = [official.definition_version,official.erp_course_class_id,official.erp_student_contact_id];
  // Reuse only the requesting profile's original session for this skill. Its draft,
  // timers, audio owner and existing offline permit stay bound to the same scope.
  let session = token && section!=='writing' && (await db.query(`SELECT s.*
    FROM assessment.term_test_exam_session s
    LEFT JOIN assessment.term_test_attempt a ON a.id=s.attempt_id
    WHERE s.id=$4 AND s.test_slug=$6 AND s.definition_version=$1
      AND s.erp_course_class_id=$2 AND s.erp_student_contact_id=$3
      AND s.exam_mode=$5 AND s.${parallelFlag} AND s.superseded_at IS NULL
      AND s.listening_submitted_at IS NULL AND s.listening_audio_incident_id IS NULL
      AND s.prepared_at >= clock_timestamp()-interval '72 hours'
      AND ($5='lis_first' AND s.attempt_id IS NULL OR $5='read_first'
        AND a.id IS NOT NULL AND a.exam_session_id=s.id AND a.generation=s.generation
        AND a.superseded_at IS NULL AND a.reading_submitted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM ${table} c WHERE c.exam_session_id=s.id)
    FOR UPDATE OF s`, [...key,token,examMode,official.test_slug])).rows[0];
  if (!session) {
    session = (await db.query(`INSERT INTO assessment.term_test_exam_session
      (test_slug,definition_version,erp_course_class_id,erp_student_contact_id,class_name_snapshot,
        student_name_snapshot,attempt_mode,exam_mode,${parallelFlag})
      VALUES($7,$1,$2,$3,$4,$5,'cbt',$6,true) RETURNING *`,
    [...key,official.class_name_snapshot,official.student_name_snapshot,examMode,official.test_slug])).rows[0];
    if (section==='reading') session.attempt_id = await createParallelReadingDraft(db,session);
  }
  await db.query(`INSERT INTO ${table}
    (exam_session_id,official_attempt_id,official_generation,section) VALUES($1,$2,$3,$4)`,
  [session.id,official.id,official.generation,section]);
  return session;
}

export async function commitTerm1ListeningContinuation(pool, session, input, definition, evaluateSubmission) {
  const {examSessionToken,clientSubmissionId} = input;
  const ref = await pool.query(`SELECT 1 FROM assessment.term1_section_continuation WHERE exam_session_id=$1 AND section='listening'`,[examSessionToken]);
  if (!ref.rowCount) return null;
  const payloadHash = submissionHash(input);

  return audioTransaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`term-test-1:${session.class_id}:${session.student_id}`]);
    const grant = await term1ContinuationGrant(db,examSessionToken,'listening');
    if (!grant) throw new Term1ContinuationError('EXAM_SESSION_REQUIRED','Hãy xác nhận lại tên để mở phần còn lại.');
    const official = await lockOfficial(db,grant,session.definition_version,session.class_id,session.student_id);
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
    const receipt = await writeOfficialListening(db,grant,official,child,clientSubmissionId,payloadHash,definition,answers,listeningResult);
    return {receipt, official, answers, source, timedOut:clock.listening_timed_out};
  });
}

async function writeOfficialListening(db,grant,official,child,operationId,hash,definition,answers,grade,offline=false) {
  const combined = buildCombinedResult(definition,grade,official.reading_result);
  if(offline)await db.query("SELECT set_config('k67.term_journey',$1,true)",[official.exam_session_id]);
  const setting=official.test_slug==='term-test-2'?'k67.term2_listening_continuation':'k67.term1_listening_continuation';
  await db.query('SELECT set_config($1,$2,true)',[setting,child.id]);
  const received = (await db.query(`UPDATE assessment.term_test_attempt
    SET listening_answers=$2,listening_result=$3,listening_submitted_at=clock_timestamp(),
      combined_result=$4,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 RETURNING listening_submitted_at`,
  [official.id,JSON.stringify(answers),JSON.stringify(grade),JSON.stringify(combined)])).rows[0].listening_submitted_at;
  const marked = await db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=$3,
    listening_deadline_at=$4,listening_submitted_at=$5,updated_at=clock_timestamp()
    WHERE id=$1 AND generation=$2 AND superseded_at IS NULL`,
  [official.exam_session_id,official.generation,child.listening_started_at,child.listening_deadline_at,received]);
  if(marked.rowCount!==1)throw new Term1ContinuationError('EXAM_SESSION_REQUIRED','Lượt đã thay đổi. Hãy xác nhận lại tên.');
  if(offline)await db.query("SELECT set_config('k67.term_journey',$1,true)",[child.id]);
  await db.query(`UPDATE assessment.term_test_exam_session SET listening_submitted_at=$2,updated_at=clock_timestamp()
    WHERE id=$1`,[child.id,received]);
  return writeReceipt(db,grant,official,operationId,hash,combined,received);
}

function submissionHash(input) {
  return createHash('sha256').update(JSON.stringify({
    answers:Object.entries(input.answers).sort(([a],[b])=>Number(a)-Number(b)),revision:input.draftRevision ?? null,
  })).digest('hex');
}

export async function term1ContinuationGrant(db, sessionId, section) {
  return (await db.query(`SELECT * FROM assessment.term1_section_continuation
    WHERE exam_session_id=$1 AND section=$2 FOR UPDATE`,[sessionId,section])).rows[0];
}

async function lockOfficial(db, grant, definitionVersion, classId, studentId, slug='term-test-1') {
  return (await db.query(`SELECT a.* FROM assessment.term_test_attempt a
    JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id AND s.generation=a.generation AND s.superseded_at IS NULL
    WHERE a.id=$1 AND a.generation=$2 AND a.test_slug=$6 AND a.definition_version=$3
      AND a.erp_course_class_id=$4 AND a.erp_student_contact_id=$5 AND a.superseded_at IS NULL FOR UPDATE OF a,s`,
  [grant.official_attempt_id,grant.official_generation,definitionVersion,classId,studentId,slug])).rows[0];
}

async function writeReceipt(db,grant,official,operationId,hash,result,received) {
  const completed = grant.section==='writing'||official.writing_scope==='lr_only';
  const receipt = {receiptId:randomUUID(),operationId,section:grant.section,nextSection:completed?'result':'writing',
    completed,result,examSessionToken:grant.exam_session_id,receivedAt:new Date(received).toISOString()};
  await db.query(`UPDATE ${continuationTable(official.test_slug)} SET operation_id=$2,payload_hash=$3,receipt=$4
    WHERE exam_session_id=$1`,[grant.exam_session_id,operationId,hash,JSON.stringify(receipt)]);
  return receipt;
}

export async function commitTermReadingContinuation(db,grant,child,input,definition,answers,grade,offlineHash) {
  const hash = offlineHash ?? submissionHash(input);
  const official = await lockOfficial(db,grant,child.definition_version,child.erp_course_class_id,child.erp_student_contact_id,child.test_slug);
  if (!official?.listening_submitted_at || !child.reading_started_at) {
    throw new Term1ContinuationError('EXAM_SESSION_REQUIRED','Lượt đã thay đổi. Hãy xác nhận lại tên để đọc tiến độ.');
  }
  if (grant.receipt && grant.operation_id===input.clientSubmissionId && grant.payload_hash===hash) return {receipt:grant.receipt};
  if (official.reading_submitted_at || grant.receipt) {
    throw new Term1ContinuationError('EXAM_FIRST_SUBMISSION_ACCEPTED','Reading đã có bài được ghi nhận.');
  }
  const combined = buildCombinedResult(definition,official.listening_result,grade);
  if(offlineHash)await db.query("SELECT set_config('k67.term_journey',$1,true)",[official.exam_session_id]);
  const {rows:[written]} = await db.query(`UPDATE assessment.term_test_attempt SET reading_answers=$2,reading_result=$3,
    reading_started_at=$4,reading_deadline_at=$5,reading_submitted_at=clock_timestamp(),
    combined_result=$6,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 RETURNING reading_submitted_at`,
  [official.id,JSON.stringify(answers),JSON.stringify(grade),child.reading_started_at,child.reading_deadline_at,JSON.stringify(combined)]);
  return {receipt:await writeReceipt(db,grant,official,input.clientSubmissionId,hash,combined,written.reading_submitted_at),official};
}

export async function commitTermOfflineContinuation(db,state,body,record,hash,definition,grade) {
  const {continuation,session}=state;
  const input={clientSubmissionId:body.operationId};
  if(body.section==='reading') {
    const {receipt}=await commitTermReadingContinuation(db,continuation,record,input,definition,body.answers,grade,hash);
    return receipt;
  }
  const official=await lockOfficial(db,continuation,session.definition_version,session.erp_course_class_id,session.erp_student_contact_id,session.test_slug);
  if (!official?.reading_submitted_at || official.listening_submitted_at || official.listening_interrupted_at || continuation.receipt) {
    throw new Term1ContinuationError('EXAM_FIRST_SUBMISSION_ACCEPTED','Tiến độ Listening đã thay đổi. Hãy mở lại bài.');
  }
  return writeOfficialListening(db,continuation,official,record,body.operationId,hash,definition,body.answers,grade,true);
}

export async function commitTermOfflineListeningInterruption(db,state,body,hash) {
  const {continuation,session}=state;
  const official=await lockOfficial(db,continuation,session.definition_version,session.erp_course_class_id,session.erp_student_contact_id,session.test_slug);
  if (!official?.reading_submitted_at || !official.reading_result || official.listening_submitted_at
      || official.listening_interrupted_at || continuation.receipt) {
    throw new Term1ContinuationError('EXAM_FIRST_SUBMISSION_ACCEPTED','Tiến độ Listening đã thay đổi. Hãy mở lại bài.');
  }
  const {rows:[definition]}=await db.query(`
    SELECT slug AS test_slug,title AS test_title,version AS definition_version
    FROM assessment.test_definition WHERE slug=$2 AND version=$1`,[official.definition_version,session.test_slug]);
  if(!definition)throw new Term1ContinuationError('OFFLINE_DEFINITION','Chưa tìm thấy đúng phiên bản đề.');
  const combined={...buildCombinedResult(definition,null,official.reading_result),listeningStatus:'interrupted'};
  const interruptedAt=new Date(body.capturedAt);
  await db.query("SELECT set_config('k67.term_journey',$1,true)",[official.exam_session_id]);
  await db.query(`UPDATE assessment.term_test_attempt
    SET listening_interrupted_at=$2,completed_at=clock_timestamp(),combined_result=$3,updated_at=clock_timestamp()
    WHERE id=$1`,[official.id,interruptedAt,JSON.stringify(combined)]);
  const receipt=await writeReceipt(db,continuation,official,body.operationId,hash,undefined,interruptedAt);
  return {...receipt,attemptToken:session.id,startedAt:body.startedAt};
}

export async function commitTermOfflineWriting(db,state,body,deadline,hash) {
  const {continuation,session}=state;
  const official=await lockOfficial(db,continuation,session.definition_version,session.erp_course_class_id,session.erp_student_contact_id,session.test_slug);
  if (!official?.completed_at || (!official.listening_submitted_at&&!official.listening_interrupted_at) || !official.reading_submitted_at
      || official.writing_scope!=='exam' || official.writing_submitted_at || continuation.receipt) {
    throw new Term1ContinuationError('EXAM_FIRST_SUBMISSION_ACCEPTED','Tiến độ Writing đã thay đổi. Hãy mở lại bài.');
  }
  await db.query("SELECT set_config('k67.term_journey',$1,true)",[official.exam_session_id]);
  const {rows:[written]}= await db.query(`UPDATE assessment.term_test_attempt SET writing_task_1=$2,writing_task_2=$3,
    writing_started_at=$4,writing_deadline_at=$5,writing_draft_revision=$6,writing_submitted_at=$7,
    writing_updated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING writing_submitted_at`,
  [official.id,body.answers.task1,body.answers.task2,new Date(body.startedAt).toISOString(),new Date(deadline).toISOString(),
    body.revision,new Date(body.capturedAt).toISOString()]);
  const receipt = await writeReceipt(db,continuation,official,body.operationId,hash,official.combined_result,written.writing_submitted_at);
  return {...receipt,attemptToken:session.id,officialAttemptToken:official.id};
}
