import {createHash} from 'node:crypto';
import {z} from 'zod';

const resumeLimit = 2;
const replayWindow = 72 * 60 * 60 * 1000;
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const listeningOperation = z.object({
  operationId: z.uuid(),
  playerId: z.uuid(),
  expectedRevision: z.number().int().min(0).max(8),
  phase: z.enum(['running','paused']),
  positionMs: z.number().int().min(0).max(7_200_000),
  resumeCount: z.number().int().min(0).max(resumeLimit),
  interruptionId: z.uuid(),
  recoverable: z.boolean().nullable(),
  observedAt: z.string().datetime({precision:3}),
  startedAt: timestamp
});

const clockTable = 'assessment.term_k67_cbt_listening_clock';
const operationTable = 'assessment.term_k67_cbt_listening_clock_operation';
const error = (code,message,status=409) => Object.assign(new Error(message),{code,status});

export async function listeningRecoveryVersion(db,sessionId,enrollDurationMs) {
  if (enrollDurationMs !== undefined) {
    await db.query(`INSERT INTO ${clockTable} (session_id,duration_ms) VALUES ($1,$2)`,
      [sessionId,enrollDurationMs]);
    return 1;
  }
  const {rows} = await db.query(`SELECT 1 FROM ${clockTable} WHERE session_id=$1`,[sessionId]);
  return rows.length ? 1 : undefined;
}

function sample(previous,operation,{durationMs,serverNow}) {
  const {phase,positionMs,resumeCount,interruptionId,recoverable,observedAt,startedAt} = operation;
  const at = Date.parse(observedAt);
  const last = previous ? Date.parse(previous.observedAt) : startedAt;
  const priorPosition = previous?.positionMs ?? 0;
  if (at < last || at > serverNow + 2000 || serverNow - at > replayWindow ||
      positionMs < priorPosition || positionMs >= durationMs || positionMs - priorPosition > at - last + 750) {
    throw error('LISTENING_CLOCK_TIME_CONFLICT','Mốc nghe chưa khớp thời gian của lượt thi.');
  }
  const priorCount = previous?.resumeCount ?? 0;
  if (phase === 'paused') {
    if (previous?.phase === 'paused' || previous?.interruptionId === interruptionId ||
        typeof recoverable !== 'boolean' || (recoverable && resumeCount >= resumeLimit) || resumeCount !== priorCount) {
      throw error('LISTENING_CLOCK_SEQUENCE_CONFLICT','Đợt gián đoạn không khớp với mốc nghe trước đó.');
    }
  } else if (previous?.phase !== 'paused' || !previous.recoverable || recoverable !== null ||
      interruptionId !== previous.interruptionId || resumeCount !== priorCount + 1 ||
      positionMs - priorPosition < 70 || positionMs - priorPosition > 1500) {
    throw error('LISTENING_CLOCK_RESUME_INVALID','Chưa xác minh được phát tiếp từ đúng mốc.');
  }
  return {phase,positionMs,resumeCount,interruptionId,recoverable,observedAt,remainingMs:durationMs-positionMs};
}

export async function commitCbtListeningClock(db,{state,operation,first,onDuplicate}) {
  const {session,journey,now} = state;
  const {rows:[saved]} = await db.query(`SELECT duration_ms,revision,started_at_ms,snapshot
    FROM ${clockTable} WHERE session_id=$1 FOR UPDATE`,[session.id]);
  if (!saved) throw error('LISTENING_CLOCK_NOT_ENABLED','Lượt này dùng đồng hồ Listening ban đầu.',403);

  const digest = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
  const {rows:[seen]} = await db.query(`SELECT session_id,request_sha256,receipt
    FROM ${operationTable} WHERE operation_id=$1`,[operation.operationId]);
  if (seen) {
    if (seen.session_id !== session.id || seen.request_sha256 !== digest) {
      throw error('LISTENING_CLOCK_OPERATION_CONFLICT','Mã đồng bộ đã dùng cho một mốc khác.');
    }
    onDuplicate();
    return seen.receipt;
  }
  const prior = journey.sections?.reading;
  if (!journey.activated_at || (first === 'reading' && !prior)) {
    throw error('LISTENING_CLOCK_START_REQUIRED','Đang chờ xác nhận phần thi trước Listening.');
  }
  const terminal = journey.sections?.listening;
  const serverNow = new Date(now).getTime();
  const activation = new Date(journey.activated_at).getTime();
  const observed = Date.parse(operation.observedAt);
  if (first === 'listening' ? operation.startedAt !== activation : operation.startedAt < prior.capturedAt) {
    throw error('LISTENING_CLOCK_TIME_CONFLICT','Mốc bắt đầu Listening không khớp thứ tự thi.');
  }
  if ((saved.started_at_ms != null && Number(saved.started_at_ms) !== operation.startedAt) ||
      (terminal && observed > terminal.capturedAt)) {
    throw error('LISTENING_CLOCK_CLOSED','Mốc này không thuộc phần Listening đang làm.');
  }
  if (saved.revision !== operation.expectedRevision) {
    throw error('LISTENING_CLOCK_REVISION_CONFLICT','Bản gửi không khớp trạng thái đồng hồ đã nhận.');
  }
  const clock = sample(saved.snapshot,operation,{durationMs:saved.duration_ms,serverNow});
  const receipt = {ok:true,version:1,operationId:operation.operationId,playerId:operation.playerId,
    examSessionToken:session.id,generation:Number(session.generation),revision:saved.revision+1,clock};
  await db.query(`UPDATE ${clockTable} SET revision=$2,started_at_ms=$3,snapshot=$4::jsonb WHERE session_id=$1`,
    [session.id,receipt.revision,operation.startedAt,JSON.stringify(clock)]);
  await db.query(`INSERT INTO ${operationTable} (operation_id,session_id,request_sha256,receipt)
    VALUES ($1,$2,$3,$4::jsonb)`,[operation.operationId,session.id,digest,JSON.stringify(receipt)]);
  return receipt;
}
