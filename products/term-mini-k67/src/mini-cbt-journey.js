import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audioTransaction } from './audio-incidents.js';
import { sealMiniCbtSection } from './mini-cbt-offline.js';
import { miniR2Audio, R2_POLICY } from './mini-r2-audio.js';
import { publicAudioCatalog } from './public-audio-catalog.js';

const slug = 'mini-test-lesson-5';
const prefix = `/api/term-tests/${slug}/cbt-journey`;
const version = 'mini-k67-cbt-journey-v1';
const recovery = 72 * 60 * 60 * 1_000;
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = z.object({ examSessionToken: z.uuid(), generation: z.number().int().nonnegative(),
  deviceProof: z.string().regex(/^[a-f0-9]{64}$/) });
const open = scope.extend({ classCode: z.string().regex(/^[A-Z0-9._-]{2,32}$/), studentRef: z.uuid() });
const attemptSection = scope.extend({ operationId: z.uuid(), section: z.enum(['listening','reading']), previousOperationId: z.uuid().nullable(),
  startedAt: ts, capturedAt: ts, revision: ts, automatic: z.boolean(), eofAt: ts.nullable(),
  heardSeconds: z.number().min(0).max(7200), answers: z.record(z.string().regex(/^\d{1,2}$/), z.string().max(120)) });
const problem = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const clock = value => new Date(value).getTime();
const sha = value => createHash('sha256').update(value).digest('hex');
const initial = session => session.exam_mode === 'read_first' ? 'reading' : 'listening';
const peer = section => section === 'reading' ? 'listening' : 'reading';

async function lock(db, body) {
  const owner = (await db.query(`SELECT erp_course_class_id,erp_student_contact_id FROM assessment.term_test_exam_session
    WHERE id=$1 AND test_slug=$2`, [body.examSessionToken, slug])).rows[0];
  if (!owner) throw problem('OFFLINE_SCOPE', 'Không tìm thấy đúng lượt thi.', 403);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${slug}:${owner.erp_course_class_id}:${owner.erp_student_contact_id}`]);
  const session = (await db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE', [body.examSessionToken])).rows[0];
  if (!session || session.superseded_at || Number(session.generation) !== body.generation
      || !['legacy','cbt'].includes(session.attempt_mode)) throw problem('OFFLINE_SCOPE', 'Lượt thi đã thay đổi.', 403);
  const attempt = session.attempt_id ? (await db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1 FOR UPDATE', [session.attempt_id])).rows[0] : null;
  if ((session.attempt_id && !attempt) || (attempt && (attempt.superseded_at || attempt.exam_session_id !== session.id
      || Number(attempt.generation) !== body.generation || attempt.attempt_mode === 'answer_sheet'))) {
    throw problem('OFFLINE_SCOPE', 'Không khớp bài thi đang lưu.', 403);
  }
  const journey = (await db.query('SELECT * FROM assessment.mini_k67_cbt_journey WHERE session_id=$1 FOR UPDATE', [session.id])).rows[0];
  const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  return { session, attempt, journey, now };
}

function signature(secret, row) {
  return createHmac('sha256', secret).update([version, row.session_id, row.generation, row.student_ref, row.device_hash, row.audio_hash].join(':')).digest('hex');
}

function authorize(body, state, supplied, secret) {
  const row = state.journey;
  if (!row || Number(row.generation) !== body.generation || row.device_hash !== sha(body.deviceProof)
      || !/^[a-f0-9]{64}$/.test(supplied || '') || !timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(signature(secret,row),'hex'))) {
    throw problem('OFFLINE_SCOPE', 'Quyền không khớp thiết bị và lượt thi.', 403);
  }
  if (row.activated_at && clock(state.now) > clock(row.activated_at) + recovery) {
    throw problem('OFFLINE_REVIEW_REQUIRED', 'Đã quá thời gian gửi lại. Giữ bản trên thiết bị để đối soát.');
  }
}

function timeline(body, state, timing) {
  const { session, journey, now } = state;
  if (!journey.activated_at) throw problem('OFFLINE_NOT_STARTED', 'Chưa bắt đầu bài trên máy chủ.');
  const first = initial(session);
  const previous = journey.sections[first];
  const activation = clock(journey.activated_at);
  if ((body.section === first && (body.previousOperationId !== null || body.startedAt !== activation))
      || (body.section !== first && (!previous || body.previousOperationId !== previous.operationId || body.startedAt < previous.capturedAt))
      || body.capturedAt < body.startedAt || body.capturedAt > Math.min(clock(now) + 3_000, activation + recovery)) {
    throw problem('OFFLINE_TIMELINE', 'Thứ tự hoặc mốc làm bài không khớp. Bản trên máy vẫn được giữ.');
  }
  if (body.section === 'reading') {
    if (body.eofAt !== null || body.heardSeconds !== 0) throw problem('OFFLINE_TIMELINE', 'Mốc Reading không hợp lệ.');
    return body.startedAt + timing.readingDurationMinutes * 60_000;
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

async function commit(db, state, body, timing) {
  const deadline = timeline(body, state, timing);
  const listening = body.section === 'listening';
  const { session, attempt } = state;
  if (session.listening_audio_incident_id || (listening ? session.listening_submitted_at : attempt?.reading_submitted_at)) {
    throw problem('OFFLINE_CONFLICT', 'Phiên trên máy chủ đã thay đổi. Giữ bài để đối soát.');
  }
  await db.query("SELECT set_config('k67.mini_journey',$1,true)",[session.id]);
  const dates = [new Date(body.startedAt).toISOString(),new Date(deadline).toISOString()];
  let row;
  if (listening) {
    row = (await db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=$2,listening_deadline_at=$3,
      listening_eof_at=$4 WHERE id=$1 RETURNING *`, [session.id,...dates,body.eofAt === null ? null : new Date(body.eofAt).toISOString()])).rows[0];
    row.server_now = state.now;
  } else {
    if (!attempt) throw problem('OFFLINE_CONFLICT', 'Chưa gắn được phần Reading vào lượt.');
    row = (await db.query(`UPDATE assessment.term_test_attempt SET reading_started_at=$2,reading_deadline_at=$3
      WHERE id=$1 RETURNING *`,[attempt.id,...dates])).rows[0];
    session.server_now = state.now;
  }
  return sealMiniCbtSection(db, { session: listening ? row : session, attempt: listening ? attempt : row,
    record: row, start: body.startedAt, deadline, listening }, { ...body, capturedAt: new Date(body.capturedAt).toISOString() });
}

export function mountMiniCbtJourney(app, { pool, config, assets, requireContext, readStudent, readLimiter, writeLimiter }) {
  if (!['on','drain'].includes(config.miniCbtJourneyMode)) return;
  const secret = config.termTestSessionSecret;
  const route = (schema, action) => async (req,res,next) => {
    res.set('Cache-Control','no-store');
    try {
      if (!secret || secret.length < 32 || !assets) throw problem('OFFLINE_UNAVAILABLE', 'Chưa sẵn sàng cấp bài.',503);
      const body = schema.safeParse(req.body);
      if (!body.success) throw problem('OFFLINE_INVALID', 'Yêu cầu chưa hợp lệ.',400);
      res.json(await action(body.data,req));
    } catch (error) {
      if (!error.status) return next(error);
      res.status(error.status).json({ok:false,error:error.code,message:error.message});
    }
  };
  app.post(prefix+'/prepare',writeLimiter,requireContext,route(open,async (body,req) => {
    const selected = (await readStudent(req,body.classCode,slug,body.studentRef)).rows[0];
    const manifest = assets.getMiniJourneyManifest?.() || publicAudioCatalog[slug];
    return audioTransaction(pool,async db => {
      const {session,attempt,journey,now} = await lock(db,body);
      if (!selected || String(selected.class_id) !== String(session.erp_course_class_id)
          || String(selected.student_id) !== String(session.erp_student_contact_id) || Number(selected.definition_version) !== Number(session.definition_version)) {
        throw problem('OFFLINE_SCOPE','Không đúng lớp hoặc học viên.',403);
      }
      if (journey?.device_hash !== undefined && (journey.device_hash !== sha(body.deviceProof) || journey.student_ref !== body.studentRef)) {
        throw problem('OFFLINE_SCOPE','Lượt đã được giữ ở thiết bị khác.',403);
      }
      if (!journey && (session.listening_started_at || session.listening_submitted_at || attempt?.reading_started_at || attempt?.reading_submitted_at
          || session.audio_owner_id || config.miniCbtJourneyMode !== 'on')) throw problem('OFFLINE_NEW_DISABLED','Lượt này tiếp tục bằng cách đã mở.');
      const row = journey || (await db.query(`INSERT INTO assessment.mini_k67_cbt_journey
        (session_id,generation,student_ref,device_hash,audio_hash) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [session.id,body.generation,body.studentRef,sha(body.deviceProof),manifest.sha256])).rows[0];
      if (row.audio_hash !== manifest.sha256 || Number(row.generation) !== body.generation) throw problem('OFFLINE_SCOPE','Bản đề đã thay đổi.',403);
      return {ok:true,version,examSessionToken:session.id,generation:body.generation,attemptToken:attempt?.id||session.id,
        studentRef:body.studentRef,studentName:session.student_name_snapshot,examMode:session.exam_mode||'lis_first',
        activatedAt:row.activated_at?clock(row.activated_at):null,serverNow:clock(now),permit:signature(secret,row),
        content:await assets.getContent(slug),timing:assets.getTiming(slug),audioManifest:manifest,
        ...miniR2Audio({config,slug,row:{...session,attempt_mode:'cbt'},manifest,requested:R2_POLICY})};
    });
  }));
  app.post(prefix+'/begin',writeLimiter,route(scope,(body,req)=>audioTransaction(pool,async db => {
    const state=await lock(db,body);
    authorize(body,state,req.get('x-term2-permit'),secret);
    if (!state.journey.activated_at && (state.session.listening_started_at || state.attempt?.reading_started_at || state.session.audio_owner_id)) {
      throw problem('OFFLINE_CONFLICT','Lượt đã bắt đầu trên máy chủ.');
    }
    const activated = state.journey.activated_at || (await db.query(`UPDATE assessment.mini_k67_cbt_journey
      SET activated_at=clock_timestamp() WHERE session_id=$1 RETURNING activated_at`,[state.session.id])).rows[0].activated_at;
    return {ok:true,version,examSessionToken:state.session.id,generation:body.generation,activatedAt:clock(activated),serverNow:clock(state.now)};
  })));
  app.post(prefix+'/seal',writeLimiter,route(attemptSection,(body,req)=>audioTransaction(pool,async db => {
    const state=await lock(db,body);
    authorize(body,state,req.get('x-term2-permit'),secret);
    const {deviceProof,...input}=body;
    const answerEntries=Object.entries(input.answers).sort(([left],[right])=>left.localeCompare(right));
    const digest=sha(JSON.stringify({...input,answers:Object.fromEntries(answerEntries)}));
    const old=state.journey.sections[body.section];
    if(old){
      if(old.operationId!==body.operationId||old.payloadHash!==digest)throw problem('OFFLINE_CONFLICT','Mã nộp không khớp bản đã nhận.');
      return {ok:true,receipt:old};
    }
    const applied=await commit(db,state,body,assets.getTiming(slug));
    const receipt={...applied,version,section:body.section,operationId:body.operationId,payloadHash:digest,
      examSessionToken:state.session.id,generation:body.generation,capturedAt:body.capturedAt};
    await db.query('UPDATE assessment.mini_k67_cbt_journey SET sections=$2::jsonb WHERE session_id=$1',
      [state.session.id,JSON.stringify({...state.journey.sections,[body.section]:receipt})]);
    return {ok:true,receipt};
  })));
}
