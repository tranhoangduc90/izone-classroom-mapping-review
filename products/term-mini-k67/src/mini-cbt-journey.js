import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audioTransaction } from './audio-incidents.js';
import { readMiniSectionDefinition, sealMiniCbtSection } from './mini-cbt-offline.js';
import { buildCombinedResult } from './term-tests.js';
import { miniR2Audio, term1JourneyR2Audio, term2JourneyR2Audio, pretestJourneyR2Audio, R2_POLICY } from './mini-r2-audio.js';
import { publicAudioCatalog } from './public-audio-catalog.js';

const mini = {slug:'mini-test-lesson-5',version:'mini-k67-cbt-journey-v1',mode:'miniCbtJourneyMode',
  table:'assessment.mini_k67_cbt_journey',guard:'k67.mini_journey'};
const term1 = {slug:'term-test-1',version:'term1-k67-cbt-journey-v1',mode:'term1CbtJourneyMode',
  table:'assessment.term_k67_cbt_journey',guard:'k67.term_journey',writing:true,writingHold:'term1'};
const term1Paper = {...term1,version:'term1-k67-paper-journey-v1',mode:'term1PaperJourneyMode',writing:false,paper:true};
const term2 = {slug:'term-test-2',version:'term2-k67-cbt-journey-v1',mode:'term2CbtJourneyMode',
  table:'assessment.term_k67_cbt_journey',guard:'k67.term_journey',writing:true,twoTasks:true,writingHold:'term2'};
const term2Paper = {...term2,version:'term2-k67-paper-journey-v1',mode:'term2PaperJourneyMode',writing:false,paper:true};
const pretest = {slug:'pretest-lesson-16',version:'pretest-lesson-16-k67-cbt-v1',mode:'pretestCbtJourneyMode',
  table:term2.table,guard:term2.guard,receiptStatus:true,lrOnly:true,privateAudio:true};
const pretestPaper = {...pretest,version:'pretest-lesson-16-k67-paper-v1',mode:'pretestPaperJourneyMode',
  privateAudio:false,paper:true};
const recovery = 72 * 60 * 60 * 1_000;
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = z.object({ examSessionToken: z.uuid(), generation: z.number().int().nonnegative(),
  deviceProof: z.string().regex(/^[a-f0-9]{64}$/) });
const open = scope.extend({ classCode: z.string().regex(/^[A-Z0-9._-]{2,32}$/), studentRef: z.uuid() });
const openPaper = open.omit({examSessionToken:true,generation:true}).extend({
  examMode:z.enum(['lis_first','read_first']),identityConfirmed:z.literal(true)
});
const attemptSection = scope.extend({ operationId: z.uuid(), section: z.enum(['listening','reading']), previousOperationId: z.uuid().nullable(),
  startedAt: ts, capturedAt: ts, revision: ts, automatic: z.boolean(), eofAt: ts.nullable(),
  heardSeconds: z.number().min(0).max(7200), answers: z.record(z.string().regex(/^\d{1,2}$/), z.string().max(120)) });
const termSection = z.discriminatedUnion('section', [attemptSection.extend({section:z.literal('listening')}),
  attemptSection.extend({section:z.literal('reading')}),attemptSection.extend({section:z.literal('writing'),
    eofAt:z.null(),heardSeconds:z.literal(0),answers:z.object({task1:z.string().max(12_000),task2:z.string().max(12_000)}).strict()})]);
const interruptedListening = attemptSection.extend({
  section: z.literal('listening'), automatic: z.literal(false), eofAt: z.null(), heardSeconds: z.literal(0),
  answers: z.strictObject({})
});
const termStatus=scope.extend({section:z.enum(['listening','reading','writing']),operationId:z.uuid()});
const problem = (code, message, status = 409, reasonCode = code) => Object.assign(new Error(message), { code, status, reasonCode });
const clock = value => new Date(value).getTime();
const sha = value => createHash('sha256').update(value).digest('hex');
const writingHoldTable = 'assessment.term_k67_writing_submission_hold';
const lrHoldTable = 'assessment.term_k67_lr_submission_hold';

export async function pruneExpiredWritingHolds(pool) {
  return pruneExpiredHolds(pool,writingHoldTable);
}

export async function pruneExpiredLrHolds(pool) {
  return pruneExpiredHolds(pool,lrHoldTable);
}

async function pruneExpiredHolds(pool,table) {
  // Xóa nội dung hết hạn trước. Giữ mã và dấu vân tay qua cửa sổ retry của permit.
  const key=table===lrHoldTable?'session_id,generation,section,operation_id':'session_id,generation,operation_id';
  const matches=key.split(',').map(column=>`held.${column}=expired.${column}`).join(' AND ');
  const cleared=await pool.query(`WITH expired AS (
    SELECT ${key} FROM ${table}
    WHERE payload IS NOT NULL AND expires_at<=statement_timestamp()
    ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
  ) UPDATE ${table} AS held SET payload=NULL FROM expired WHERE ${matches}`);
  const removed=await pool.query(`WITH expired AS (
    SELECT ${key} FROM ${table}
    WHERE payload IS NULL AND expires_at<=statement_timestamp()-interval '72 hours'
    ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
  ) DELETE FROM ${table} AS held USING expired WHERE ${matches}`);
  return {cleared:cleared.rowCount,removed:removed.rowCount};
}
const initial = session => session.exam_mode === 'read_first' ? 'reading' : 'listening';
const peer = section => section === 'reading' ? 'listening' : 'reading';

function timingForAudio(assets, slug, audioHash, pinnedManifest) {
  const timing = assets.getTiming(slug);
  const audio = pinnedManifest || publicAudioCatalog[slug];
  if (audio?.sha256 !== audioHash || !Number.isFinite(audio?.durationSeconds)) return timing;
  return { ...timing, listeningDurationSeconds: audio.durationSeconds,
    listeningTotalSeconds: audio.durationSeconds + timing.listeningReviewSeconds };
}

async function lock(db, body, {slug,table,paper}) {
  const owner = (await db.query(`SELECT erp_course_class_id,erp_student_contact_id FROM assessment.term_test_exam_session
    WHERE id=$1 AND test_slug=$2`, [body.examSessionToken, slug])).rows[0];
  if (!owner) throw problem('OFFLINE_SCOPE', 'Không tìm thấy đúng lượt thi.', 403);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${slug}:${owner.erp_course_class_id}:${owner.erp_student_contact_id}`]);
  const session = (await db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE', [body.examSessionToken])).rows[0];
  if (!session || session.test_slug !== slug || session.superseded_at || Number(session.generation) !== body.generation
      || !['legacy','cbt'].includes(session.attempt_mode)) {
    throw problem('OFFLINE_SCOPE', 'Lượt thi đã thay đổi.', 403);
  }
  const attempt = session.attempt_id ? (await db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1 FOR UPDATE', [session.attempt_id])).rows[0] : null;
  if ((session.attempt_id && !attempt) || (attempt && (attempt.test_slug !== slug || attempt.superseded_at || attempt.exam_session_id !== session.id
      || Number(attempt.generation) !== body.generation || attempt.attempt_mode==='answer_sheet'))) {
    throw problem('OFFLINE_SCOPE', 'Không khớp bài thi đang lưu.', 403);
  }
  const journey = (await db.query(`SELECT * FROM ${table} WHERE session_id=$1 FOR UPDATE`, [session.id])).rows[0];
  if ((journey?.audio_hash==='paper')!==Boolean(paper)) {
    throw problem('OFFLINE_SCOPE','Không khớp cách làm bài đã chọn.',403);
  }
  const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  return { session, attempt, journey, now };
}

function signature(secret, row, version) {
  return createHmac('sha256', secret).update([version, row.session_id, row.generation, row.student_ref, row.device_hash, row.audio_hash].join(':')).digest('hex');
}

function authorize(body, state, supplied, secret, version) {
  const row = state.journey;
  if (!row || Number(row.generation) !== body.generation || row.device_hash !== sha(body.deviceProof)
      || !/^[a-f0-9]{64}$/.test(supplied || '') || !timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(signature(secret,row,version),'hex'))) {
    throw problem('OFFLINE_SCOPE', 'Quyền không khớp thiết bị và lượt thi.', 403);
  }
  if (row.activated_at && clock(state.now) > clock(row.activated_at) + recovery) {
    throw problem('OFFLINE_REVIEW_REQUIRED', 'Đã quá thời gian gửi lại. Giữ bản trên thiết bị để đối soát.');
  }
}

function checkReceipt(receipt, operationId, digest, message = 'Mã nộp không khớp bản đã nhận.') {
  if (receipt && (receipt.operationId !== operationId || (digest && receipt.payloadHash !== digest))) {
    throw problem('OFFLINE_CONFLICT', message);
  }
  return receipt;
}

function submissionHoldKey(body) {
  const lr=body.section!=='writing';
  return {table:lr?lrHoldTable:writingHoldTable,lr,
    args:[body.examSessionToken,body.generation,body.operationId,...lr?[body.section]:[]],
    where:`session_id=$1 AND generation=$2 AND operation_id=$3${lr?' AND section=$4':''}`};
}

async function readSubmissionHold(db, key) {
  return (await db.query(`SELECT payload_hash,held_at,expires_at,payload IS NOT NULL AS has_payload${key.lr?',review_only':''} FROM ${key.table}
    WHERE ${key.where}`,key.args)).rows[0];
}

function heldMetadata(row, now) {
  if (!row?.has_payload || clock(row.expires_at) <= clock(now)) return undefined;
  return {payloadHash:row.payload_hash,heldAt:clock(row.held_at),expiresAt:clock(row.expires_at)};
}

async function retainSubmission(db, state, body, input, digest, key, {hours,limit}, reviewOnly=false) {
  const receipt=state.journey.sections[body.section];
  if ((!key.lr||receipt?.operationId===body.operationId)&&checkReceipt(receipt,body.operationId,digest)) return undefined;
  const delivery=state.journey.audio_hash==='paper'?'paper':'cbt';
  return retainUncommittedSubmission(db,state,body,input,digest,key,{hours,limit},delivery,reviewOnly);
}

export function readMiniPaperSubmissionHold(db, body, now) {
  return readSubmissionHold(db,submissionHoldKey(body)).then(row=>heldMetadata(row,now));
}

export function retainMiniPaperSubmission(db, state, body, input, digest, options) {
  return retainUncommittedSubmission(db,state,body,input,digest,submissionHoldKey(body),options,'paper',false);
}

export function removeMiniPaperSubmissionHold(db, body) {
  return removeSubmissionHold(db,submissionHoldKey(body));
}

function removeSubmissionHold(db, key) {
  return db.query(`DELETE FROM ${key.table} WHERE ${key.where}`,key.args);
}

async function retainUncommittedSubmission(db, state, body, input, digest, key, {hours,limit}, delivery, reviewOnly) {
  const existing = await readSubmissionHold(db,key);
  if (existing) {
    if (existing.payload_hash !== digest) throw problem('OFFLINE_CONFLICT', 'Mã nộp đã có bản khác để đối soát.');
    if(reviewOnly&&!existing.review_only)throw problem('OFFLINE_CONFLICT','Mã này đã được dùng để gửi bản khác.');
    const held = heldMetadata(existing,state.now);
    if (!held) throw problem('OFFLINE_HOLD_EXPIRED', 'Bản trên máy chủ đã hết hạn lưu. Hãy giữ bản trên thiết bị.');
    return held;
  }
  // A short separate transaction serializes quota allocation. It ends before business validation.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`k67.${state.session.test_slug}.${key.lr?delivery:'writing'}.hold-quota`]);
  const count = (await db.query(`SELECT count(*)::int AS n FROM ${key.table} held
    JOIN assessment.term_test_exam_session owner ON owner.id=held.session_id
    WHERE held.payload IS NOT NULL AND held.expires_at>$1 AND owner.test_slug=$2${key.lr?' AND held.delivery=$3':''}`,
    [state.now,state.session.test_slug,...key.lr?[delivery]:[]])).rows[0].n;
  if (count >= limit) throw problem('OFFLINE_HOLD_FULL', 'Kho đối soát đang đầy. Hãy giữ bản trên thiết bị.',503);
  const expiresAt = new Date(clock(state.now) + hours * 3_600_000);
  const row = (await db.query(`INSERT INTO ${key.table}
    (session_id,generation,operation_id,payload_hash,payload,held_at,expires_at${key.lr?',section,review_only,delivery':''})
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7${key.lr?',$8,$9,$10':''})
    RETURNING payload_hash,held_at,expires_at,true AS has_payload`,
  [state.session.id,body.generation,body.operationId,digest,JSON.stringify(input),state.now,expiresAt,...key.lr?[body.section,reviewOnly,delivery]:[]])).rows[0];
  return heldMetadata(row,state.now);
}

function timeline(body, state, timing, paper) {
  const { session, journey, now } = state;
  if (!journey.activated_at) throw problem('OFFLINE_NOT_STARTED', 'Chưa bắt đầu bài trên máy chủ.');
  const first = initial(session);
  const previous = journey.sections[body.section==='writing'?peer(first):first];
  const activation = clock(journey.activated_at);
  const timelineMessage = 'Thứ tự hoặc mốc làm bài không khớp. Bản trên máy vẫn được giữ.';
  if (body.previousOperationId !== (body.section === first ? null : previous?.operationId)) {
    throw problem('OFFLINE_TIMELINE', timelineMessage, 409, 'PREVIOUS_OPERATION_MISMATCH');
  }
  if ((body.section === first && (paper?body.startedAt<activation:body.startedAt!==activation))
      || (body.section !== first && body.startedAt < previous.capturedAt) || body.capturedAt < body.startedAt
      || body.capturedAt > Math.min(clock(now) + 3_000, activation + recovery)) {
    throw problem('OFFLINE_TIMELINE', timelineMessage, 409, 'CAPTURE_TIMELINE_MISMATCH');
  }
  if (body.section === 'reading') {
    if (body.eofAt !== null || body.heardSeconds !== 0) throw problem('OFFLINE_TIMELINE', 'Mốc Reading không hợp lệ.');
    return body.startedAt + timing.readingDurationMinutes * 60_000;
  }
  if (body.section==='writing') return body.startedAt+timing.writingDurationMinutes*60_000;
  if (paper) {
    if (body.automatic || body.eofAt!==null || body.heardSeconds!==0) {
      throw problem('PAPER_MANUAL_ONLY', 'Phiếu Listening chỉ nộp khi học viên xác nhận.');
    }
    return body.capturedAt;
  }
  const duration = timing.listeningDurationSeconds;
  if (body.heardSeconds > duration + 1 || (body.eofAt !== null && (body.heardSeconds < duration - 0.25
      || body.eofAt < body.startedAt + duration * 1000 - 500 || body.eofAt > body.capturedAt))) {
    throw problem('AUDIO_END_NOT_CONFIRMED', 'Chưa khớp mốc kết thúc file nghe.');
  }
  if (body.automatic && body.eofAt === null) throw problem('AUDIO_END_NOT_CONFIRMED', 'Chưa phát hết audio.');
  return body.eofAt === null ? Math.max(body.capturedAt, body.startedAt + timing.listeningTotalSeconds * 1_000)
    : body.eofAt + timing.listeningReviewSeconds * 1_000;
}

async function commitInterruption(db, state, body, timing, profile) {
  timeline(body, state, timing, false);
  const { session, attempt } = state;
  if (session.listening_submitted_at || session.listening_eof_at || session.listening_audio_incident_id
      || attempt?.listening_interrupted_at) {
    throw problem('OFFLINE_CONFLICT', 'Listening đã có kết quả hoặc lượt đang được xử lý.');
  }
  await db.query('SELECT set_config($1,$2,true)', [profile.guard, session.id]);
  const at = new Date(body.capturedAt).toISOString();
  if (attempt) {
    if (!attempt.reading_submitted_at || !attempt.reading_result) {
      throw problem('OFFLINE_CONFLICT', 'Chưa nhận phần Reading của lượt.');
    }
    const definition = (await db.query(`
      SELECT slug AS test_slug,title AS test_title,version AS definition_version
      FROM assessment.test_definition WHERE slug=$1 AND version=$2`, [profile.slug,session.definition_version])).rows[0];
    if (!definition) throw problem('OFFLINE_DEFINITION', 'Chưa tìm thấy đúng phiên bản đề.');
    const combined = { ...buildCombinedResult(definition, null, attempt.reading_result), listeningStatus:'interrupted' };
    await db.query(`UPDATE assessment.term_test_attempt
      SET listening_interrupted_at=$2,completed_at=now(),combined_result=$3::jsonb,updated_at=now()
      WHERE id=$1`, [attempt.id,at,JSON.stringify(combined)]);
    return {attemptToken:attempt.id,completed:!profile.writing,nextSection:profile.writing?'writing':'result'};
  }
  const inserted = (await db.query(`INSERT INTO assessment.term_test_attempt
    (client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,
      student_name_snapshot,exam_session_id,attempt_mode,exam_mode,exam_delivery,generation,listening_interrupted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'lis_first','cbt',$10,$11) RETURNING id`,
    [body.operationId,session.test_slug,session.definition_version,session.erp_course_class_id,session.class_name_snapshot,
      session.erp_student_contact_id,session.student_name_snapshot,session.id,session.attempt_mode,session.generation,at])).rows[0];
  if (profile.lrOnly) await db.query(`UPDATE assessment.term_test_attempt SET writing_scope='lr_only' WHERE id=$1`, [inserted.id]);
  await db.query('UPDATE assessment.term_test_exam_session SET attempt_id=$2,updated_at=now() WHERE id=$1', [session.id,inserted.id]);
  return {attemptToken:inserted.id,completed:false,nextSection:'reading'};
}

async function commit(db, state, body, timing, profile, observation) {
  const deadline = timeline(body, state, timing, profile.paper);
  observation.deadlineAtMs = deadline;
  const listening = body.section === 'listening';
  const { session, attempt } = state;
  if(body.section==='writing'){
    if(!profile.twoTasks&&body.answers.task1!=='')throw problem('OFFLINE_INVALID','Term 1 chỉ nhận Task 2.',400);
    if(!attempt?.completed_at||attempt.writing_scope!=='exam'||attempt.writing_started_at||attempt.writing_submitted_at
        || Number(attempt.writing_draft_revision)>0)throw problem('OFFLINE_CONFLICT','Phiên Writing đã thay đổi. Giữ bài để đối soát.');
    const reviewMessage = 'Mốc chốt Writing chưa khớp giờ thi. Hãy giữ bài trên thiết bị để đối soát.';
    if (!Number.isSafeInteger(deadline) || body.capturedAt > deadline) {
      throw problem('OFFLINE_REVIEW_REQUIRED', reviewMessage, 409, 'CAPTURE_AFTER_DEADLINE');
    }
    if (body.automatic && body.capturedAt !== deadline) {
      throw problem('OFFLINE_REVIEW_REQUIRED', reviewMessage, 409, 'AUTO_CAPTURE_NOT_AT_DEADLINE');
    }
    if (body.automatic && clock(state.now) < deadline) {
      throw Object.assign(problem('OFFLINE_REVIEW_REQUIRED', reviewMessage, 409, 'SERVER_BEFORE_DEADLINE'),
        {retryAfterMs:deadline-clock(state.now)});
    }
    await db.query('SELECT set_config($1,$2,true)',[profile.guard,session.id]);
    await db.query(`UPDATE assessment.term_test_attempt SET writing_task_1=$2,writing_task_2=$3,writing_started_at=$4,
      writing_deadline_at=$5,writing_draft_revision=$6,writing_submitted_at=$7,writing_updated_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1`,[attempt.id,body.answers.task1,body.answers.task2,new Date(body.startedAt).toISOString(),new Date(deadline).toISOString(),
      body.revision,new Date(body.capturedAt).toISOString()]);
    return {attemptToken:attempt.id,completed:true,nextSection:'result'};
  }
  if (session.listening_audio_incident_id || (listening ? session.listening_submitted_at : attempt?.reading_submitted_at)) {
    throw problem('OFFLINE_CONFLICT', 'Phiên trên máy chủ đã thay đổi. Giữ bài để đối soát.');
  }
  await db.query('SELECT set_config($1,$2,true)',[profile.guard,session.id]);
  const dates = [new Date(body.startedAt).toISOString(),new Date(deadline).toISOString()];
  let row;
  if (listening) {
    row = (await db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=$2,listening_deadline_at=$3,
      listening_eof_at=$4 WHERE id=$1 RETURNING *`, [session.id,dates[0],profile.paper?null:dates[1],body.eofAt === null ? null : new Date(body.eofAt).toISOString()])).rows[0];
    row.server_now = state.now;
  } else {
    if (!attempt) throw problem('OFFLINE_CONFLICT', 'Chưa gắn được phần Reading vào lượt.');
    row = (await db.query(`UPDATE assessment.term_test_attempt SET reading_started_at=$2,reading_deadline_at=$3
      WHERE id=$1 RETURNING *`,[attempt.id,...dates])).rows[0];
    session.server_now = state.now;
  }
  const result=await sealMiniCbtSection(db, { session: listening ? row : session, attempt: listening ? attempt : row,
    record: row, start: body.startedAt, deadline, listening }, { ...body, capturedAt: new Date(body.capturedAt).toISOString() },profile.slug);
  if(profile.paper&&!attempt)await db.query(`UPDATE assessment.term_test_attempt
    SET exam_delivery='answer_sheet',writing_scope='lr_only' WHERE id=$1`,[result.attemptToken]);
  if(profile.lrOnly&&!profile.paper&&!attempt)await db.query(`UPDATE assessment.term_test_attempt
    SET writing_scope='lr_only' WHERE id=$1`,[result.attemptToken]);
  return profile.writing&&result.completed?{...result,completed:false,nextSection:'writing'}:result;
}

export function mountMiniCbtJourney(app, services) {mountCbtJourney(app,services,mini);}
export function mountPretestCbtJourney(app, services) {mountCbtJourney(app,services,pretest);}
export function mountPretestPaperJourney(app, services) {mountCbtJourney(app,services,pretestPaper);}
export function mountTerm1CbtJourney(app, services) {mountCbtJourney(app,services,term1);}
export function mountTerm1PaperJourney(app, services) {mountCbtJourney(app,services,term1Paper);}
export function mountTerm2CbtJourney(app, services) {mountCbtJourney(app,services,term2);}
export function mountTerm2PaperJourney(app, services) {mountCbtJourney(app,services,term2Paper);}

async function preparePaper(db, profile, student, body, secret, timing, {allowNew,enroll,holdEnabled}) {
  const {slug,table,version}=profile;
  const {class_id:classId,student_id:studentId,definition_version:definition}=student;
  const owner=[slug,classId,studentId,definition];
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${slug}:${classId}:${studentId}`]);
  const session=(await db.query(`SELECT * FROM assessment.term_test_exam_session
    WHERE test_slug=$1 AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND definition_version=$4
    AND superseded_at IS NULL ORDER BY prepared_at DESC LIMIT 1 FOR UPDATE`,owner)).rows[0];
  let row;
  if(session?.attempt_mode==='legacy') {
    row=(await db.query(`SELECT * FROM ${table} WHERE session_id=$1 FOR UPDATE`,[session.id])).rows[0];
  }
  const deviceHash=sha(body.deviceProof);
  let current=session;
  if(row) {
    if(row.audio_hash!=='paper'||row.student_ref!==body.studentRef||row.device_hash!==deviceHash
        || Number(row.generation)!==Number(session.generation)) {
      throw problem('OFFLINE_SCOPE','Lượt phiếu đã gắn với thiết bị hoặc thế hệ khác.',403);
    }
  } else {
    const oldAttempt=(await db.query(`SELECT 1 FROM assessment.term_test_attempt
      WHERE test_slug=$1 AND erp_course_class_id=$2 AND erp_student_contact_id=$3 AND definition_version=$4
      AND superseded_at IS NULL LIMIT 1`,owner)).rowCount;
    if (session || oldAttempt || !allowNew) throw problem('OFFLINE_NEW_DISABLED','Lượt này tiếp tục bằng cách đã mở.');
    current=(await db.query(`INSERT INTO assessment.term_test_exam_session
      (test_slug,erp_course_class_id,erp_student_contact_id,definition_version,class_name_snapshot,student_name_snapshot,attempt_mode,exam_mode)
      VALUES($1,$2,$3,$4,$5,$6,'legacy',$7) RETURNING *`,[...owner,student.class_name,student.student_name,body.examMode])).rows[0];
    if(body.examMode==='read_first') {
      const attempt=(await db.query(`INSERT INTO assessment.term_test_attempt
        (test_slug,erp_course_class_id,erp_student_contact_id,definition_version,class_name_snapshot,student_name_snapshot,
         exam_session_id,client_submission_id,attempt_mode,exam_mode,exam_delivery,writing_scope)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'legacy','read_first','answer_sheet','lr_only') RETURNING id`,
        [...owner,student.class_name,student.student_name,current.id,randomUUID()])).rows[0];
      await db.query('UPDATE assessment.term_test_exam_session SET attempt_id=$2 WHERE id=$1',[current.id,attempt.id]);
      current.attempt_id=attempt.id;
    }
    // Reserve native writes as soon as the permit is issued. The Reading clock starts separately.
    row=(await db.query(`INSERT INTO ${table}
      (session_id,generation,student_ref,device_hash,audio_hash,activated_at${enroll?',lr_hold_cohort':''})
      VALUES($1,$2,$3,$4,'paper',clock_timestamp()${enroll?',true':''}) RETURNING *`,[current.id,current.generation,body.studentRef,deviceHash])).rows[0];
  }
  const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  return {ok:true,version,examSessionToken:current.id,generation:Number(row.generation),attemptToken:current.attempt_id||current.id,
    studentRef:body.studentRef,studentName:current.student_name_snapshot,className:current.class_name_snapshot,
    examMode:current.exam_mode,activatedAt:clock(row.activated_at),serverNow:clock(now),permit:signature(secret,row,version),
    ...(holdEnabled&&row.lr_hold_cohort===true?{submissionRecoveryVersion:1}:{}),
    timing:{readingDurationMinutes:timing.readingDurationMinutes}};
}

function mountCbtJourney(app, { pool, config, assets, requireContext, readStudent, readLimiter, writeLimiter, writingAccepted, writingCommitted, paperAccepted, observeSubmission, queueWriting, logEvent = () => {} }, profile) {
  const {slug,table,version}=profile;
  const prefix=`/api/term-tests/${slug}/${profile.paper?'paper':'cbt'}-journey`;
  const mode=config[profile.mode];
  if (!['on','drain'].includes(mode)) return;
  const secret = config.termTestSessionSecret;
  const hours=config[`${profile.writingHold}WritingHoldHours`],limit=config[`${profile.writingHold}WritingHoldLimit`];
  const holdOptions=profile.writing && hours>0 && limit>0 ? {hours,limit} : null;
  const holdClasses=config[`${profile.writingHold}WritingHoldClasses`];
  const writingHoldAllowed = journey => holdOptions && journey.writing_hold_cohort===true;
  const lrHoldProfile=profile===mini?'miniCbt':profile.paper?'termPaper':'termCbt';
  const lrHours=config[`${lrHoldProfile}LrHoldHours`],lrLimit=config[`${lrHoldProfile}LrHoldLimit`];
  const lrHoldOptions=!profile.lrOnly&&lrHours>0&&lrLimit>0?{hours:lrHours,limit:lrLimit}:null;
  const lrHoldClasses=config[`${profile===mini?'mini':profile.writingHold}${profile.paper?'Paper':'Cbt'}LrHoldClasses`];
  const enrollLr=classCode=>Boolean(lrHoldOptions&&(lrHoldClasses?.has('*')||lrHoldClasses?.has(classCode)));
  const lrHoldAllowed=journey=>lrHoldOptions&&journey.lr_hold_cohort===true;
  const readingReviewRequired=()=>problem('OFFLINE_REVIEW_REQUIRED',
    'Chưa xác nhận được nháp Reading đã lưu trước hạn. Bài được giữ để đối soát.',409,'READING_DRAFT_NOT_VERIFIED');
  const route = (schema, action) => async (req,res,next) => {
    res.set('Cache-Control','no-store');
    try {
      if (!secret || secret.length < 32 || !assets) throw problem('OFFLINE_UNAVAILABLE', 'Chưa sẵn sàng cấp bài.',503);
      const body = schema.safeParse(req.body);
      if (!body.success) throw problem('OFFLINE_INVALID', 'Yêu cầu chưa hợp lệ.',400);
      res.json(await action(body.data,req));
    } catch (error) {
      if (!error.status) return next(error);
      res.status(error.status).json({ok:false,error:error.code,message:error.message,...error.held&&{
        held:error.held,reasonCode:error.reasonCode,...error.retryAfterMs&&{retryAfterMs:error.retryAfterMs}
      }});
    }
  };
  if(profile.paper)app.get(prefix+'/availability',readLimiter,(_req,res)=>{
    res.set('Cache-Control','no-store').json({ok:true,enabled:mode==='on'});
  });
  if(profile.paper)app.post(prefix+'/prepare',writeLimiter,requireContext,route(openPaper,async (body,req)=>{
    const selected=(await readStudent(req,body.classCode,slug,body.studentRef)).rows[0];
    if(!selected)throw problem('OFFLINE_SCOPE','Không đúng lớp hoặc học viên.',403);
    const allowNew=mode==='on'&&(body.examMode!=='read_first'||config.readFirstNewEnabled);
    return audioTransaction(pool,db=>preparePaper(db,profile,selected,body,secret,assets.getTiming(slug),
      {allowNew,enroll:enrollLr(selected.class_name),holdEnabled:Boolean(lrHoldOptions)}));
  }));
  else app.post(prefix+'/prepare',writeLimiter,requireContext,route(open,async (body,req) => {
    const selected = (await readStudent(req,body.classCode,slug,body.studentRef)).rows[0];
    // Read protected asset metadata after identifying a permitted roster member and outside the DB transaction.
    if (!selected) throw problem('OFFLINE_SCOPE','Không đúng lớp hoặc học viên.',403);
    const manifest = await assets.getJourneyManifest?.(slug)
      || (profile===mini&&assets.getMiniJourneyManifest?.()) || publicAudioCatalog[slug];
    if (!manifest) throw problem('OFFLINE_UNAVAILABLE', 'Chưa chuẩn bị được audio đúng bài.',503);
    return audioTransaction(pool,async db => {
      const {session,attempt,journey,now} = await lock(db,body,profile);
      if (!selected || String(selected.class_id) !== String(session.erp_course_class_id)
          || String(selected.student_id) !== String(session.erp_student_contact_id) || Number(selected.definition_version) !== Number(session.definition_version)) {
        throw problem('OFFLINE_SCOPE','Không đúng lớp hoặc học viên.',403);
      }
      if (journey?.device_hash !== undefined && (journey.device_hash !== sha(body.deviceProof) || journey.student_ref !== body.studentRef)) {
        throw problem('OFFLINE_SCOPE','Lượt đã được giữ ở thiết bị khác.',403);
      }
      if (!journey && (session.listening_started_at || session.listening_submitted_at || attempt?.reading_started_at || attempt?.reading_submitted_at
          || session.audio_owner_id || mode !== 'on')) throw problem('OFFLINE_NEW_DISABLED','Lượt này tiếp tục bằng cách đã mở.');
      const enroll=holdOptions && (holdClasses?.has('*') || holdClasses?.has(session.class_name_snapshot));
      const enrollListeningReading=enrollLr(session.class_name_snapshot);
      const row = journey || (await db.query(`INSERT INTO ${table}
        (session_id,generation,student_ref,device_hash,audio_hash${enroll?',writing_hold_cohort':''}${enrollListeningReading?',lr_hold_cohort':''})
        VALUES($1,$2,$3,$4,$5${enroll?',true':''}${enrollListeningReading?',true':''}) RETURNING *`,
        [session.id,body.generation,body.studentRef,sha(body.deviceProof),manifest.sha256])).rows[0];
      if (row.audio_hash !== manifest.sha256 || Number(row.generation) !== body.generation) throw problem('OFFLINE_SCOPE','Bản đề đã thay đổi.',403);
      const audio=profile===mini?miniR2Audio({config,slug,row:{...session,attempt_mode:'cbt'},manifest,requested:R2_POLICY}):
        profile===term1?term1JourneyR2Audio({config,row:session,manifest}):
        profile===term2?term2JourneyR2Audio({config,row:session,manifest}):
        profile===pretest?pretestJourneyR2Audio({config,row:session,manifest}):{};
      return {ok:true,version,examSessionToken:session.id,generation:body.generation,attemptToken:attempt?.id||session.id,
        studentRef:body.studentRef,studentName:session.student_name_snapshot,examMode:session.exam_mode||'lis_first',
        activatedAt:row.activated_at?clock(row.activated_at):null,serverNow:clock(now),permit:signature(secret,row,version),
        ...(config.listeningContinuityEnabled?{listeningContinuityVersion:1}:{}),
        ...(lrHoldAllowed(row)?{readingDeadlineReviewVersion:1}:{}),
        content:await assets.getContent(slug),timing:timingForAudio(assets,slug,row.audio_hash,manifest),audioManifest:manifest,...audio};
    });
  }));
  if (profile.privateAudio) {
    app.post(prefix + '/audio', readLimiter, async (req, res, next) => {
      res.set('Cache-Control', 'no-store, private');
      try {
        const parsed = scope.safeParse(req.body);
        if (!secret || !assets || !parsed.success) throw problem('OFFLINE_INVALID', 'Yêu cầu tải audio chưa hợp lệ.', 400);
        const pin = await audioTransaction(pool, async db => {
          const state = await lock(db, parsed.data, profile);
          authorize(parsed.data, state, req.get('x-term2-permit'), secret, version);
          return state.journey.audio_hash;
        });
        const manifest = await assets.getJourneyManifest(slug);
        if (!manifest?.private || manifest.sha256 !== pin) {
          throw problem('OFFLINE_SCOPE', 'Tệp nghe không khớp bản đã cấp.', 403);
        }
        const log = event => {
          try {
            logEvent(event, slug, parsed.data.examSessionToken, {
              source: 'private-api', byteLength: Number(res.getHeader('content-length')) || 0, status: res.statusCode
            });
          } catch {}
        };
        res.once('finish', () => log('private_audio_response_finished'));
        res.once('close', () => { if (!res.writableFinished) log('private_audio_response_interrupted'); });
        await assets.streamDemoAudio(slug, req, res);
      } catch (error) {
        if (!error.status || res.headersSent) return next(error);
        res.status(error.status).json({ ok: false, error: error.code, message: error.message });
      }
    });
  }
  if(!profile.paper)app.post(prefix+'/begin',writeLimiter,route(scope,(body,req)=>audioTransaction(pool,async db => {
    const state=await lock(db,body,profile);
    authorize(body,state,req.get('x-term2-permit'),secret,version);
    if (!state.journey.activated_at && (state.session.listening_started_at || state.attempt?.reading_started_at || state.session.audio_owner_id)) {
      throw problem('OFFLINE_CONFLICT','Lượt đã bắt đầu trên máy chủ.');
    }
    const activated = state.journey.activated_at || (await db.query(`UPDATE ${table}
      SET activated_at=clock_timestamp() WHERE session_id=$1 RETURNING activated_at`,[state.session.id])).rows[0].activated_at;
    return {ok:true,version,examSessionToken:state.session.id,generation:body.generation,activatedAt:clock(activated),serverNow:clock(state.now)};
  })));
  if(profile.writing||profile.paper||profile.receiptStatus||lrHoldOptions)app.post(prefix+'/status',readLimiter,
    route(profile===mini?termStatus.extend({section:z.enum(['listening','reading'])}):termStatus,async(body,req)=>{
    const {receipt,held,conflict}=await audioTransaction(pool,async db=>{
      const state=await lock(db,body,profile);
      authorize(body,state,req.get('x-term2-permit'),secret,version);
      const holdAllowed=body.section==='writing'?writingHoldAllowed:lrHoldAllowed;
      const canHold=holdAllowed(state.journey);
      const existing=state.journey.sections[body.section];
      const conflict=canHold&&body.section!=='writing'&&Boolean(existing)&&existing.operationId!==body.operationId;
      const receipt=conflict?null:checkReceipt(existing,body.operationId,null,'Phần này đã nhận mã nộp khác.')||null;
      const held=!receipt&&canHold
        ? heldMetadata(await readSubmissionHold(db,submissionHoldKey(body)),state.now) : undefined;
      return {receipt,held,conflict};
    });
    if(profile.writing&&body.section==='writing'&&receipt)writingAccepted?.(receipt.attemptToken);
    return {ok:true,persisted:Boolean(receipt),receipt,...held&&{held},...conflict&&{conflict:true}};
  }));
  const receive = (interruption,reviewOnly=false) => async (body,req) => {
    const {deviceProof,...fields}=body;
    const answerEntries=Object.entries(fields.answers).sort(([left],[right])=>left.localeCompare(right));
    const outcome=interruption?{outcome:'interrupted'}:{};
    const input={...fields,answers:Object.fromEntries(answerEntries),...outcome};
    const digest=sha(JSON.stringify(input));
    const writing=body.section==='writing';
    const candidateOptions=writing?holdOptions:lrHoldOptions;
    const holdKey=candidateOptions&&!interruption?submissionHoldKey(body):null;
    let shouldHold=false;
    let observation;
    let held;
    const report = (event, accepted, reason) => {
      if (!observation) return;
      try {
        observeSubmission?.(event, slug, body.examSessionToken, {
          section:body.section, revision:body.revision, accepted, reason, submission:observation
        });
      } catch {}
    };
    const authorizedState = async db => {
      const state=await lock(db,body,profile);
      authorize(body,state,req.get('x-term2-permit'),secret,version);
      observation = {
        operationId:body.operationId, previousOperationId:body.previousOperationId, generation:body.generation,
        startedAtMs:body.startedAt, capturedAtMs:body.capturedAt, serverAtMs:clock(state.now),
        automatic:body.automatic, delivery:profile.paper?'paper':'cbt',
        definitionVersion:Number(state.session.definition_version), policyVersion:version
      };
      if (body.section === 'writing') {
        observation.task1Length = body.answers.task1.length;
        observation.task2Length = body.answers.task2.length;
      } else {
        observation.answeredCount = Object.values(body.answers).filter(Boolean).length;
      }
      if(body.section==='listening'&&!profile.paper){
        observation.audioAssetHash=state.journey.audio_hash;
        if(body.eofAt!==null)observation.audioEofAtMs=body.eofAt;
        observation.heardMs=Math.round(body.heardSeconds*1_000);
      }
      if (interruption) observation.interrupted=true;
      if (held) observation.heldAtMs=held.heldAt;
      return state;
    };
    const record = () => audioTransaction(pool,async db=>{
      const state=await authorizedState(db);
      const old=checkReceipt(state.journey.sections[body.section],body.operationId,digest);
      if(old) return {receipt:old,replayed:true};
      if(body.section==='reading'&&state.journey.lr_hold_cohort===true
          &&(await readSubmissionHold(db,submissionHoldKey(body)))?.review_only)throw readingReviewRequired();
      const timing=timingForAudio(assets,slug,state.journey.audio_hash);
      const applied=interruption?await commitInterruption(db,state,body,timing,profile):await commit(db,state,body,timing,profile,observation);
      if (shouldHold&&writing) {
        if (!queueWriting) throw problem('OFFLINE_GRADING_UNAVAILABLE','Chưa thể xác nhận hàng chờ chấm. Bản đã được giữ để đối soát.',503);
        await queueWriting(db,applied.attemptToken,slug);
      }
      const receipt={...applied,...outcome,version,section:body.section,operationId:body.operationId,payloadHash:digest,
        examSessionToken:state.session.id,generation:body.generation,capturedAt:body.capturedAt};
      await db.query(`UPDATE ${table} SET sections=$2::jsonb WHERE session_id=$1`,
        [state.session.id,JSON.stringify({...state.journey.sections,[body.section]:receipt})]);
      if (shouldHold) await removeSubmissionHold(db,holdKey);
      return {receipt,replayed:false};
    });
    let result;
    try {
      if (holdKey) {
        try {
          held=await audioTransaction(pool,async db=>{
            const state=await authorizedState(db);
            shouldHold=writing?writingHoldAllowed(state.journey):lrHoldAllowed(state.journey);
            if(!shouldHold)return undefined;
            if(writing){
              if(!profile.twoTasks&&body.answers.task1!=='')throw problem('OFFLINE_INVALID','Term 1 chỉ nhận Task 2.',400);
            }else{
              await readMiniSectionDefinition(db,state.session,body,slug);
            }
            return retainSubmission(db,state,body,input,digest,holdKey,candidateOptions,reviewOnly);
          });
        } catch (error) {
          if (error.status) throw error;
          report('offline_hold_unconfirmed',undefined,'HOLD_TRANSACTION_UNCONFIRMED');
          throw problem('OFFLINE_HOLD_UNAVAILABLE','Chưa lưu được bản đối soát. Hãy giữ bản trên thiết bị.',503);
        }
      }
      if(reviewOnly){
        if(!shouldHold)throw problem('OFFLINE_REVIEW_UNAVAILABLE','Chưa thể giữ bản Reading trên máy chủ.',503);
        if(!held)throw problem('OFFLINE_CONFLICT','Phần Reading này đã có biên nhận.');
        observation.deadlineAtMs=body.startedAt+assets.getTiming(slug).readingDurationMinutes*60_000;
        throw readingReviewRequired();
      }
      result = await record();
    } catch (error) {
      if (error.code==='OFFLINE_HOLD_UNAVAILABLE') throw error;
      if (!error.status) {
        report('offline_submission_unconfirmed',undefined,'SUBMISSION_TRANSACTION_UNCONFIRMED');
        if (shouldHold) throw problem('OFFLINE_SUBMISSION_UNAVAILABLE','Chưa xác nhận được bài nộp. Hãy giữ bản trên thiết bị để tra lại.',503);
        throw error;
      }
      report('offline_submission_rejected',false,error.reasonCode??error.code);
      if (held && error.status && error.code !== 'OFFLINE_SCOPE') error.held=held;
      throw error;
    }
    const event=result.replayed ? 'offline_submission_replayed'
      : interruption ? 'offline_interruption_committed' : 'submission_completed';
    report(event, true,
      result.replayed ? 'RECEIPT_REPLAYED' : 'RECEIPT_COMMITTED');
    if(body.section==='writing' && (!shouldHold || result.replayed)) writingAccepted?.(result.receipt.attemptToken);
    if(writing&&shouldHold&&!result.replayed) {
      try { writingCommitted?.(); } catch {}
    }
    if(profile.paper&&result.receipt.completed&&(!shouldHold||!result.replayed))paperAccepted?.(result.receipt.attemptToken,slug);
    return {ok:true,receipt:result.receipt};
  };
  app.post(prefix+'/seal',writeLimiter,route(profile.writing?termSection:attemptSection,receive(false)));
  if(!profile.paper&&(profile.writing||lrHoldOptions))app.post(prefix+'/reading-review',writeLimiter,
    route(attemptSection.extend({section:z.literal('reading'),automatic:z.literal(true)}),receive(false,true)));
  if (!profile.paper) app.post(prefix+'/interrupt',writeLimiter,route(interruptedListening,receive(true)));
}
