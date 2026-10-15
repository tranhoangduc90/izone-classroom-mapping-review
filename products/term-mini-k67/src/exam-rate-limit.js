import {ipKeyGenerator,rateLimit} from 'express-rate-limit';
import {z} from 'zod';

// Token chỉ chọn ngân sách sau khi tìm thấy đúng phiên/lượt trong SQL; không cấp quyền nghiệp vụ.
// Token sai, thiếu, khác đề hoặc khác generation vẫn chung bộ đếm IP, kể cả khi đổi UUID liên tục.
const uuid=z.uuid();
export const examRateKey=req=>req.examRateIdentity||`ip:${ipKeyGenerator(req.ip)}`;
export function examRateIdentity(pool){
  // Cache chỉ nhớ ngân sách của token từng được SQL xác minh, tuyệt đối không thay kiểm quyền ở handler.
  // Chặn tra token lạ theo IP trước DB; flood UUID không được tạo vô hạn truy vấn hoặc bộ đếm.
  const known=new Map(),ttl=8*3600_000,maximum=20_000;
  const lookupLimit=rateLimit({windowMs:60_000,limit:900,standardHeaders:'draft-8',legacyHeaders:false,
    message:{ok:false,error:'RATE_LIMITED',message:'Có quá nhiều yêu cầu xác minh phiên; vui lòng thử lại sau.'}});
  return async(req,res,next)=>{
    try{
      const asset=req.method==='GET'?req.path.match(/^\/api\/term-tests\/(term-test-1|term-test-2|mini-test-lesson-5)\/session\/([^/]+)\/(?:audio|preview)$/):null;
      if(req.method!=='POST'&&!asset)return next();
      const route=req.path.match(/^\/api\/term-tests\/(term-test-1|term-test-2|mini-test-lesson-5)\/(?:session\/(?:start|prepare|resume-attempt|audio-(?:progress|state|incident|resume|access|owner))|listening(?:\/draft)?|reading(?:\/(?:start|draft))?|client-event)$/);
      const result=/^\/api\/term-tests\/(?:result(?:\/review)?|writing)$/.test(req.path);
      if(!route&&!result&&!asset)return next();
      const body=asset?{examSessionToken:asset[2]}:req.body||{},slug=asset?.[1]||route?.[1]||null;
      if(body.generation!==undefined&&(!Number.isSafeInteger(body.generation)||body.generation<0||body.generation>2147483647))return next();
      const generation=body.generation??null;
      const session=uuid.safeParse(body.examSessionToken).success&&slug;
      const attempt=!session&&uuid.safeParse(body.attemptToken).success;
      if(!session&&!attempt)return next();
      const token=session?body.examSessionToken:body.attemptToken;
      const cacheKey=JSON.stringify([session?'session':'attempt',token,slug,generation]);
      const cached=known.get(cacheKey);
      if(cached&&cached.until>Date.now()){req.examRateIdentity=cached.identity;return next();}
      if(cached)known.delete(cacheKey);
      const allowed=await new Promise((resolve,reject)=>{
        const finish=()=>{res.off('finish',finish);resolve(false);};res.once('finish',finish);
        lookupLimit(req,res,error=>{res.off('finish',finish);if(error)reject(error);else resolve(true);});
      });
      if(!allowed)return;
      let rows=[];
      if(session){
        ({rows}=await pool.query(`SELECT id FROM assessment.term_test_exam_session
          WHERE id=$1 AND test_slug=$2 AND superseded_at IS NULL AND ($3::integer IS NULL OR generation=$3)`,[body.examSessionToken,slug,generation]));
        if(rows?.length)req.examRateIdentity=`session:${rows[0].id}`;
      }else if(attempt){
        ({rows}=await pool.query(`SELECT id FROM assessment.term_test_attempt WHERE id=$1 AND superseded_at IS NULL
          AND ($2::text IS NULL OR test_slug=$2) AND ($3::integer IS NULL OR generation=$3)`,[body.attemptToken,slug,generation]));
        if(rows?.length)req.examRateIdentity=`attempt:${rows[0].id}`;
      }
      if(req.examRateIdentity){
        // GET audio dùng token ngay trong path, không có trường generation; handler vẫn tự kiểm quyền.
        const keys=session?[cacheKey,JSON.stringify(['session',token,slug,null])]:[cacheKey];
        for(const key of keys){
          if(known.size>=maximum)known.delete(known.keys().next().value);
          known.set(key,{identity:req.examRateIdentity,until:Date.now()+ttl});
        }
      }
      next();
    }catch(error){next(error);}
  };
}
