// Nhận mốc nghe của đúng phiên; khóa hàng, chống lặp và trả hạn đã lưu thật.
// Dữ liệu lỗi/bài đã nộp không được cập nhật. Không in token hoặc đáp án vào lỗi/log.
const interrupted = new Set(['pause', 'waiting', 'stalled', 'pagehide']);
const recovery = new Set(['recovered', 'resume']);
import {listeningAudioSnapshot} from './audio-incidents.js';
export class AudioRecoveryError extends Error {
  constructor(code,message){super(message);this.status=409;this.code=code;}
}
const fail = (code, message) => new AudioRecoveryError(code,message);
function response(row, granted=0) {
  return {ok:true, listeningDeadlineAt:new Date(row.listening_deadline_at).toISOString(),
    listeningResumeAtSeconds:Number(row.listening_audio_checkpoint_seconds)||0,
    listeningRecoverySeconds:Number(row.listening_recovery_seconds)||0,
    grantedRecoverySeconds:granted, serverNow:new Date(row.server_now).toISOString()};
}

// Hàm này chạy trong giao dịch của bên gọi: RF giữ khóa cùng giao dịch mở kỹ năng.
export async function recordListeningAudio(db, {examSessionToken, slug, heardSeconds, state, eventId, generation, durationSeconds}) {
  const result=await db.query(`SELECT s.*,a.superseded_at AS bound_superseded_at,
    a.generation AS bound_generation,a.exam_mode AS bound_mode,a.reading_submitted_at,
    a.listening_submitted_at AS bound_listening_submitted_at,clock_timestamp() AS server_now
    FROM assessment.term_test_exam_session s
    LEFT JOIN assessment.term_test_attempt a ON a.exam_session_id=s.id AND a.superseded_at IS NULL
    WHERE s.id=$1 AND s.test_slug=$2 FOR UPDATE OF s`,[examSessionToken,slug]);
  const row=result.rows[0];
  if(!row||!row.listening_started_at||!row.listening_deadline_at||row.attempt_mode==='answer_sheet'
    ||row.superseded_at||row.listening_submitted_at||row.bound_listening_submitted_at
    ||(generation!==undefined&&Number(row.generation)!==generation)
    ||(row.bound_generation!==null&&row.bound_generation!==undefined&&Number(row.bound_generation)!==Number(row.generation))
    ||(row.exam_mode==='read_first'&&(!row.bound_mode||!row.reading_submitted_at))) {
    throw fail('AUDIO_PROGRESS_LOCKED','Phiên Listening đã kết thúc hoặc không còn hợp lệ.');
  }
  // Phiên bảo vệ mới chỉ được bù qua sự cố tường minh; playing/recovered cũ không đóng hold.
  if(Number(row.listening_audio_protocol_version)===1){
    if(!row.listening_audio_incident_id&&state==='playing'){
      const now=new Date(row.server_now).getTime(),maximum=Math.max(0,(now-new Date(row.listening_started_at).getTime())/1000-Number(row.listening_recovery_seconds||0)+3);
      const accepted=Math.max(Number(row.listening_audio_checkpoint_seconds)||0,Math.min(heardSeconds,maximum,durationSeconds||7200));
      await db.query(`UPDATE assessment.term_test_exam_session SET listening_audio_checkpoint_seconds=$2,
        listening_audio_checkpoint_at=clock_timestamp(),listening_audio_state='playing' WHERE id=$1`,[row.id,accepted]);
    }
    return{ok:true,...await listeningAudioSnapshot(db,row.id)};
  }
  const journal=Boolean(eventId&&state!=='playing');
  if(journal) {
    const old=(await db.query(`SELECT playback_state,heard_seconds FROM assessment.term_test_audio_recovery_event
      WHERE exam_session_id=$1 AND event_id=$2`,[examSessionToken,eventId])).rows[0];
    if(old) {
      if(old.playback_state!==state||Number(old.heard_seconds)!==heardSeconds)throw fail('AUDIO_EVENT_CONFLICT','Mã khôi phục đã được dùng với dữ liệu khác.');
      return response(row);
    }
  }
  const now=new Date(row.server_now).getTime(),previous=Number(row.listening_audio_checkpoint_seconds)||0;
  const total=Number(row.listening_recovery_seconds)||0;
  const initial=row.listening_audio_checkpoint_at===null;
  const previousAt=initial?now:new Date(row.listening_audio_checkpoint_at).getTime();
  const maximum=Math.max(0,(now-new Date(row.listening_started_at).getTime())/1000-total+3);
  const duration=Number.isFinite(durationSeconds)?durationSeconds:7200;
  const accepted=Math.min(heardSeconds,maximum,duration);
  // Yêu cầu cũ không được làm lùi mốc hoặc xóa dấu ngắt của yêu cầu mới hơn.
  if(accepted<previous||(state==='playing'&&interrupted.has(row.listening_audio_state)&&accepted===previous))return response(row);
  const position=Math.max(previous,accepted),advance=position-previous;
  const canRecover=recovery.has(state)&&eventId&&!initial&&position<duration
    &&(state==='resume'||interrupted.has(row.listening_audio_state));
  const granted=canRecover?Math.min(Math.max(0,900-total),Math.max(0,Math.floor((now-previousAt)/1000-advance))):0;
  const at=interrupted.has(state)?Math.min(now,previousAt+advance*1000):now;
  const saved=(await db.query(`UPDATE assessment.term_test_exam_session SET
    listening_audio_checkpoint_seconds=$2,listening_audio_checkpoint_at=$3,
    listening_audio_state=$4,listening_recovery_seconds=listening_recovery_seconds+$5,
    listening_deadline_at=listening_deadline_at+make_interval(secs=>$5::double precision),updated_at=clock_timestamp()
    WHERE id=$1 RETURNING *,clock_timestamp() AS server_now`,
    [examSessionToken,position,new Date(at).toISOString(),recovery.has(state)?'playing':state,granted])).rows[0];
  if(journal)await db.query(`INSERT INTO assessment.term_test_audio_recovery_event
    (exam_session_id,event_id,playback_state,heard_seconds,granted_seconds) VALUES($1,$2,$3,$4,$5)`,
    [examSessionToken,eventId,state,heardSeconds,granted]);
  return response(saved,granted);
}

// LF/API checkpoint tự mở giao dịch; lỗi rollback cả mốc, hạn và sổ chống lặp.
export async function checkpointListeningAudio(pool, input) {
  const db=await pool.connect();
  try {await db.query('BEGIN');const out=await recordListeningAudio(db,input);await db.query('COMMIT');return out;}
  catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
