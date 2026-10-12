import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {ReadingError,hash,secret,uuid} from './domain.js';

// API của Reading: kiểm đầu vào và quyền trước khi gọi dịch vụ. Lỗi chỉ trả mã và thông điệp an toàn.
export function createApp({service,pool,origins,googleClientId,verifyGoogle,adminKey,staticRoot}){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
 app.use(helmet({contentSecurityPolicy:false,referrerPolicy:{policy:'no-referrer'}}));
 app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin&&!origins.includes(origin))return res.status(403).json({error:{code:'ORIGIN_DENIED',message:'Trang gọi API không được phép.'}});
  if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');res.set('Access-Control-Allow-Credentials','true');}
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization, X-Reading-Admin');res.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS')return res.sendStatus(204);next();
 });
 app.use(express.json({limit:'512kb'}));
 app.use('/api',rateLimit({windowMs:60000,limit:3000,standardHeaders:'draft-8',legacyHeaders:false}));
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const token=req=>/^Bearer ([\w-]{43})$/.exec(req.headers.authorization||'')?.[1];
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
 app.get('/api/health',wrap(async(req,res)=>{await pool.query('SELECT 1');res.json({product:'PRODUCT-READING-PRACTICE-K67',ready:true});}));
 app.get('/api/config',(req,res)=>res.json({googleClientId}));
 for(const action of Object.keys(schemas))app.post(`/api/${action}`,wrap(async(req,res)=>{
  const input=schemas[action].parse(req.body);res.set('Cache-Control','no-store');
  res.json(await service[action]({...input,token:token(req)}));
 }));
 app.get('/api/state',wrap(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await service.read({token:token(req)}));}));
 app.get('/api/result/:attemptId',wrap(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await service.result({token:token(req),attemptId:z.uuid().parse(req.params.attemptId)}));}));
 app.post('/api/teacher/login',wrap(async(req,res)=>{
  const {credential}=z.object({credential:z.string().min(10).max(10000)}).strict().parse(req.body);
  const identity=await verifyGoogle(credential);
  if(!identity?.email_verified||!identity.email||!identity.sub)throw new ReadingError('GOOGLE_IDENTITY_INVALID','Google chưa xác minh tài khoản.',401);
  const value=secret();await pool.query('INSERT INTO reading_practice.teacher_session(token_hash,email,google_subject,expires_at) VALUES($1,$2,$3,$4)',[hash(value),identity.email.toLowerCase(),identity.sub,new Date(Date.now()+3600000).toISOString()]);
  const secure=req.secure||req.headers['x-forwarded-proto']==='https';
  res.cookie('reading_teacher',value,{httpOnly:true,secure,sameSite:secure?'none':'strict',path:'/api',maxAge:3600000});res.json({email:identity.email,token:value});
 }));
 app.get('/api/teacher/result/:submissionId',wrap(async(req,res)=>{
  const cookie=token(req)||/(?:^|;\s*)reading_teacher=([\w-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
  const identity=cookie&&(await pool.query('SELECT email,google_subject FROM reading_practice.teacher_session WHERE token_hash=$1 AND expires_at>now()',[hash(cookie)])).rows[0];
  if(!identity)throw new ReadingError('TEACHER_LOGIN_REQUIRED','Giảng viên cần đăng nhập Google.',401);
  res.set('Cache-Control','no-store');res.json(await service.teacherResult({submissionId:z.uuid().parse(req.params.submissionId),email:identity.email,subject:identity.google_subject}));
 }));
 app.use('/api/admin',(req,res,next)=>{
  const value=req.headers['x-reading-admin'];
  if(typeof value!=='string'||Buffer.byteLength(value)!==Buffer.byteLength(adminKey)||!timingSafeEqual(Buffer.from(value),Buffer.from(adminKey)))return next(new ReadingError('ACCESS_DENIED','Không có quyền vận hành Reading.',403));
  res.set('Cache-Control','no-store');next();
 });
 app.get('/api/admin/status',wrap(async(req,res)=>res.json(await service.operationsStatus())));
 app.post('/api/admin/assignment',wrap(async(req,res)=>res.json(await service.configureAssignment(z.object({assignmentId:z.uuid(),status:z.enum(['open','closed'])}).strict().parse(req.body)))));
 app.post('/api/admin/retry-docs',wrap(async(req,res)=>res.json(await service.retryDocJob(z.object({jobId:z.uuid()}).strict().parse(req.body)))));
 app.post('/api/admin/register',wrap(async(req,res)=>{
  const input=z.object({classId:z.string().min(1).max(30),classCode:z.string().min(1).max(80),studentRef:z.uuid(),documentId:z.string().regex(/^[\w-]{20,150}$/),tabId:z.string().regex(/^[\w.-]{1,100}$/),contentVersion:z.string().min(1).max(80),entryToken:z.string().regex(/^[\w-]{43}$/),courseId:z.string().min(1),courseWorkId:z.string().min(1),submissionId:z.string().min(1)}).strict().parse(req.body);
  res.json(await service.register(input));
 }));
 if(staticRoot)app.use(express.static(staticRoot,{index:'index.html',dotfiles:'deny'}));
 app.use((error,req,res,next)=>{
  const requestId=uuid(),known=error instanceof ReadingError;
  const invalid=error instanceof z.ZodError||error.type==='entity.parse.failed';
  if(!known&&!invalid)console.error(JSON.stringify({event:'reading_request_error',requestId,type:error.name}));
  res.status(known?error.status:invalid?400:500).json({error:{code:known?error.code:invalid?'INVALID_INPUT':'INTERNAL_ERROR',message:known?error.message:invalid?'Dữ liệu gửi lên chưa hợp lệ.':'Chưa xử lý được thao tác. Hãy thử lại.',requestId}});
 });
 return app;
}
