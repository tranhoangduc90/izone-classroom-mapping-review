import {z} from 'zod';
import {audioTransaction,listeningAudioSnapshot} from './audio-incidents.js';
import {AudioRecoveryError} from './audio-recovery.js';
import {assertAudioOwner} from './audio-owner.js';

// Nhận mã phiên từ POST; kiểm quyền hiện tại trước khi cấp metadata hoặc khóa trong RAM.
// Metadata ghim một lần: thay file trên server không được đổi nội dung của phiên đang thi.
export async function pinAudioManifest(db,assets,slug,token) {
  if(!assets?.getAudioManifest)return null; // Server/fixture cũ không quảng bá cache bền.
  let row=(await db.query('SELECT listening_audio_manifest FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE',[token])).rows[0];
  if(!row)return null;
  if(!row.listening_audio_manifest){
    const manifest=await assets.getAudioManifest(slug);
    row=(await db.query(`UPDATE assessment.term_test_exam_session SET listening_audio_manifest=$2
      WHERE id=$1 RETURNING listening_audio_manifest`,[token,JSON.stringify(manifest)])).rows[0];
  }
  return row.listening_audio_manifest;
}
export const audioManifestFor=async(pool,assets,slug,token)=>audioTransaction(pool,db=>pinAudioManifest(db,assets,slug,token));

export async function authorizeAudioSession(db,input,slug,skipOwner=false,onlyOwner=false){
  const row=(await db.query(`SELECT * FROM assessment.term_test_exam_session WHERE id=$1 AND test_slug=$2 FOR UPDATE`,[input.examSessionToken,slug])).rows[0];
  const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  if(onlyOwner&&Number(row?.audio_owner_protocol)!==1)return{row,now};
  if(!row||row.superseded_at||row.listening_submitted_at||row.attempt_mode==='answer_sheet'
    ||Number(row.generation)!==Number(input.generation??0))throw new AudioRecoveryError('AUDIO_ACCESS_LOCKED','Phiên audio không còn hợp lệ.');
  const attempt=(await db.query(`SELECT generation,superseded_at,listening_submitted_at,reading_submitted_at
    FROM assessment.term_test_attempt WHERE exam_session_id=$1`,[row.id])).rows[0];
  if((attempt&&(attempt.superseded_at||attempt.listening_submitted_at||Number(attempt.generation)!==Number(row.generation)))
    ||(row.exam_mode==='read_first'&&!attempt?.reading_submitted_at)
    ||(!attempt&&new Date(now)-new Date(row.prepared_at)>8*3600_000))throw new AudioRecoveryError('AUDIO_ACCESS_LOCKED','Phiên audio đã hết quyền truy cập.');
  if(!skipOwner)assertAudioOwner(row);
  return {row,now};
}

export function mountAudioAccess(app,{pool,assets,limiter,enabled}) {
  const schema=z.object({examSessionToken:z.uuid(),generation:z.number().int().nonnegative()});
  app.post('/api/term-tests/:testSlug/session/audio-access',limiter,async(req,res,next)=>{
    try {
      const input=schema.safeParse(req.body),slug=req.params.testSlug;
      if(!input.success||!assets?.supports(slug))return res.status(400).json({ok:false,error:'INVALID_AUDIO_ACCESS'});
      if(!enabled||!assets.getAudioManifest)return res.set('Cache-Control','no-store, private').json({ok:true,audioCacheSupported:false});
      const value=await audioTransaction(pool,async db=>{
        const {row,now}=await authorizeAudioSession(db,input.data,slug);
        const manifest=await pinAudioManifest(db,assets,slug,row.id);
        return {ok:true,audioCacheSupported:true,examSessionToken:row.id,generation:Number(row.generation),
          audioManifest:manifest,cacheExpiresAt:new Date(new Date(now).getTime()+24*3600_000).toISOString(),
          listeningDurationSeconds:assets.getTiming(slug).listeningDurationSeconds,
          serverNow:new Date(now).toISOString(),listeningStartedAt:row.listening_started_at,
          ...(row.listening_started_at?await listeningAudioSnapshot(db,row.id):{}),
          ...(row.listening_started_at?{audioKey:assets.getSessionAudioKey(slug,row.id).toString('base64'),audioEnvelope:{magic:'IZTT1',ivBytes:12,tagBytes:16}}:{})};
      });
      res.set('Cache-Control','no-store, private').json(value);
    }catch(error){next(error);}
  });
}
