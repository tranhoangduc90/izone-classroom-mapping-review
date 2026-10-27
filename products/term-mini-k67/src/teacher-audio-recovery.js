import {createHash} from 'node:crypto';
import {z} from 'zod';

const scopeSchema=z.object({class:z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  test:z.enum(['term-test-1','term-test-2','mini-test-lesson-5','term-test-1-k56','term-test-2-k56','mini-test-k56']),student:z.uuid()}).strict();
const actionSchema=scopeSchema.extend({requestId:z.uuid(),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),
  action:z.enum(['release-preparation','transfer-active']),oldDeviceStopped:z.boolean(),reason:z.string().trim().min(5).max(500)}).strict();
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const sessionSql=`WITH identities AS (
 SELECT erp_course_class_id,erp_student_contact_id FROM assessment.term_test_roster WHERE test_slug=$2 AND student_ref=$3::uuid
 UNION SELECT erp_course_class_id,erp_student_contact_id FROM mapping.student_mapping_review WHERE public_id=$3::uuid AND status<>'superseded'
 UNION SELECT erp_course_class_id,-temporary_student_id FROM assessment.term_test_temporary_student WHERE test_slug=$2 AND student_ref=$3::uuid AND active
)
SELECT s.* FROM assessment.term_test_exam_session s
 WHERE s.test_slug=$2 AND s.superseded_at IS NULL AND EXISTS(
 SELECT 1 FROM identities i JOIN mapping.classroom_course_mapping c USING(erp_course_class_id)
 WHERE i.erp_course_class_id=s.erp_course_class_id AND i.erp_student_contact_id=s.erp_student_contact_id
 AND upper(trim(c.erp_class_name_snapshot))=$1)
 ORDER BY s.prepared_at DESC,s.id DESC LIMIT 1 FOR UPDATE OF s`;
function snapshot(row,profile){
  if(!row)return {found:false};
  const occupied=Boolean(profile==='k56'?row.listening_audio_owner_id:row.audio_owner_id);
  return {found:true,version:hash(row),generation:Number(row.generation),name:row.student_name_snapshot,
    startedAt:row.listening_started_at,submittedAt:row.listening_submitted_at,deadlineAt:row.listening_deadline_at,
    checkpointSeconds:Number(row.listening_audio_checkpoint_seconds)||0,draftRevision:Number(row.listening_draft_revision)||0,
    answeredCount:Object.values(row.listening_draft||{}).filter(v=>String(v).trim()).length,occupied,
    canReleasePreparation:occupied&&!row.listening_started_at&&!row.listening_submitted_at&&row.attempt_mode!=='answer_sheet',
    canTransferActive:occupied&&Boolean(row.listening_started_at)&&!row.listening_submitted_at&&row.attempt_mode!=='answer_sheet'};
}
async function transaction(pool,run){const db=await pool.connect();try{await db.query('BEGIN');const value=await run(db);await db.query('COMMIT');return value;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}

// readScope reuses the native account/session/class/student guard of each runtime.
// Only owner fields change. Timers, drafts, checkpoints, attempts and grades stay.
export function createTeacherAudioRecovery({pool,readScope,profile='k67'}){
  async function read(input,request){return transaction(pool,async db=>{
    await readScope(db,input,request);
    const row=(await db.query(sessionSql,[input.class,input.test,input.student])).rows[0];
    return {ok:true,state:snapshot(row,profile),serverNow:new Date().toISOString()};
  });}
  async function recover(input,request){return transaction(pool,async db=>{
    await readScope(db,input,request);
    const row=(await db.query(sessionSql,[input.class,input.test,input.student])).rows[0];
    if(!row)fail('SESSION_NOT_FOUND','Chưa có phiên phù hợp.',404);
    const digest=hash(input),prior=(await db.query('SELECT * FROM assessment.term_test_audio_owner_recovery WHERE request_id=$1',[input.requestId])).rows[0];
    if(prior){if(prior.request_hash!==digest||prior.exam_session_id!==row.id)fail('RECOVERY_REQUEST_CONFLICT','Mã hỗ trợ đã dùng với dữ liệu khác.');return {ok:true,recovered:true,replayed:true,state:snapshot(row,profile)};}
    const before=snapshot(row,profile);
    if(before.version!==input.expectedVersion)fail('RECOVERY_STATE_CHANGED','Phiên vừa thay đổi. Cập nhật tiến độ rồi kiểm tra lại.');
    if(input.action==='release-preparation'&&!before.canReleasePreparation||input.action==='transfer-active'&&!before.canTransferActive)
      fail('RECOVERY_NOT_ALLOWED','Trạng thái hiện tại không cho phép thao tác này.');
    if(input.action==='transfer-active'&&!input.oldDeviceStopped)fail('OLD_DEVICE_STOP_REQUIRED','Xác nhận đã dừng hoặc đóng nơi cũ trước khi chuyển.');
    const fields=profile==='k56'?'listening_audio_owner_id=NULL,audio_state_revision=audio_state_revision+1':
      'audio_owner_id=NULL,audio_owner_page_id=NULL,audio_owner_proof_hash=NULL,audio_owner_epoch=audio_owner_epoch+1';
    const after=(await db.query(`UPDATE assessment.term_test_exam_session SET ${fields} WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    const changed=new Set(profile==='k56'?['listening_audio_owner_id','audio_state_revision']:['audio_owner_id','audio_owner_page_id','audio_owner_proof_hash','audio_owner_epoch']);
    for(const key of Object.keys(row))if(!changed.has(key)&&hash(row[key])!==hash(after[key]))fail('RECOVERY_PRESERVATION_FAILED','Chưa xác nhận được việc giữ dữ liệu. Thao tác đã được hủy.',500);
    await db.query(`INSERT INTO assessment.term_test_audio_owner_recovery(request_id,exam_session_id,request_hash,actor_email,action,reason,before_version,after_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[input.requestId,row.id,digest,request.reviewer.email,input.action,input.reason,before.version,hash(after)]);
    const receipt=(await db.query('SELECT request_id FROM assessment.term_test_audio_owner_recovery WHERE request_id=$1',[input.requestId])).rows[0];
    if(!receipt)fail('RECOVERY_NOT_PERSISTED','Chưa xác nhận lưu thao tác hỗ trợ.',500);
    return {ok:true,recovered:true,replayed:false,receiptId:receipt.request_id,state:snapshot(after,profile)};
  });}
  return {read,recover};
}

export function mountTeacherAudioRecovery(app,{pool,readScope,profile,authenticate,requireContext,limiter}){
  const service=createTeacherAudioRecovery({pool,readScope,profile}),guards=[limiter,authenticate,...(requireContext?[requireContext]:[])];
  for(const [method,schema,operation] of [['get',scopeSchema,'read'],['post',actionSchema,'recover']])app[method]('/api/term-tests/teacher/audio-recovery',...guards,async(req,res,next)=>{
    res.set('Cache-Control','private, no-store');const parsed=schema.safeParse(method==='get'?req.query:req.body);
    if(!parsed.success)return res.status(400).json({ok:false,error:'INVALID_AUDIO_RECOVERY',message:'Yêu cầu hỗ trợ audio chưa hợp lệ.'});
    try{res.json(await service[operation](parsed.data,req));}catch(error){if(error.status||error.httpStatus)return res.status(error.status||error.httpStatus).json({ok:false,error:error.code,message:error.message});next(error);}
  });
}
