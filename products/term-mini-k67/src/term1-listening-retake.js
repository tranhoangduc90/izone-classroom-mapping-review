import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {audioTransaction} from './audio-incidents.js';
import {term1JourneyR2Audio} from './mini-r2-audio.js';
import {publicAudioCatalog} from './public-audio-catalog.js';
import {buildListeningResult,gradeSection,parseStoredTest} from './term-tests.js';

const slug='term-test-1';
const prefix=`/api/term-tests/${slug}/listening-retake`;
const version='term1-k67-listening-retake-v1';
const recoveryMs=72*60*60_000;
const time=value=>new Date(value).getTime();
const digest=value=>createHash('sha256').update(value).digest('hex');
const classCode=z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/);
const ticket=z.object({v:z.literal(1),purpose:z.literal('listening-retake'),testSlug:z.literal(slug),classCode,
  studentRef:z.uuid(),sessionToken:z.uuid(),expiresAt:z.number().int().positive()}).strict();
const identity=z.object({classCode,studentRef:z.uuid(),retakeGrant:z.string()});
const device=z.string().regex(/^[a-f0-9]{64}$/);
const scope=z.object({examSessionToken:z.uuid(),generation:z.number().int().nonnegative(),deviceProof:device});
const ts=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const statusInput=scope.extend({section:z.literal('listening'),operationId:z.uuid()});
const sealInput=scope.extend({operationId:z.uuid(),section:z.literal('listening'),previousOperationId:z.null(),startedAt:ts,capturedAt:ts,revision:ts,automatic:z.boolean(),
  eofAt:ts.nullable(),heardSeconds:z.number().min(0).max(7200),answers:z.record(z.string().regex(/^([1-9]|[1-3]\d|40)$/),z.string().max(120))});
const problem=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const mac=(secret,body)=>createHmac('sha256',secret).update(`izone-listening-retake-v1:${body}`);

export function issueTerm1RetakeGrant(owner, secret, {sessionToken=randomUUID(), validHours=24,
  now=Math.floor(Date.now()/1000)}={}) {
  if(typeof secret!=='string'||secret.length<32||!Number.isInteger(validHours)||validHours<1||validHours>72) {
    throw new Error('Cấu hình vé thi bù hoặc thời hạn không hợp lệ.');
  }
  const grant=ticket.parse({v:1,purpose:'listening-retake',testSlug:slug,classCode:owner.classCode,
    studentRef:owner.studentRef,sessionToken,expiresAt:now+validHours*3600});
  const body=Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${body}.${mac(secret,body).digest('base64url')}`;
}

export function verifyTerm1RetakeGrant(value,owner,secret,now=Math.floor(Date.now()/1000)) {
  if(typeof secret!=='string'||secret.length<32||typeof value!=='string')return null;
  const parts=/^([A-Za-z0-9_-]{40,1800})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if(!parts)return null;
  const signature=Buffer.from(parts[2],'base64url');
  const expected=mac(secret,parts[1]).digest();
  if(signature.length!==expected.length||signature.toString('base64url')!==parts[2]||!timingSafeEqual(signature,expected))return null;
  try{
    const grant=ticket.parse(JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')));
    return grant.classCode===owner.classCode&&grant.studentRef===owner.studentRef&&grant.expiresAt>now
      &&grant.expiresAt<=now+31*86_400?grant:null;
  }catch{return null;}
}

function permit(secret,row) {
  return createHmac('sha256',secret).update([version,row.id,row.class_id,row.student_id,row.student_ref,row.definition_version,
    row.generation,row.device_hash,row.audio_hash,row.listening_duration_ms].join(':')).digest('hex');
}

export function mountTerm1ListeningRetake(app,{pool,config,assets,readStudent,requireContext,readLimiter,writeLimiter}) {
  const mode=config.term1ListeningRetakeMode;
  const secret=config.termTestSessionSecret;
  const verifySecret=config.term1ListeningRetakeSecret||secret;
  const route=fn=>async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    try{res.json(await fn(req));}
    catch(error){
      if(!error.status)return next(error);
      res.status(error.status).json({ok:false,error:error.code,message:error.message});
    }
  };
  const parse=(schema,body)=>{
    const value=schema.safeParse(body);
    if(!value.success)throw problem('RETAKE_INVALID','Yêu cầu thi bù chưa hợp lệ.',400);
    return value.data;
  };
  const prepare=route(async req=>{
    const parsed=identity.safeParse(req.body);
    const grant=parsed.success&&verifyTerm1RetakeGrant(parsed.data.retakeGrant,parsed.data,verifySecret);
    if((req.params.testSlug&&req.params.testSlug!==slug)||!grant) {
      throw problem('INVALID_RETAKE_GRANT','Liên kết thi bù không hợp lệ hoặc đã hết hạn.',403);
    }
    if(!['on','drain'].includes(mode)||typeof secret!=='string'||secret.length<32||!assets) {
      throw problem('RETAKE_UNAVAILABLE','Chưa thể mở lượt thi bù. Hãy giữ liên kết và thử lại.',503);
    }
    const proof=device.safeParse(req.body.deviceProof);
    if(!proof.success)throw problem('RETAKE_CLIENT_UPDATE_REQUIRED','Hãy tải lại đúng trang thi bù để cập nhật.',409);
    const {classCode,studentRef}=parsed.data;
    const student=(await readStudent(req,classCode,slug,studentRef)).rows[0];
    if(!student)throw problem('RETAKE_SCOPE','Không tìm thấy đúng học viên và lớp của vé thi bù.',403);
    const manifest=assets.getJourneyManifest?.(slug)||publicAudioCatalog[slug];
    const audioTiming=assets.getTiming(slug);
    const duration=audioTiming.listeningDurationSeconds;
    const review=audioTiming.listeningReviewSeconds??(audioTiming.listeningTotalSeconds-duration);
    if(!manifest?.sha256||!Number.isFinite(duration)||duration<=0||review!==120) {
      throw problem('RETAKE_UNAVAILABLE','Chưa có cấu hình âm thanh và giờ rà của lượt thi bù.',503);
    }
    const content=await assets.getContent(slug);
    return audioTransaction(pool,async db=>{
      if(mode==='on')await db.query(`INSERT INTO assessment.term_k67_listening_retake
        (id,definition_version,class_id,class_code,student_id,student_ref,student_name,device_hash,audio_hash,listening_duration_ms,ticket_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [grant.sessionToken,student.definition_version,student.class_id,classCode,student.student_id,studentRef,
          student.student_name,digest(proof.data),manifest.sha256,Math.round(duration*1000),new Date(grant.expiresAt*1000).toISOString()]);
      const row=(await db.query(`SELECT *,clock_timestamp() AS server_now FROM assessment.term_k67_listening_retake
        WHERE id=$1 FOR UPDATE`,[grant.sessionToken])).rows[0];
      if(!row)throw problem('RETAKE_NEW_DISABLED','Tạm dừng mở lượt thi bù mới.',503);
      if(row.class_code!==classCode||String(row.class_id)!==String(student.class_id)||row.student_ref!==studentRef
          ||String(row.student_id)!==String(student.student_id)||row.definition_version!==student.definition_version
          ||row.device_hash!==digest(proof.data)||row.audio_hash!==manifest.sha256) {
        throw problem('RETAKE_SCOPE','Lượt thi bù không khớp người, thiết bị hoặc phiên bản đề.',403);
      }
      return {ok:true,version,examSessionToken:row.id,attemptToken:row.id,generation:Number(row.generation),
        studentRef,studentName:row.student_name,className:row.class_code,examMode:'lis_first',
        activatedAt:row.started_at?time(row.started_at):null,serverNow:time(row.server_now),permit:permit(secret,row),
        listeningSubmitted:Boolean(row.receipt),content:{title:content.title,listening:content.listening},
        timing:{listeningDurationSeconds:row.listening_duration_ms/1000,listeningReviewSeconds:review},audioManifest:manifest,
        ...term1JourneyR2Audio({config,row:{attempt_mode:'cbt',listening_started_at:row.started_at},manifest})};
    });
  });

  // Intercept the legacy entry before order/open sees it. A malformed ticket must never prepare a regular exam.
  app.post(['/api/term-tests/:testSlug/session/prepare','/api/term-tests/:testSlug/order/open'],
    (req,res,next)=>Object.hasOwn(req.body||{},'retakeGrant')?writeLimiter(req,res,next):next('route'),requireContext,prepare);
  app.post(prefix+'/prepare',writeLimiter,requireContext,prepare);
  if(!['on','drain'].includes(mode))return;

  async function authorized(db,req,input,forUpdate=false){
    const row=(await db.query(`SELECT *,clock_timestamp() AS server_now FROM assessment.term_k67_listening_retake
      WHERE id=$1${forUpdate?' FOR UPDATE':''}`,[input.examSessionToken])).rows[0];
    const proof=req.get('x-term2-permit');
    if(typeof secret!=='string'||secret.length<32||!row||Number(row.generation)!==input.generation
        ||row.device_hash!==digest(input.deviceProof)||!(/^[a-f0-9]{64}$/.test(proof||''))
        ||!timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(permit(secret,row),'hex'))) {
      throw problem('RETAKE_SCOPE','Quyền không khớp lượt thi bù và thiết bị.',403);
    }
    if(time(row.server_now)>time(row.started_at||row.ticket_expires_at)+recoveryMs) {
      throw problem('RETAKE_REVIEW_REQUIRED','Đã quá hạn đồng bộ. Hãy giữ bài trên máy.');
    }
    return row;
  }

  app.post(prefix+'/begin',writeLimiter,route(req=>audioTransaction(pool,async db=>{
    const input=parse(scope,req.body),row=await authorized(db,req,input,true);
    if(!row.started_at&&time(row.server_now)>=time(row.ticket_expires_at)) {
      throw problem('INVALID_RETAKE_GRANT','Vé thi bù đã hết hạn trước khi bắt đầu.',403);
    }
    const started=row.started_at||(await db.query(`UPDATE assessment.term_k67_listening_retake SET started_at=clock_timestamp()
      WHERE id=$1 RETURNING started_at`,[row.id])).rows[0].started_at;
    return {ok:true,version,examSessionToken:row.id,generation:input.generation,activatedAt:time(started),serverNow:time(row.server_now)};
  })));

  app.post(prefix+'/status',readLimiter,route(async req=>{
    const input=parse(statusInput,req.body),row=await authorized(pool,req,input);
    if(row.receipt&&row.receipt.operationId!==input.operationId)throw problem('RETAKE_CONFLICT','Bài đã nhận mã nộp khác.');
    return {ok:true,persisted:Boolean(row.receipt),receipt:row.receipt};
  }));

  app.post(prefix+'/seal',writeLimiter,route(req=>audioTransaction(pool,async db=>{
    const input=parse(sealInput,req.body),row=await authorized(db,req,input,true);
    const {deviceProof,...operation}=input;
    const payloadHash=digest(JSON.stringify(operation));
    if(row.receipt){
      if(row.receipt.operationId!==input.operationId||row.receipt.payloadHash!==payloadHash) {
        throw problem('RETAKE_CONFLICT','Mã nộp không khớp bản đã nhận. Bài trên máy vẫn được giữ.');
      }
      return {ok:true,receipt:row.receipt};
    }
    const duration=row.listening_duration_ms/1000;
    if(!row.started_at||input.startedAt!==time(row.started_at)||input.capturedAt<input.startedAt||input.capturedAt>time(row.server_now)+3000) {
      throw problem('RETAKE_TIMELINE','Mốc bắt đầu hoặc nộp bài chưa khớp. Bài trên máy vẫn được giữ.');
    }
    const verifiedEnd=input.eofAt!==null&&input.eofAt>=input.startedAt+duration*1000-500&&input.eofAt<=input.capturedAt
      &&input.heardSeconds>=duration-.25&&input.heardSeconds<=duration+1;
    if((input.eofAt!==null&&!verifiedEnd)||(input.automatic&&(!verifiedEnd||input.capturedAt!==input.eofAt+120_000
        ||time(row.server_now)<input.capturedAt))) {
      throw problem('AUDIO_END_NOT_CONFIRMED','Chưa xác nhận đã phát hết audio và đủ 120 giây rà.');
    }
    const definition=(await db.query(`SELECT slug AS test_slug,title AS test_title,version AS definition_version,
      listening_band_adjustment,listening_definition,reading_definition FROM assessment.test_definition WHERE slug=$1 AND version=$2`,
      [slug,row.definition_version])).rows[0];
    if(!definition)throw problem('RETAKE_DEFINITION','Không tìm thấy đúng phiên bản đề.');
    const test=parseStoredTest(definition);
    const allowed=new Set(test.listening_definition.questions.map(question=>String(question.number)));
    if(Object.keys(input.answers).some(key=>!allowed.has(key)))throw problem('RETAKE_INVALID','Có đáp án ngoài phần Listening.',400);
    const grade=buildListeningResult(test,gradeSection(test.listening_definition,input.answers,test.listening_band_adjustment));
    const receipt={version,section:'listening',operationId:input.operationId,payloadHash,examSessionToken:row.id,
      attemptToken:row.id,generation:input.generation,capturedAt:input.capturedAt,completed:true,nextSection:'result'};
    await db.query(`UPDATE assessment.term_k67_listening_retake SET sealed_at=clock_timestamp(),answers=$2::jsonb,result=$3::jsonb,
      receipt=$4::jsonb WHERE id=$1`,[row.id,JSON.stringify(input.answers),JSON.stringify(grade),JSON.stringify(receipt)]);
    return {ok:true,receipt};
  })));

  app.post(prefix+'/result',readLimiter,route(async req=>{
    const row=await authorized(pool,req,parse(scope,req.body));
    if(!row.receipt)throw problem('RETAKE_PENDING','Máy chủ chưa nhận bài Listening.');
    const ack=(await pool.query("SELECT to_regclass('assessment.term_k67_listening_retake_portal_ack') IS NOT NULL AS ready")).rows[0];
    const portalSyncStatus=ack.ready?(await pool.query('SELECT status FROM assessment.term_k67_listening_retake_portal_ack WHERE id=$1',[row.id])).rows[0]?.status:null;
    return {ok:true,attemptToken:row.id,studentName:row.student_name,className:row.class_code,testSlug:slug,
      completed:true,completedAt:row.sealed_at,result:row.result,portalSyncStatus:portalSyncStatus||'pending'};
  }));
}
