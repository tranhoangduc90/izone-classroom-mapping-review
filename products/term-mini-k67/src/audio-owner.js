import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AudioRecoveryError} from './audio-recovery.js';
const context=new AsyncLocalStorage();
const hash=value=>createHash('sha256').update(typeof value==='string'?value:'').digest('hex');
export const audioOwnerContext=(req,_res,next)=>context.run(req.body||{},next);
export function assertAudioOwner(row,input=context.getStore()||{}){
  if(Number(row.audio_owner_protocol)!==1)return;
  if(!row.audio_owner_id||input.ownerId!==row.audio_owner_id||hash(input.ownerProof)!==row.audio_owner_proof_hash
    ||Number(input.ownerEpoch)!==Number(row.audio_owner_epoch)||Number(input.generation)!==Number(row.generation))
    throw new AudioRecoveryError('AUDIO_OWNER_REQUIRED','Bài đang được mở ở tab hoặc thiết bị khác. Dừng nơi cũ rồi tiếp tục tại đây.');
}
// Đặt bằng chứng chủ phát trên đúng connection/giao dịch. Trigger kiểm lại dưới khóa hàng,
// tránh request cũ vượt qua bước kiểm API rồi ghi nháp/nộp sau khi đã chuyển chủ.
export function audioOwnerPool(pool){
  const set=async(db,c)=>db.query(`SELECT set_config('k67.owner_id',$1,true),set_config('k67.owner_proof',$2,true),
    set_config('k67.owner_epoch',$3,true),set_config('k67.owner_generation',$4,true)`,
    [String(c.ownerId||''),String(c.ownerProof||''),String(c.ownerEpoch??''),String(c.generation??'')]);
  const active=()=>{const c=context.getStore();return c?.ownerId&&c?.ownerProof&&c?.ownerEpoch!==undefined?c:null;};
  return new Proxy(pool,{get(target,key){
    if(key==='connect')return async()=>{
      const db=await pool.connect(),c=active();if(!c)return db;
      return{query:async(sql,args)=>{const out=await db.query(sql,args);if(/^\s*BEGIN\b/i.test(typeof sql==='string'?sql:sql.text))await set(db,c);return out;},release:()=>db.release()};
    };
    if(key==='query')return async(sql,args)=>{
      const c=active();if(!c)return pool.query(sql,args);
      const db=await pool.connect();try{await db.query('BEGIN');await set(db,c);const out=await db.query(sql,args);await db.query('COMMIT');return out;}
      catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}
export function mountAudioOwner(app,{pool,limiter,authorize,transaction,enabled}){
  const schema=z.object({examSessionToken:z.uuid(),generation:z.number().int().nonnegative(),ownerId:z.uuid(),
    ownerProof:z.string().regex(/^[a-f0-9]{64}$/),pageId:z.uuid(),ownerEpoch:z.number().int().nonnegative().optional(),
    action:z.enum(['status','claim','release']),reclaim:z.boolean().optional()});
  app.post('/api/term-tests/:testSlug/session/audio-owner',limiter,async(req,res,next)=>{
    try{
      const p=schema.safeParse(req.body);if(!p.success)return res.status(400).json({ok:false,error:'INVALID_AUDIO_OWNER'});
      const value=await transaction(pool,async db=>{
        const d=p.data,{row}=await authorize(db,d,req.params.testSlug,true);
        if(!row.audio_owner_protocol&&(!enabled||row.listening_started_at))return{ok:true,ownerEnabled:false};
        if(d.action==='status')return{ok:true,ownerEnabled:true};
        if(d.action==='release'){
          assertAudioOwner(row,d);
          if(row.listening_started_at&&!row.listening_audio_incident_id)throw new AudioRecoveryError('AUDIO_HOLD_REQUIRED','Hãy giữ bài và dừng audio trước khi chuyển nơi làm.');
          await db.query(`UPDATE assessment.term_test_exam_session SET audio_owner_id=NULL,audio_owner_page_id=NULL,
            audio_owner_proof_hash=NULL,audio_owner_epoch=audio_owner_epoch+1 WHERE id=$1`,[row.id]);
          return{ok:true,ownerEnabled:true,released:true};
        }
        const same=row.audio_owner_id===d.ownerId&&row.audio_owner_proof_hash===hash(d.ownerProof);
        if(row.audio_owner_id&&(!same||(row.audio_owner_page_id!==d.pageId&&!d.reclaim)))
          throw new AudioRecoveryError('AUDIO_OWNER_IN_USE','Bài đang mở ở tab hoặc thiết bị khác. Quay lại nơi đang thi; không tự chuyển khi nơi cũ chưa dừng.');
        if(!same||row.audio_owner_page_id!==d.pageId){
          const out=(await db.query(`UPDATE assessment.term_test_exam_session SET audio_owner_protocol=1,audio_owner_id=$2,
            audio_owner_page_id=$3,audio_owner_proof_hash=$4,audio_owner_epoch=audio_owner_epoch+1 WHERE id=$1 RETURNING audio_owner_epoch`,
            [row.id,d.ownerId,d.pageId,hash(d.ownerProof)])).rows[0];row.audio_owner_epoch=out.audio_owner_epoch;
        }
        return{ok:true,ownerEnabled:true,ownerEpoch:Number(row.audio_owner_epoch),ownerId:d.ownerId};
      });res.set('Cache-Control','no-store, private').json(value);
    }catch(error){next(error);}
  });
}
