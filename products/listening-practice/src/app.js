import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {CODE,ListeningError,uuid} from './domain.js';
import {createTeacherSessions} from './teacher-session.js';
import {mountTeacherProgress} from './teacher-progress.js';
import {matchingReview} from './review.js';
import {lessonFor} from './lessons.js';
import {sendPublicAudioMetadata} from './public-audio.js';

// API của Reading: kiểm đầu vào và quyền trước khi gọi dịch vụ. Lỗi chỉ trả mã và thông điệp an toàn.
export function createApp({service,pool,origins,googleClientId,verifyGoogle,adminKey,registerCta,staticRoot,audioFile,audioHash,review=null,mediaCatalog={},teacherCookiePath='/listening-practice-api/api'}){
 const teacherSessions=createTeacherSessions({pool,cookiePath:teacherCookiePath});
 const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
 app.use(helmet({contentSecurityPolicy:false,referrerPolicy:{policy:'no-referrer'}}));
 app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin&&!origins.includes(origin))return res.status(403).json({error:{code:'ORIGIN_DENIED',message:'Trang gọi API không được phép.'}});
  if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');res.set('Access-Control-Allow-Credentials','true');}
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization, X-Izone-Document, X-Izone-Assignment, X-Listening-Admin, X-Izone-Csrf');res.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS')return res.sendStatus(204);next();
 });
 app.use(express.json({limit:'512kb'}));
 app.use('/api',rateLimit({windowMs:60000,limit:3000,standardHeaders:'draft-8',legacyHeaders:false}));
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const token=req=>/^Bearer ([\w-]{43})$/.exec(req.headers.authorization||'')?.[1];
 // Chỉ ghép transcript sau khi dịch vụ gốc đã xác nhận đúng người và bài đã nộp.
 const mediaFor=hash=>mediaCatalog[hash]||(hash===audioHash?{audioFile,review}:null);
 const withReview=(result,path)=>{const review=mediaFor(result.definition?.audio?.sha256)?.review;return matchingReview(review,result)?{...result,review,reviewAudioUrl:path}:result;};
 const sendReviewAudio=(result,res,req)=>{
  const media=mediaFor(result.definition?.audio?.sha256),review=media?.review,audioFile=media?.audioFile;
  if(!matchingReview(review,result)||!audioFile)throw new ListeningError('REVIEW_UNAVAILABLE','Audio xem lại chưa sẵn sàng.',503);
  if(sendPublicAudioMetadata(req,res,result.definition?.audio?.sha256))return;
  res.set('Cache-Control','private, no-store');res.sendFile(audioFile);
 };
 const entry=z.object({entryToken:z.string().regex(/^[\w-]{43}$/)}).strict();
 const session=z.object({attemptId:z.uuid()});
 const lease=z.object({id:z.uuid(),token:z.string().regex(/^[\w-]{43}$/),owner:z.string().min(1).max(100)}).strict();
 const operation=z.object({operationId:z.uuid(),owner:z.string().min(1).max(100)});
 const schemas={
  open:entry,login:entry.extend({studentRef:z.uuid(),classCode:z.string().min(1).max(80)}),
  begin:operation.strict(),resume:operation.extend({attemptId:z.uuid(),recovery:z.object({snapshot:z.unknown(),lease}).strict().optional()}).strict(),
  activate:session.extend({lease}).strict(),pulse:session.extend({snapshot:z.unknown(),lease}).strict(),pause:session.extend({snapshot:z.unknown(),lease}).strict(),
  reset:operation.extend({attemptId:z.uuid(),lease:lease.optional(),snapshot:z.unknown().optional()}).strict(),
  submit:z.object({operationId:z.uuid(),attemptId:z.uuid(),lease,snapshot:z.unknown(),method:z.enum(['manual','timeout'])}).strict()
 };
 app.get('/api/health',wrap(async(req,res)=>{await pool.query('SELECT 1');res.json({product:'PRODUCT-LISTENING-PRACTICE-K67',ready:true});}));
 app.get('/api/audio/:attemptId',wrap(async(req,res)=>{
  const access=await service.audioAccess({token:token(req),attemptId:z.uuid().parse(req.params.attemptId)});
  const file=mediaFor(access.sha256)?.audioFile;
  if(!file)throw new ListeningError('AUDIO_UNAVAILABLE','Audio chưa sẵn sàng.',503);
  if(sendPublicAudioMetadata(req,res,access.sha256))return;
  res.set('Cache-Control','private, no-store');res.sendFile(file);
 }));
 app.get('/api/config',(req,res)=>res.json({googleClientId}));
 app.get('/api/library/:lessonId',wrap(async(req,res)=>{
  res.set('Cache-Control','no-store');res.json(await service.lessonCatalog({code:lessonFor(req.params.lessonId).code}));
 }));
 app.get('/api/library/:lessonId/classes/:classId',wrap(async(req,res)=>{
  res.set('Cache-Control','no-store');res.json(await service.lessonRoster({code:lessonFor(req.params.lessonId).code,classId:z.string().regex(/^-?\d{1,19}$/).parse(req.params.classId)}));
 }));
 app.post('/api/shared-login',wrap(async(req,res)=>{
  const input=z.object({code:z.string().min(1).max(100),classId:z.string().regex(/^-?\d{1,19}$/),studentRef:z.uuid()}).strict().parse(req.body);
  res.set('Cache-Control','no-store');res.json(await service.sharedLogin({...input,code:lessonFor(input.code).code,...(req.headers['x-izone-document']?{documentId:z.string().regex(/^[\w-]{20,150}$/).parse(req.headers['x-izone-document'])}:{})}));
 }));
 const documentContext=req=>({documentId:z.string().regex(/^[\w-]{20,150}$/).parse(req.headers['x-izone-document']),code:z.string().min(1).max(100).parse(req.headers['x-izone-assignment'])});
 app.get('/api/entry-context',wrap(async(req,res)=>{
  const input=z.object({documentId:z.string().regex(/^[\w-]{20,150}$/),code:z.string().min(1).max(100)}).strict().parse(req.query);
  res.set('Cache-Control','no-store');res.json(await service.entryContext({...input,code:input.code===CODE?CODE:lessonFor(input.code).code}));
 }));
 app.use('/api',(req,res,next)=>{
  if(!req.headers['x-izone-document']||!/^\/(?:open|login|state|result(?:\/|$)|begin|resume|activate|pulse|pause|reset|submit|audio(?:\/|$))/.test(req.path))return next();
  Promise.resolve().then(()=>service.guardEntry({...documentContext(req),token:token(req),entryToken:req.body?.entryToken})).then(()=>next(),next);
 });
 for(const action of Object.keys(schemas))app.post(`/api/${action}`,wrap(async(req,res)=>{
  const input=schemas[action].parse(req.body);res.set('Cache-Control','no-store');
  res.json(await service[action]({...input,token:token(req)}));
 }));
 app.get('/api/state',wrap(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await service.read({token:token(req)}));}));
 app.get('/api/result/:attemptId',wrap(async(req,res)=>{
  const id=z.uuid().parse(req.params.attemptId),result=await service.result({token:token(req),attemptId:id});
  res.set('Cache-Control','no-store');res.json(withReview(result,`review-audio/${id}`));
 }));
 app.get('/api/review-audio/:attemptId',wrap(async(req,res)=>{
  const result=await service.result({token:token(req),attemptId:z.uuid().parse(req.params.attemptId)});
  sendReviewAudio(result,res,req);
 }));
 app.use('/api/teacher',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
 mountTeacherProgress(app,{service:service.teacherProgress,teacherSessions,z,wrap});
 app.post('/api/teacher/login',wrap(async(req,res)=>{
  const {credential,remember}=z.object({credential:z.string().min(10).max(10000),remember:z.boolean().default(true)}).strict().parse(req.body);
  let identity;
  try{identity=await verifyGoogle(credential);}catch(error){
   // Thư viện Google có thể chứa token trong lỗi: chỉ nhận diện lỗi xác minh, không trả nội dung gốc.
   // Lỗi lấy chứng chỉ/kết nối vẫn đi qua xử lý lỗi hệ thống, không bị gọi nhầm là tài khoản sai.
   const invalidToken=/^(Wrong recipient,|Wrong number of segments in token:|Can't parse token (?:envelope|payload):|No pem found for envelope:|Invalid token signature:|No (?:issue|expiration) time in token:|(?:iat|exp) field using invalid format|Expiration time too far in future:|Token used too (?:early|late),|Invalid issuer,)/.test(error?.message||'');
   if(!invalidToken)throw error;
   throw new ListeningError('GOOGLE_IDENTITY_INVALID','Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.',401);
  }
  if(!identity?.email_verified||!identity.email||!identity.sub)throw new ListeningError('GOOGLE_IDENTITY_INVALID','Google chưa xác minh tài khoản.',401);
  res.json(await teacherSessions.create(req,res,identity,remember));
 }));
 app.post('/api/teacher/logout',wrap(async(req,res)=>{
  if(!origins.includes(req.headers.origin)||req.headers['x-izone-csrf']!=='1')throw new ListeningError('CSRF_REJECTED','Yêu cầu đăng xuất không hợp lệ.',403);
  await teacherSessions.logout(req,res);res.json({ok:true});
 }));
 app.get('/api/teacher/result/:submissionId',wrap(async(req,res)=>{
  const identity=await teacherSessions.read(req);
  const id=z.uuid().parse(req.params.submissionId),result=await service.teacherResult({submissionId:id,email:identity.email,subject:identity.google_subject});
  await teacherSessions.refresh(req,res,identity);res.json(withReview(result,`teacher/review-audio/${id}`));
 }));
 app.get('/api/teacher/review-audio/:submissionId',wrap(async(req,res)=>{
  const identity=await teacherSessions.read(req);
  const result=await service.teacherResult({submissionId:z.uuid().parse(req.params.submissionId),email:identity.email,subject:identity.google_subject});
  await teacherSessions.refresh(req,res,identity);sendReviewAudio(result,res,req);
 }));
 app.use('/api/admin',(req,res,next)=>{
  const value=req.headers['x-listening-admin'];
  if(typeof value!=='string'||Buffer.byteLength(value)!==Buffer.byteLength(adminKey)||!timingSafeEqual(Buffer.from(value),Buffer.from(adminKey)))return next(new ListeningError('ACCESS_DENIED','Không có quyền vận hành Reading.',403));
  res.set('Cache-Control','no-store');next();
 });
 app.get('/api/admin/status',wrap(async(req,res)=>res.json(await service.operationsStatus())));
 app.post('/api/admin/register-cta',wrap(async(req,res)=>{
  if(!registerCta)throw new ListeningError('CTA_UNAVAILABLE','Chưa cấu hình đăng ký CTA.',503);
  const input=z.object({schema_version:z.enum(['course67_cta_registration_v1','course67_cta_registration_v2']),course:z.literal(67),
   doc_id:z.string().regex(/^[\w-]{20,150}$/),submission_id:z.string().min(1).max(200),
   classroom_course_id:z.string().regex(/^\d{1,30}$/),coursework_id:z.string().regex(/^\d{1,30}$/),student_id:z.string().regex(/^\d{1,30}$/),class_name:z.string().min(1).max(80)}).parse(req.body);
  res.json(await registerCta(input));
 }));
 app.post('/api/admin/shared-lesson',wrap(async(req,res)=>res.json(await service.configureSharedLesson(z.object({code:z.string().min(1).max(100),contentVersion:z.string().min(1).max(80),status:z.enum(['open','closed'])}).strict().parse(req.body)))));
 app.post('/api/admin/assignment',wrap(async(req,res)=>res.json(await service.configureAssignment(z.object({assignmentId:z.uuid(),status:z.enum(['open','closed'])}).strict().parse(req.body)))));
 app.post('/api/admin/retry-docs',wrap(async(req,res)=>res.json(await service.retryDocJob(z.object({jobId:z.uuid()}).strict().parse(req.body)))));
 app.post('/api/admin/register',wrap(async(req,res)=>{
  const input=z.object({code:z.string().min(1).max(100).optional(),classId:z.string().min(1).max(30),classCode:z.string().min(1).max(80),studentRef:z.uuid(),documentId:z.string().regex(/^[\w-]{20,150}$/),tabId:z.string().regex(/^[\w.-]{1,100}$/),contentVersion:z.string().min(1).max(80),entryToken:z.string().regex(/^[\w-]{43}$/),courseId:z.string().min(1),courseWorkId:z.string().min(1),submissionId:z.string().min(1)}).strict().parse(req.body);
  res.json(await service.register(input));
 }));
 if(staticRoot)app.use(express.static(staticRoot,{index:'index.html',dotfiles:'deny'}));
 app.use((error,req,res,next)=>{
  const requestId=uuid(),known=error instanceof ListeningError;
  const invalid=error instanceof z.ZodError||error.type==='entity.parse.failed';
  if(!known&&!invalid)console.error(JSON.stringify({event:'reading_request_error',requestId,type:error.name}));
  res.status(known?error.status:invalid?400:500).json({error:{code:known?error.code:invalid?'INVALID_INPUT':'INTERNAL_ERROR',message:known?error.message:invalid?'Dữ liệu gửi lên chưa hợp lệ.':'Chưa xử lý được thao tác. Hãy thử lại.',requestId}});
 });
 return app;
}
