import express from 'express';
import {rateLimit,ipKeyGenerator} from 'express-rate-limit';
import {z} from 'zod';
import {createHash,createHmac,createCipheriv} from 'node:crypto';
import {readFile} from 'node:fs/promises';

// Nhận danh tính từ roster K67, chỉ cấp phiên và audio làm quen riêng.
// Mọi lệnh ghi chỉ chạm bảng readiness; lỗi trả mã/hướng dẫn, không mở hoặc sửa bài thật.
const root='/api/k67-readiness/v1';
const classCode=z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/);
const tokenSchema=z.string().regex(/^k67r1_[A-Za-z0-9_-]{43}$/);
const answers=z.record(z.string().regex(/^[1-4]$/),z.string().max(120));
const base=z.object({token:tokenSchema});
const digest=value=>createHash('sha256').update(value).digest('hex');
const packVersion='listening-familiarisation-v1';
const studentSql=`SELECT s.public_id AS ref,s.erp_student_name_snapshot AS name,c.erp_course_class_id AS class_id
  FROM mapping.student_mapping_review s JOIN mapping.classroom_course_mapping c
    ON c.erp_course_class_id=s.erp_course_class_id
  WHERE upper(c.erp_class_name_snapshot)=$1 AND s.status='approved'
    AND (SELECT count(*) FROM mapping.classroom_course_mapping WHERE upper(erp_class_name_snapshot)=$1)=1
  ORDER BY s.erp_student_name_snapshot,s.public_id`;

export function mountReadiness(app,{pool,config,requireContext,audioSource}) {
  if(!config.readinessEnabled)return;
  if(!config.termTestSessionSecret||config.termTestSessionSecret.length<32)throw new Error('Thiếu khóa phiên làm quen K67.');
  const router=express.Router();
  const allowed=config.readinessClasses||new Set();
  const hmac=value=>createHmac('sha256',config.termTestSessionSecret).update('k67-readiness-v1:'+value).digest();
  let audioPromise;
  const audio=()=>audioPromise??=Promise.resolve(audioSource?audioSource():readFile(new URL('./readiness-assets/listening-v1.wav',import.meta.url)))
    .then(bytes=>{
      // Mẫu PCM WAV tự soạn; đọc header để thời lượng hiển thị khớp file thật.
      if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new Error('READINESS_AUDIO_INVALID');
      let offset=12,byteRate,dataBytes;
      while(offset+8<=bytes.length){const id=bytes.toString('ascii',offset,offset+4),n=bytes.readUInt32LE(offset+4);
        if(id==='fmt ')byteRate=bytes.readUInt32LE(offset+16);if(id==='data'){dataBytes=n;break;}offset+=8+n+(n%2);}
      const duration=dataBytes/byteRate;
      if(!Number.isFinite(duration)||duration<1||duration>180)throw new Error('READINESS_AUDIO_DURATION_INVALID');
      return{bytes,duration,hash:digest(bytes)};
    }).catch(error=>{audioPromise=null;throw error;});
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  const fail=(res,status,error,message)=>res.status(status).json({ok:false,error,message});
  const parse=(schema,req,res)=>{const p=schema.strict().safeParse(req.body);if(!p.success){fail(res,400,'READINESS_INVALID','Yêu cầu làm quen không hợp lệ.');return null;}return p.data;};
  const initialLimit=rateLimit({windowMs:60_000,limit:600,standardHeaders:'draft-8',legacyHeaders:false,
    keyGenerator:req=>ipKeyGenerator(req.ip),message:{ok:false,error:'READINESS_BUSY',message:'Có nhiều lượt vào; hãy thử lại sau một chút.'}});
  // Chỉ cache định danh hạn mức, không cache quyền. Token lạ bị giới hạn trước truy vấn DB;
  // phiên đã xác minh vẫn kiểm membership mỗi lần và dùng hạn mức riêng, không khóa cả lớp chung IP.
  const verifiedRateIdentities=new Map();
  function rememberRateIdentity(hash){
    if(verifiedRateIdentities.size>=4096)verifiedRateIdentities.delete(verifiedRateIdentities.keys().next().value);
    verifiedRateIdentities.set(hash,Date.now());
  }
  const sessionLimit=rateLimit({windowMs:60_000,limit:120,standardHeaders:'draft-8',legacyHeaders:false,
    keyGenerator:req=>req.readiness.token_hash,message:{ok:false,error:'READINESS_BUSY',message:'Bạn thao tác quá nhanh; hãy chờ một chút rồi thử lại.'}});
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store, private');next();});
  async function authorize(req,res,next){
    const raw=req.method==='GET'?(req.get('authorization')||'').replace(/^Bearer /,''):req.body?.token;
    const hash=typeof raw==='string'?digest(raw):'';
    if(!verifiedRateIdentities.has(hash)||Date.now()-verifiedRateIdentities.get(hash)>60000){
      let continued=false;await initialLimit(req,res,()=>{continued=true;});if(!continued)return;
    }
    if(!tokenSchema.safeParse(raw).success)return fail(res,401,'READINESS_SESSION_REQUIRED','Hãy xác nhận người học để mở lại bài làm quen.');
    const result=await pool.query(`SELECT r.*,c.erp_class_name_snapshot AS class_code,s.erp_student_name_snapshot AS student_name
      FROM assessment.k67_readiness_session r
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=r.class_id
      JOIN mapping.student_mapping_review s ON s.public_id=r.student_ref AND s.erp_course_class_id=r.class_id
      WHERE r.token_hash=$1 AND r.expires_at>clock_timestamp() AND s.status='approved'`,[hash]);
    if(result.rowCount!==1||!allowed.has(result.rows[0].class_code.toUpperCase()))return fail(res,401,'READINESS_SESSION_EXPIRED','Phiên làm quen không còn hiệu lực. Hãy xác nhận lại người học.');
    req.readiness=result.rows[0];req.readinessToken=raw;
    rememberRateIdentity(hash);
    return sessionLimit(req,res,next);
  }
  const publicRow=r=>({id:r.id,classCode:r.class_code,studentRef:r.student_ref,studentName:r.student_name,
    packVersion:r.pack_version,sameComputer:r.same_computer,sameHeadphones:r.same_headphones,answers:r.answers,
    revision:Number(r.draft_revision),heardSeconds:Number(r.heard_seconds),heardConfirmed:r.heard_confirmed,
    cacheState:r.cache_state,submittedAt:r.submitted_at,expiresAt:r.expires_at,serverNow:new Date().toISOString(),
    practice:Object.fromEntries(['reading','writing'].map(skill=>[skill,{data:r[skill+'_draft'],
      revision:Number(r[skill+'_revision']),submittedAt:r[skill+'_submitted_at']}]))});
  const read=async hash=>(await pool.query(`SELECT r.*,c.erp_class_name_snapshot AS class_code,s.erp_student_name_snapshot AS student_name
    FROM assessment.k67_readiness_session r JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=r.class_id
    JOIN mapping.student_mapping_review s ON s.public_id=r.student_ref AND s.erp_course_class_id=r.class_id WHERE token_hash=$1`,[hash])).rows[0];

  router.get('/roster',initialLimit,requireContext,wrap(async(req,res)=>{
    const p=classCode.safeParse(req.query.class);
    if(!p.success||!allowed.has(p.data))return fail(res,404,'READINESS_CLASS_UNAVAILABLE','Lớp này chưa mở bài làm quen.');
    const rows=(await pool.query(studentSql,[p.data])).rows;
    if(!rows.length)return fail(res,404,'READINESS_ROSTER_UNAVAILABLE','Chưa có danh sách người học hợp lệ. Hãy trao đổi với giảng viên.');
    res.json({ok:true,classCode:p.data,students:rows.map(r=>({ref:r.ref,name:r.name}))});
  }));
  router.post('/sessions',initialLimit,requireContext,wrap(async(req,res)=>{
    const p=parse(z.object({classCode,studentRef:z.string().uuid(),requestId:z.string().uuid(),openingProof:z.string().regex(/^[a-f0-9]{64}$/)}),req,res);if(!p)return;
    if(!allowed.has(p.classCode))return fail(res,404,'READINESS_CLASS_UNAVAILABLE','Lớp này chưa mở bài làm quen.');
    const students=(await pool.query(studentSql,[p.classCode])).rows,student=students.find(s=>s.ref===p.studentRef);
    if(!student)return fail(res,403,'READINESS_STUDENT_INVALID','Không tìm thấy người học hợp lệ trong lớp.');
    const token='k67r1_'+hmac(`${p.requestId}:${p.openingProof}:${student.class_id}:${student.ref}`).toString('base64url');
    await pool.query(`INSERT INTO assessment.k67_readiness_session(id,token_hash,class_id,student_ref,pack_version)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[p.requestId,digest(token),student.class_id,student.ref,packVersion]);
    const row=await read(digest(token));
    if(!row||new Date(row.expires_at).getTime()<=Date.now())return fail(res,409,'READINESS_OPEN_CONFLICT','Lượt mở này đã hết hiệu lực; hãy mở lượt làm quen mới.');
    rememberRateIdentity(row.token_hash);
    res.status(201).json({ok:true,token,session:publicRow(row)});
  }));
  router.post('/session',wrap(authorize),wrap(async(req,res)=>{
    if(!parse(base,req,res))return;res.json({ok:true,session:publicRow(req.readiness)});
  }));
  router.post('/device',wrap(authorize),wrap(async(req,res)=>{
    const p=parse(base.extend({sameComputer:z.boolean(),sameHeadphones:z.boolean()}),req,res);if(!p)return;
    await pool.query(`UPDATE assessment.k67_readiness_session SET same_computer=$2,same_headphones=$3
      WHERE token_hash=$1 AND submitted_at IS NULL`,[req.readiness.token_hash,p.sameComputer,p.sameHeadphones]);
    res.json({ok:true,session:publicRow(await read(req.readiness.token_hash))});
  }));
  router.post('/audio-access',wrap(authorize),wrap(async(req,res)=>{
    if(!parse(base,req,res))return;const sample=await audio();
    const key=hmac(`audio:${req.readinessToken}:${sample.hash}`);
    res.json({ok:true,mime:'audio/wav',duration:sample.duration,audioKey:key.toString('base64'),
      manifest:{assetVersion:'sha256-'+sample.hash,sha256:sample.hash,byteLength:sample.bytes.length,
        encryptedByteLength:sample.bytes.length+33,envelopeVersion:'IZTT1'},
      serverNow:new Date().toISOString(),expiresAt:req.readiness.expires_at});
  }));
  router.get('/audio',wrap(authorize),wrap(async(req,res)=>{
    const sample=await audio(),key=hmac(`audio:${req.readinessToken}:${sample.hash}`),iv=hmac(`iv:${req.readinessToken}:${sample.hash}`).subarray(0,12);
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    res.type('application/octet-stream').send(Buffer.concat([Buffer.from('IZTT1'),iv,cipher.update(sample.bytes),cipher.final(),cipher.getAuthTag()]));
  }));
  router.post('/draft',wrap(authorize),wrap(async(req,res)=>{
    const p=parse(base.extend({revision:z.number().int().min(1).max(1e9),answers,
      heardSeconds:z.number().min(0).max(600),cacheState:z.enum(['not_checked','saved','unavailable'])}),req,res);if(!p)return;
    const sample=await audio();
    const current=req.readiness;
    if(current.submitted_at)return fail(res,409,'READINESS_ALREADY_SUBMITTED','Bài thử đã nộp; hãy xem lại kết quả.');
    if(Number(current.draft_revision)===p.revision&&JSON.stringify(current.answers)!==JSON.stringify(p.answers))
      return fail(res,409,'READINESS_DRAFT_CONFLICT','Bản nháp đã đổi ở nơi khác. Tải lại trước khi tiếp tục.');
    await pool.query(`UPDATE assessment.k67_readiness_session SET answers=$2,draft_revision=$3,
      heard_seconds=greatest(heard_seconds,$4),cache_state=$5
      WHERE token_hash=$1 AND submitted_at IS NULL AND draft_revision<$3`,
      [current.token_hash,JSON.stringify(p.answers),p.revision,Math.min(p.heardSeconds,sample.duration),p.cacheState]);
    const final=await read(current.token_hash);
    if(Number(final.draft_revision)===p.revision&&JSON.stringify(final.answers)!==JSON.stringify(p.answers))
      return fail(res,409,'READINESS_DRAFT_CONFLICT','Bản nháp đã đổi ở nơi khác. Tải lại trước khi tiếp tục.');
    res.json({ok:true,session:publicRow(final)});
  }));
  router.post('/submit',wrap(authorize),wrap(async(req,res)=>{
    const p=parse(base.extend({revision:z.number().int().min(1),heardConfirmed:z.boolean()}),req,res);if(!p)return;
    const r=req.readiness;
    if(r.submitted_at)return res.json({ok:true,session:publicRow(r)});
    const sample=await audio();
    if(r.same_computer===null||r.same_headphones===null||(p.heardConfirmed&&Number(r.heard_seconds)<sample.duration-0.5))
      return fail(res,409,'READINESS_INCOMPLETE','Hãy xác nhận thiết bị và nghe hết đoạn thử trước khi nộp.');
    const saved=await pool.query(`UPDATE assessment.k67_readiness_session SET heard_confirmed=$2,submitted_at=clock_timestamp()
      WHERE token_hash=$1 AND submitted_at IS NULL AND draft_revision=$3 RETURNING id`,[r.token_hash,p.heardConfirmed,p.revision]);
    const final=await read(r.token_hash);
    if(!saved.rowCount&&!final.submitted_at)return fail(res,409,'READINESS_DRAFT_CHANGED','Bản nháp chưa khớp. Hãy tải lại để xem bản mới nhất.');
    res.json({ok:true,session:publicRow(final)});
  }));
  // Tên cột chỉ lấy từ danh sách cố định. Hai kỹ năng có revision độc lập;
  // cùng revision khác dữ liệu bị từ chối, nộp yêu cầu đúng bản đã đọc lại.
  const practiceSkill=(req,res)=>{
    const skill=req.params.skill;
    if(!['reading','writing'].includes(skill)){fail(res,404,'READINESS_SKILL_INVALID','Phần làm quen không hợp lệ.');return null;}
    if(!req.readiness.submitted_at){fail(res,409,'READINESS_LISTENING_REQUIRED','Hãy hoàn thành kiểm âm thanh trước.');return null;}
    return skill;
  };
  const sameData=(a,b)=>JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());
  router.post('/practice/:skill/draft',wrap(authorize),wrap(async(req,res)=>{
    const skill=practiceSkill(req,res);if(!skill)return;
    const data=skill==='reading'?z.object({1:z.string().max(120).optional(),2:z.string().max(120).optional(),3:z.string().max(120).optional()}).strict():z.object({text:z.string().max(12000)}).strict();
    const p=parse(base.extend({revision:z.number().int().min(1).max(1e9),data}),req,res);if(!p)return;
    const r=req.readiness;
    if(r[skill+'_submitted_at'])return fail(res,409,'READINESS_ALREADY_SUBMITTED','Phần này đã nộp; hãy xem lại kết quả.');
    await pool.query(`UPDATE assessment.k67_readiness_session SET ${skill}_draft=$2,${skill}_revision=$3
      WHERE token_hash=$1 AND ${skill}_submitted_at IS NULL AND ${skill}_revision<$3`,[r.token_hash,JSON.stringify(p.data),p.revision]);
    const final=await read(r.token_hash);
    if(Number(final[skill+'_revision'])===p.revision&&!sameData(final[skill+'_draft'],p.data))
      return fail(res,409,'READINESS_DRAFT_CONFLICT','Bản nháp đã đổi ở nơi khác. Tải lại trước khi tiếp tục.');
    res.json({ok:true,session:publicRow(final)});
  }));
  router.post('/practice/:skill/submit',wrap(authorize),wrap(async(req,res)=>{
    const skill=practiceSkill(req,res);if(!skill)return;
    const p=parse(base.extend({revision:z.number().int().min(1).max(1e9)}),req,res);if(!p)return;
    const r=req.readiness;
    await pool.query(`UPDATE assessment.k67_readiness_session SET ${skill}_submitted_at=clock_timestamp()
      WHERE token_hash=$1 AND ${skill}_submitted_at IS NULL AND ${skill}_revision=$2`,[r.token_hash,p.revision]);
    const final=await read(r.token_hash);
    if(!final[skill+'_submitted_at'])return fail(res,409,'READINESS_DRAFT_CHANGED','Bản nháp chưa khớp. Hãy tải lại để xem bản mới nhất.');
    res.json({ok:true,session:publicRow(final)});
  }));
  router.use((_req,res)=>fail(res,404,'READINESS_ROUTE_NOT_FOUND','Đường làm quen không hợp lệ.'));
  router.use((error,_req,res,_next)=>{
    // Không đưa stack, query, token hoặc nội dung asset vào thông báo lỗi.
    res.status(503).json({ok:false,error:'READINESS_UNAVAILABLE',message:'Chưa xử lý được bài làm quen. Giữ nguyên trang và thử lại khi có mạng.'});
  });
  app.use(root,router);
}
