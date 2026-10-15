import {z} from 'zod';
import {AudioRecoveryError} from './audio-recovery.js';
import {assertAudioOwner} from './audio-owner.js';
import {randomUUID} from 'node:crypto';

// Nhận yêu cầu đúng phiên; giao dịch giữ mốc/nháp/bù giờ cùng một khóa session.
// Kết quả luôn là snapshot đã ghi. Sự cố chưa rõ hoặc quá 900 giây giữ bài chờ giáo viên.
const base=z.object({examSessionToken:z.uuid(),generation:z.number().int().nonnegative().optional()});
const position=z.number().min(0).max(7200);
const answers=z.record(z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/),z.string().max(120));
const incidentInput=base.extend({eventId:z.uuid(),incidentId:z.uuid(),heardSeconds:position,
  reason:z.enum(['manual','pause','waiting','stalled','error','startup_failed','reload','muted','freeze','lifecycle','output_lost','output_change','media_pause','media_seek']),
  answers:answers.optional(),draftRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()});
const resumeInput=base.extend({eventId:z.uuid(),incidentId:z.uuid(),resumeAttemptId:z.uuid(),
  phase:z.enum(['prepare','confirm']),heardSeconds:position});
const fail=(code,message)=>new AudioRecoveryError(code,message);
export async function audioTransaction(pool,run){
  const db=await pool.connect();
  try{await db.query('BEGIN');const value=await run(db);await db.query('COMMIT');return value;}
  catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
async function lockedSession(db,input,slug){
  const row=(await db.query(`SELECT s.*,clock_timestamp() AS server_now FROM assessment.term_test_exam_session s
    WHERE s.id=$1 AND s.test_slug=$2 FOR UPDATE`,[input.examSessionToken,slug])).rows[0];
  // Lấy thời gian sau khi đã có khóa: biểu thức trong SELECT có thể được tính trước lúc đợi khóa.
  if(row)row.server_now=(await db.query('SELECT clock_timestamp() AS server_now')).rows[0].server_now;
  if(!row||row.superseded_at||row.attempt_mode==='answer_sheet'||row.listening_submitted_at
    ||(input.generation!==undefined&&Number(row.generation)!==input.generation))throw fail('AUDIO_PROGRESS_LOCKED','Phiên Listening không còn hợp lệ.');
  const attempt=(await db.query(`SELECT generation,listening_submitted_at,exam_mode,reading_submitted_at
    FROM assessment.term_test_attempt WHERE exam_session_id=$1 AND superseded_at IS NULL`,[row.id])).rows[0];
  if((attempt&&(Number(attempt.generation)!==Number(row.generation)||attempt.listening_submitted_at))
    ||(row.exam_mode==='read_first'&&(!attempt?.reading_submitted_at)))throw fail('AUDIO_PROGRESS_LOCKED','Kỹ năng Listening chưa mở hoặc đã kết thúc.');
  assertAudioOwner(row);
  return row;
}
export async function listeningAudioSnapshot(db,id){
  const row=(await db.query('SELECT *,clock_timestamp() AS server_now FROM assessment.term_test_exam_session WHERE id=$1',[id])).rows[0];
  const incident=row?.listening_audio_incident_id?(await db.query('SELECT * FROM assessment.term_test_audio_incident WHERE incident_id=$1',[row.listening_audio_incident_id])).rows[0]:null;
  return snapshot(row,incident);
}
function snapshot(row,incident,granted=0){
  return{audioProtocolVersion:Number(row.listening_audio_protocol_version)||0,audioRevision:Number(row.listening_audio_revision)||0,
    audioPhase:row.listening_submitted_at?'submitted':incident?(incident.needs_teacher?'waiting_teacher':'holding'):'playing',
    activeIncident:incident?{incidentId:incident.incident_id,anchorSeconds:Number(incident.anchor_seconds),
      startup:incident.request_payload?.startupGuardVersion===1,
      openedAt:new Date(incident.opened_at).toISOString(),remainingMs:Number(incident.remaining_ms)}:null,
    needsTeacher:Boolean(incident?.needs_teacher),canSubmit:!incident&&!row.listening_submitted_at,
    listeningDeadlineAt:row.listening_deadline_at?new Date(row.listening_deadline_at).toISOString():null,
    listeningResumeAtSeconds:Number(row.listening_audio_checkpoint_seconds)||0,
    listeningRecoverySeconds:Number(row.listening_recovery_seconds)||0,
    recoveryRemainingSeconds:Math.max(0,900-Number(row.listening_recovery_seconds||0)),
    grantedRecoverySeconds:granted,serverNow:new Date(row.server_now).toISOString()};
}
export async function activateListeningProtection(db,input,slug,enabled){
  const row=await lockedSession(db,input,slug);
  if(enabled&&!row.listening_started_at&&Number(row.listening_audio_protocol_version)===0){
    await db.query(`UPDATE assessment.term_test_exam_session SET listening_audio_protocol_version=1
      WHERE id=$1`,[row.id]);
  }
  return row;
}
// Giữ thời gian trong chính giao dịch start; mất ACK/5xx sau commit không để phiên trôi giờ.
// Chỉ client có handshake phát đầu tiên mới dùng; không nâng phiên cũ đã bắt đầu giữa bài.
export async function guardListeningStart(db,input,slug,duration,before){
  if(input.audioStartGuardVersion!==1||before?.listening_started_at)return;
  const id=randomUUID();
  await openIncident(db,{...input,eventId:id,incidentId:id,reason:'startup_failed',startupGuardVersion:1,
    heardSeconds:Number(before?.listening_audio_checkpoint_seconds||before?.listening_resume_offset_seconds)||0},slug,duration);
}
async function openIncident(db,input,slug,duration){
  const row=await lockedSession(db,input,slug);
  if(Number(row.listening_audio_protocol_version)!==1||!row.listening_started_at)throw fail('AUDIO_PROTOCOL_REQUIRED','Phiên này chưa bật bảo vệ audio.');
  const old=(await db.query('SELECT * FROM assessment.term_test_audio_incident WHERE incident_id=$1 OR (exam_session_id=$2 AND event_id=$3)',[input.incidentId,row.id,input.eventId])).rows[0];
  if(old){
    if(old.exam_session_id!==row.id||!samePayload(old.request_payload,input))throw fail('AUDIO_EVENT_CONFLICT','Mã sự cố đã dùng với dữ liệu khác.');
    return listeningAudioSnapshot(db,row.id);
  }
  if(row.listening_audio_incident_id)return listeningAudioSnapshot(db,row.id);
  const now=new Date(row.server_now).getTime(),started=new Date(row.listening_started_at).getTime(),used=Number(row.listening_recovery_seconds)||0;
  const maximum=Math.max(0,(now-started)/1000-used+3);
  const anchor=Math.max(Number(row.listening_audio_checkpoint_seconds)||0,Math.min(input.heardSeconds,maximum,duration));
  const remaining=new Date(row.listening_deadline_at).getTime()-now;
  const needsTeacher=remaining<=0||used>=900||anchor>=duration;
  await db.query(`INSERT INTO assessment.term_test_audio_incident
    (incident_id,exam_session_id,event_id,request_payload,reason,anchor_seconds,remaining_ms,needs_teacher)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[input.incidentId,row.id,input.eventId,JSON.stringify(input),input.reason,anchor,Math.max(0,remaining),needsTeacher]);
  // Chốt nháp trước khi mở giữ bài; không ghi đè nháp có revision mới hơn đã ACK.
  if(input.answers&&input.draftRevision>Number(row.listening_draft_revision||0))await db.query(`UPDATE assessment.term_test_exam_session
    SET listening_draft=$2,listening_draft_revision=$3,listening_draft_updated_at=clock_timestamp() WHERE id=$1`,[row.id,JSON.stringify(input.answers),input.draftRevision]);
  await db.query(`UPDATE assessment.term_test_exam_session SET listening_audio_incident_id=$2,
    listening_audio_checkpoint_seconds=$3,listening_audio_checkpoint_at=clock_timestamp(),listening_audio_state='pause',
    listening_audio_revision=listening_audio_revision+1 WHERE id=$1`,[row.id,input.incidentId,anchor]);
  return listeningAudioSnapshot(db,row.id);
}
function samePayload(a,b){
  const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
  return JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
}
async function resumeIncident(db,input,slug){
  const row=await lockedSession(db,input,slug);
  const incident=(await db.query('SELECT * FROM assessment.term_test_audio_incident WHERE incident_id=$1 AND exam_session_id=$2',[input.incidentId,row.id])).rows[0];
  if(!incident)throw fail('AUDIO_INCIDENT_NOT_FOUND','Không tìm thấy sự cố của phiên này.');
  if(incident.resolved_at){
    if(incident.resume_attempt_id!==input.resumeAttemptId||(input.phase==='confirm'&&
      (incident.confirm_event_id!==input.eventId||Number(incident.confirmed_seconds)!==input.heardSeconds)))throw fail('AUDIO_EVENT_CONFLICT','Lần tiếp tục này đã được xử lý.');
    return listeningAudioSnapshot(db,row.id);
  }
  const elapsed=Math.max(0,(new Date(row.server_now).getTime()-new Date(incident.opened_at).getTime())/1000);
  const remaining=Math.max(0,900-Number(row.listening_recovery_seconds||0));
  if(incident.needs_teacher||elapsed>remaining){
    if(!incident.needs_teacher){
      await db.query('UPDATE assessment.term_test_audio_incident SET needs_teacher=true WHERE incident_id=$1',[incident.incident_id]);
      await db.query('UPDATE assessment.term_test_exam_session SET listening_audio_revision=listening_audio_revision+1 WHERE id=$1',[row.id]);
    }
    return listeningAudioSnapshot(db,row.id);
  }
  if(input.phase==='prepare'){
    if(incident.resume_attempt_id!==input.resumeAttemptId)await db.query(`UPDATE assessment.term_test_audio_incident
      SET resume_attempt_id=$2,prepared_at=clock_timestamp() WHERE incident_id=$1`,[incident.incident_id,input.resumeAttemptId]);
    return listeningAudioSnapshot(db,row.id);
  }
  const played=input.heardSeconds-Number(incident.anchor_seconds);
  const sincePrepare=(new Date(row.server_now).getTime()-new Date(incident.prepared_at).getTime())/1000;
  if(incident.resume_attempt_id!==input.resumeAttemptId||!incident.prepared_at||played<0.05||played>3||sincePrepare>10||played>sincePrepare+0.5)
    throw fail('AUDIO_RESUME_NOT_CONFIRMED','Audio chưa phát lại hợp lệ. Hãy thử âm thanh rồi tiếp tục.');
  const granted=Math.min(remaining,Math.max(0,Math.floor(elapsed-played)));
  await db.query(`UPDATE assessment.term_test_audio_incident SET resolved_at=clock_timestamp(),granted_seconds=$2,
    confirm_event_id=$3,confirmed_seconds=$4 WHERE incident_id=$1`,[incident.incident_id,granted,input.eventId,input.heardSeconds]);
  await db.query(`UPDATE assessment.term_test_exam_session SET listening_audio_incident_id=NULL,
    listening_audio_revision=listening_audio_revision+1,listening_recovery_seconds=listening_recovery_seconds+$2,
    listening_deadline_at=listening_deadline_at+make_interval(secs=>$2::double precision),
    listening_audio_checkpoint_seconds=$3,listening_audio_checkpoint_at=clock_timestamp(),listening_audio_state='playing'
    WHERE id=$1`,[row.id,granted,input.heardSeconds]);
  const out=await listeningAudioSnapshot(db,row.id);return{...out,grantedRecoverySeconds:granted};
}
export function mountAudioIncidents(app,{pool,assets,limiter}){
  for(const [suffix,schema,run] of [
    ['audio-state',base,async(db,input,slug)=>{await lockedSession(db,input,slug);return listeningAudioSnapshot(db,input.examSessionToken);}],
    ['audio-incident',incidentInput,(db,input,slug)=>openIncident(db,input,slug,assets.getTiming(slug).listeningDurationSeconds)],
    ['audio-resume',resumeInput,resumeIncident]
  ])app.post(`/api/term-tests/:testSlug/session/${suffix}`,limiter,async(req,res,next)=>{
    try{
      const parsed=schema.safeParse(req.body),slug=req.params.testSlug;
      if(!parsed.success||!assets?.supports(slug))return res.status(400).json({ok:false,error:'INVALID_AUDIO_REQUEST',message:'Yêu cầu bảo vệ audio không hợp lệ.'});
      const out=await audioTransaction(pool,db=>run(db,parsed.data,slug));res.json({ok:true,...out});
    }catch(e){next(e);}
  });
}
