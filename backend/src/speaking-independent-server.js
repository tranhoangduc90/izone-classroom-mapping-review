import express from 'express';
import helmet from 'helmet';
import pg from 'pg';
import { rateLimit,ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { createIndependentSpeaking } from './speaking-independent.js';
import { SpeakingHomeworkError } from './speaking-homework.js';
import { runSpeakingCheckJob } from './speaking-check-worker.js';
import { runPracticeCheckJob,runPracticeAnalysisJob } from './speaking-practice-worker.js';
import { runSpeakingDoctorJob } from './speaking-doctor-worker.js';
import { timingSafeEqual,createHash } from 'node:crypto';
import { createIndependentDocuments,createDocsGateway,writeIndependentDocument } from './speaking-independent-documents.js';
import { createOpeningDocsGateway } from './speaking-docs-read.js';
import { startSpeakingProgressDocsWorker } from './speaking-progress-docs.js';
import { createSpeakingProgressGoogle } from './speaking-progress-google.js';
import { createSpeakingTeacherProgress,mountSpeakingTeacherProgress } from './speaking-teacher-progress.js';
import {createDurableWorkLoop} from './test-work-runtime.js';
import {startSpeakingWorkCoordinator} from './speaking-work-runtime.js';
import {speakingSourceScopes,expandSpeakingSourceBatch} from './speaking-source-batch.js';
import {teacherObservationActors,expandTeacherObservation} from './teacher-observation-contract.js';
import {createSpeakingObservation} from './speaking-observation.js';
import {createSpeakingObservationData} from './speaking-observation-data.js';
import {mountSpeakingObservationRoutes} from './speaking-observation-routes.js';
const speakingWebOrigin='https://tranhoangduc90.github.io';

// Đầu vào: cấu hình riêng và API nguồn chỉ đọc. Đường mới có container/pool/hàng việc riêng.
// Chạy bộ kiểm hiện hành với giới hạn bốn việc đồng thời; lỗi không mất biên nhận.
// Không khởi động các worker Writing, Progress Log hoặc Speaking bài cũ.
export function createIndependentApp({service,teacher,documents,workerSecret='',origin=speakingWebOrigin,docsReadMode='queued',observation=null,teacherAdmission}) {
  const app=express();
  app.set('trust proxy',1);
  app.use(helmet());app.use(express.json({limit:'2mb'}));
  app.use((req,res,next)=>{
    if(req.headers.origin===origin) {
      res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');
      res.set('Access-Control-Allow-Credentials','true');
      res.set('Access-Control-Allow-Headers','content-type,authorization');
      res.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    }
    if(req.method==='OPTIONS') return res.sendStatus(204);
    next();
  });
  app.get('/health',async(_req,res,next)=>{try{await service.pool.query('SELECT 1');res.json({ok:true,system:'speaking-independent',docsReadMode,build:process.env.BUILD_SHA||'unknown'});}catch(e){next(e);}});
  const router=express.Router();
  const quotaMessage={ok:false,error:'RATE_LIMITED',message:'Bạn đã gửi quá nhiều yêu cầu. Hãy chờ một phút rồi thử lại.'};
  // Giữ ngân sách thử sai theo mạng; token tự bịa không tạo đường né giới hạn này.
  router.use(rateLimit({windowMs:60000,limit:180,skipSuccessfulRequests:true,standardHeaders:'draft-8',legacyHeaders:false,message:quotaMessage}));
  // Tối đa 30 người chung mạng: mỗi người có ngân sách riêng, kèm trần tổng của mạng.
  router.use(rateLimit({windowMs:60000,limit:180*30,standardHeaders:'draft-8',legacyHeaders:false,message:quotaMessage}));
  router.use(rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-8',legacyHeaders:false,message:quotaMessage,
    keyGenerator:req=>{
      const {accessToken,studentRef}=req.body||{};
      if(typeof accessToken==='string'&&/^[A-Za-z0-9_-]{43}$/.test(accessToken)&&typeof studentRef==='string'&&/^[0-9a-f-]{36}$/i.test(studentRef))
        return 'student:'+createHash('sha256').update(accessToken+':'+studentRef).digest('hex');
      return 'guest:'+ipKeyGenerator(req.ip);
    }}));
  if(teacher) mountSpeakingTeacherProgress(router,{teacher,z});
  mountSpeakingObservationRoutes(router,{observation,z,teacherAdmission});
  const code=z.string().trim().min(3).max(100);
  const selected=z.object({assignmentCode:code,classCode:z.string().regex(/^[A-Za-z0-9_-]{2,32}$/),documentId:z.string().regex(/^[A-Za-z0-9_-]{5,120}$/).optional()}).strict();
  const identity=z.object({accessToken:z.string().regex(/^[A-Za-z0-9_-]{32,200}$/),studentRef:z.string().uuid()}).strict();
  function route(method,path,schema,fn,key='',status=200) {
    router[method](path,async(req,res,next)=>{try{
      const data=schema.parse(method==='get'?req.query:req.body);
      const result=await fn(data,req);
      res.status(status).json(key?{ok:true,[key]:result}:{ok:true,...result});
    }catch(e){next(e);}});
  }
  route('get','/classes',z.object({assignmentCode:code}).strict(),service.classes,'classes');
  route('post','/assignment/roster',selected,service.roster,'assignment');
  route('post','/assignment/open',selected.omit({classCode:true}).extend({classCode:selected.shape.classCode.optional(),documentId:selected.shape.documentId.unwrap()}),service.roster,'assignment');
  route('post','/session/start-selected',selected.extend({studentRef:z.string().uuid(),identityConfirmed:z.literal(true)}),service.startSelected,'session');
  route('post','/identity/resolve',z.object({assignmentCode:code,studentRef:z.string().uuid()}).strict(),service.resolveIdentity);
  route('post','/open',identity,service.open);
  route('post','/doctor/list',identity,service.listDoctor);
  route('post','/checks/request',identity.extend({part:z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),url:z.url().max(500)}).strict(),i=>service.requestCheck({...i,rawUrl:i.url}),'check',202);
  route('post','/doctor/practice/request',identity.extend({slot:z.number().int().min(1).max(2),exerciseId:z.string().uuid(),url:z.url().max(500)}).strict(),i=>service.requestPracticeCheck({...i,rawUrl:i.url}),'check',202);
  route('post','/doctor/practice/extra/request',identity.extend({exerciseId:z.string().uuid(),url:z.url().max(500)}).strict(),i=>service.requestPracticeCheck({...i,slot:null,rawUrl:i.url}),'check',202);
  route('post','/finish',identity.extend({manualSubmit:z.literal(true).optional(),voiceConfirmedParts:z.array(z.string()).max(2).default([])}).strict(),service.finish,'receipt');
  router.get('/teacher/receipts/:id',async(req,res,next)=>{try{
    const id=z.string().uuid().parse(req.params.id);
    res.json({ok:true,receipt:await service.teacherReceipt(id,{cookie:req.get('cookie')||'',authorization:req.get('authorization')||'',origin:req.get('origin')||''})});
  }catch(e){next(e);}});
  router.use('/internal',(req,res,next)=>{
    const actual=Buffer.from(req.get('x-speaking-worker-secret')||'');
    const expected=Buffer.from(workerSecret);
    if(!expected.length||actual.length!==expected.length||!timingSafeEqual(actual,expected)) return res.status(401).json({ok:false,error:'UNAUTHORIZED'});
    next();
  });
  const native=z.object({courseId:z.string().regex(/^\d+$/),courseWorkId:z.string().regex(/^\d+$/)}).strict();
  route('get','/internal/assignments/scopes',z.object({}).strict(),()=>documents.scopes(),'assignments');
  route('post','/internal/assignments/register',native.extend({assignmentCode:code,title:z.string().max(500).optional(),classroomState:z.enum(['PUBLISHED','DRAFT','DELETED'])}),i=>documents.register(i),'result');
  route('post','/internal/classroom-copies/sync',native.extend({snapshotComplete:z.literal(true),submissions:z.array(z.object({id:z.string().min(1).max(200),userId:z.string().min(1).max(200),documentId:z.string().regex(/^[A-Za-z0-9_-]{5,120}$/).nullable()}).strict()).max(100)}),i=>documents.sync(i),'result');
  const doc=z.object({documentId:z.string().regex(/^[A-Za-z0-9_-]{5,120}$/),document:z.record(z.string(),z.unknown())}).strict();
  route('post','/internal/classroom-copies/plan',doc,i=>documents.plan(i),'plan');
  route('post','/internal/classroom-copies/verify',doc,i=>documents.verify(i),'result');
  route('post','/internal/alerts/scan',native.extend({snapshotComplete:z.literal(true),notBefore:z.iso.datetime().optional(),
    submissions:z.array(z.object({id:z.string().min(1).max(200),userId:z.string().min(1).max(200),
      state:z.enum(['NEW','CREATED','TURNED_IN','RETURNED','RECLAIMED_BY_STUDENT']),updateTime:z.iso.datetime().optional(),alternateLink:z.string().max(1000).default('')}).strict()).max(100)}),i=>documents.scan(i),'scan');
  route('post','/internal/alerts/claim',native,i=>documents.claimAlert(i),'batch');
  route('post','/internal/alerts/ack',z.object({batchId:z.string().uuid()}).strict(),i=>documents.ackAlert(i),'alert');
  app.use('/api/speaking-homework-independent',router);
  app.use((e,_req,res,_next)=>{
    if(e instanceof z.ZodError) return res.status(400).json({ok:false,error:'INVALID_INPUT',message:'Dữ liệu gửi lên chưa hợp lệ.'});
    if(e instanceof SpeakingHomeworkError) return res.status(e.httpStatus).json({ok:false,error:e.code,message:e.message});
    console.error('Speaking độc lập lỗi:',String(e.code||'INTERNAL_ERROR'));
    res.status(503).json({ok:false,error:'SERVICE_UNAVAILABLE',message:'Hệ thống tạm chưa xử lý được. Bài đã lưu vẫn được giữ; hãy thử lại.'});
  });
  return app;
}

export function createIndependentSourceClient({base,secret,call=fetch,teacherOrigin=speakingWebOrigin}) {
  const url=new URL(base);
  const teacherUrl=new URL(teacherOrigin);
  if(!['http:','https:'].includes(url.protocol)||secret.length<32||!['http:','https:'].includes(teacherUrl.protocol)
    ||teacherUrl.origin!==teacherOrigin) throw new Error('SOURCE_CONFIG_INVALID');
  async function request(path,body,headers={}) {
    const response=await call(base.replace(/\/$/,'')+path,{method:body?'POST':'GET',headers:{
      'content-type':'application/json','x-speaking-worker-secret':secret,...headers},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
    let data;
    try{data=await response.json();}catch{
      throw new SpeakingHomeworkError('SOURCE_UNAVAILABLE','Chưa kiểm được nguồn lớp và mẫu bài.',response.ok||response.status>=500?503:response.status);
    }
    if(!response.ok||data.ok!==true) throw new SpeakingHomeworkError(data.error||'SOURCE_UNAVAILABLE',data.message||'Chưa kiểm được nguồn lớp và mẫu bài.',response.status>=500?503:response.status);
    return data;
  }
  const legacyCodes=new Set(['67-speaking-paraphrase','67-speaking-lam_ro','67-speaking-diem_giua','67-speaking-on_tap_lam_ro_diem_giua']);
  const pendingContexts=new Map();
  async function context(input){
    const body={assignmentCode:input.assignmentCode,...(input.classCode?{classCode:input.classCode}:{}),...(input.studentRef?{studentRef:input.studentRef}:{}),...(input.webEntry?{webEntry:true}:{})};
    // Chỉ gộp lượt đọc đang chờ của đúng bài/lớp/học viên; không giữ quyền sau phản hồi.
    const key=JSON.stringify(body);
    if(pendingContexts.has(key))return pendingContexts.get(key);
    const pending=request('/internal/independent/context',body);
    pendingContexts.set(key,pending);
    try{return await pending;}finally{pendingContexts.delete(key);}
  }
  async function contexts(inputs){
    const scopes=speakingSourceScopes(inputs);
    if(!scopes.length)return new Map();
    return expandSpeakingSourceBatch(scopes,await request('/internal/independent/contexts',{scopes}));
  }
  async function teacherAdmission(classIds,headers){
    if(!Array.isArray(classIds)||classIds.length>1000||classIds.some(id=>typeof id!=='string'||!/^(\d+|unlinked)$/.test(id)))
      throw new SpeakingHomeworkError('INVALID_CLASS','Danh sách lớp không hợp lệ.',400);
    const requested=[...new Set(classIds)];
    let data;
    // Đây là POST nội bộ chỉ đọc. Vẫn đáp ứng CSRF native cho cookie Google;
    // GET/CLI không có Origin dùng origin tin cậy của dịch vụ, origin lạ không được thay.
    const teacherHeaders={...headers,origin:headers?.origin||teacherOrigin,'x-izone-csrf':'1'};
    try{data=await request('/internal/independent/teacher-access',{classIds:requested},teacherHeaders);}
    catch(error){
      // Chuyển từng runtime có thể gặp nguồn cũ chưa có đường batch. Chỉ 404/405
      // mới dùng lại kiểm quyền native; 401/403/503 phải giữ nguyên lỗi.
      if(!(error instanceof SpeakingHomeworkError)||![404,405].includes(error.httpStatus))throw error;
      const access=new Set();
      for(let offset=0;offset<requested.length;offset+=6){
        await Promise.all(requested.slice(offset,offset+6).map(async classId=>{
          if((await request(`/internal/independent/teacher-access/${classId}`,null,headers)).allowed===true)access.add(classId);
        }));
      }
      return {allowed:access,authSource:null,reviewer:null};
    }
    const {allowed}=data;
    if(!Array.isArray(allowed)||new Set(allowed).size!==allowed.length||allowed.some(id=>!requested.includes(id)))
      throw new SpeakingHomeworkError('SOURCE_BATCH_INVALID','Chưa đối soát được quyền các lớp.',503);
    return {allowed:new Set(allowed),authSource:data.authSource||null,reviewer:data.reviewer||null};
  }
  async function teachers(classIds,headers){
    // Lối cũ trả Set và không gọi nguồn với danh sách rỗng.
    if(Array.isArray(classIds)&&classIds.length===0)return new Set();
    return (await teacherAdmission(classIds,headers)).allowed;
  }
  async function observeTeachers(inputs){
    const actors=teacherObservationActors(inputs);if(!actors.length)return new Map();
    return expandTeacherObservation(actors,await request('/internal/independent/teacher-observation',{actors}));
  }
  return {legacyOpen:async input=>legacyCodes.has(input.assignmentCode)?(await request('/internal/independent/legacy-open',input)).assignment:null,
    legacySession:async input=>legacyCodes.has(input.assignmentCode)?(await request('/internal/independent/legacy-session',input)).session:null,
    context,contexts,teachers,teacherAdmission,observeTeachers,
    legacyProgress:async(method,input,headers)=>['students','entry'].includes(method)
      ?request('/internal/independent/teacher-progress/'+method+'?'+new URLSearchParams(input),null,headers)
      :request('/internal/independent/teacher-progress/units/'+encodeURIComponent(input.id),null,headers),
    teacher:async(classId,headers)=>(await request(`/internal/independent/teacher-access/${classId||'unlinked'}`,null,headers)).allowed===true};
}

export function startIndependentWorker({service,enabled=true,pollMs=2000,dependencies={},coordinated=false,loopOptions={}}) {
  if(coordinated&&enabled){
    const run=async job=>{
      const adapter=service.workerService(job);
      if(job.kind==='check_main')return runSpeakingCheckJob(adapter,job,dependencies.check);
      if(job.kind==='check_practice')return runPracticeCheckJob(adapter,job,dependencies.practice);
      if(job.kind==='analyze_practice')return runPracticeAnalysisJob(adapter,job,dependencies.doctor);
      if(job.kind==='analyze_homework')return runSpeakingDoctorJob(adapter,job,dependencies.doctor);
      if(job.kind==='write_doc'&&dependencies.writeDocument)return dependencies.writeDocument(service,job);
      await service.failJob(job,'DOCUMENT_WRITER_UNAVAILABLE');
    };
    const loop=createDurableWorkLoop({...loopOptions,claim:n=>service.claimJobs(n),run,capacity:4,scanMs:pollMs,
      onError:error=>console.error('Hàng Speaking độc lập lỗi:',String(error.code||'WORKER_ERROR'))});
    return{stop:()=>loop.close(),wake:()=>loop.wake(),snapshot:()=>loop.snapshot()};
  }
  let stopped=!enabled,running=false,timer;
  async function tick() {
    if(stopped||running) return;
    running=true;
    try {
      const jobs=[];
      for(let i=0;i<4;i++){const j=await service.claimJob();if(!j)break;jobs.push(j);}
      await Promise.all(jobs.map(async job=>{
        const adapter=service.workerService(job);
        if(job.kind==='check_main') return runSpeakingCheckJob(adapter,job,dependencies.check);
        if(job.kind==='check_practice') return runPracticeCheckJob(adapter,job,dependencies.practice);
        if(job.kind==='analyze_practice') return runPracticeAnalysisJob(adapter,job,dependencies.doctor);
        if(job.kind==='analyze_homework') return runSpeakingDoctorJob(adapter,job,dependencies.doctor);
        if(job.kind==='write_doc'&&dependencies.writeDocument) return dependencies.writeDocument(service,job);
        await service.failJob(job,'DOCUMENT_WRITER_UNAVAILABLE');
      }));
    } catch(e) { console.error('Hàng Speaking độc lập lỗi:',String(e.code||'WORKER_ERROR')); }
    finally {running=false;if(!stopped) timer=setTimeout(tick,pollMs).unref();}
  }
  if(enabled) timer=setTimeout(tick,0).unref();
  return {async stop(){stopped=true;clearTimeout(timer);while(running)await new Promise(r=>setTimeout(r,100));}};
}

// Chỉ entrypoint này đọc cấu hình và mở HTTP; import khi kiểm thử không tạo side effect.
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const env=process.env;
  for(const key of ['INDEPENDENT_DATABASE_URL','INDEPENDENT_ACCESS_SECRET','SPEAKING_SOURCE_URL','SPEAKING_SOURCE_SECRET']) if(!env[key]) throw new Error(`MISSING_${key}`);
  const pool=new pg.Pool({connectionString:env.INDEPENDENT_DATABASE_URL,max:6,connectionTimeoutMillis:5000,application_name:'speaking_independent_api'});
  const source=createIndependentSourceClient({base:env.SPEAKING_SOURCE_URL,secret:env.SPEAKING_SOURCE_SECRET});
  const gateway=env.SPEAKING_DOCS_GATEWAY_URL?createDocsGateway({url:env.SPEAKING_DOCS_GATEWAY_URL,secret:env.SPEAKING_DOCS_GATEWAY_SECRET}):null;
  const openingGateway=createOpeningDocsGateway({gateway,credentialFile:env.SPEAKING_DOCS_READ_CREDENTIALS_FILE});
  const progressGateway=env.SPEAKING_DOCS_READ_CREDENTIALS_FILE?createSpeakingProgressGoogle({credentialFile:env.SPEAKING_DOCS_READ_CREDENTIALS_FILE}):null;
  const progressWorker=startSpeakingProgressDocsWorker({pool,schema:'speaking_independent',gateway:env.WORKER_ENABLED==='false'?null:progressGateway,coordinated:env.TEST_SERVICES_COORDINATOR_ENABLED==='true'});
  const documents=openingGateway?createIndependentDocuments({pool,source,accessSecret:env.INDEPENDENT_ACCESS_SECRET,gateway:openingGateway}):null;
  const service=createIndependentSpeaking({pool,accessSecret:env.INDEPENDENT_ACCESS_SECRET,source,documents});
  const observation=env.TEST_SERVICES_OBSERVATION_ENABLED==='true'?createSpeakingObservation({schema:'speaking_independent',
    data:createSpeakingObservationData({pool,schema:'speaking_independent'}),source,observeTeachers:actors=>source.observeTeachers(actors)}):null;
  const worker=startIndependentWorker({service,enabled:env.WORKER_ENABLED!=='false',coordinated:env.TEST_SERVICES_COORDINATOR_ENABLED==='true',dependencies:{writeDocument:gateway?(service,job)=>writeIndependentDocument(service,job,progressGateway||gateway):null}});
  const coordinator=env.TEST_SERVICES_COORDINATOR_ENABLED==='true'?startSpeakingWorkCoordinator({pool,schema:'speaking_independent',worker,
    createClient:()=>new pg.Client({connectionString:env.INDEPENDENT_DATABASE_URL,connectionTimeoutMillis:5000,application_name:'speaking_independent_work_listener'}),
    onDocs:()=>progressWorker.wake?.(),onState:()=>observation?.wake(),onError:error=>console.error('Tín hiệu Speaking độc lập lỗi:',String(error.code||'WORK_SIGNAL_ERROR'))}):null;
  const teacher=createSpeakingTeacherProgress({pool,source});
  const server=createIndependentApp({service,teacher,documents,workerSecret:env.SPEAKING_SOURCE_SECRET,
    observation,teacherAdmission:(input,headers)=>source.teacherAdmission([input.classId],headers),
    docsReadMode:env.SPEAKING_DOCS_READ_CREDENTIALS_FILE?'direct':'queued'}).listen(Number(env.PORT||4338));
  let closing;const stop=()=>closing??=(async()=>{await observation?.close();await new Promise(resolve=>server.close(resolve));await worker.stop();await progressWorker.stop();await coordinator?.stop();await pool.end();})();
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>void stop());
}
