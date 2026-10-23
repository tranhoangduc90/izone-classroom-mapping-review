// Tải giả bằng HTTP thật + PostgreSQL riêng. Không nhận cấu hình database production.
import express from 'express';
import {fork} from 'node:child_process';
import pg from 'pg';
import crypto from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {postgresFixture} from '../test/learning-postgres-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningRouter} from '../src/learning-routes.js';
import {createProgressLinkCipher} from '../src/learning-journey-comments.js';
import {reuseLearningQueryPlans,reuseTeacherSessionQueryPlans} from '../src/learning-query-plans.js';
import {createAuthService} from '../src/auth.js';

const pause=ms=>new Promise(done=>setTimeout(done,ms));
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
const summary=values=>({count:values.length,p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99),max:values.length?Math.max(...values):null});
const fixture=await postgresFixture({asApplication:true,studentCount:0});
await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/202610070001_student_journey_comments.sql',import.meta.url),'utf8'));
await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/202610230001_teacher_live_updates.sql',import.meta.url),'utf8'));
const targetClasses=30,studentsPerClass=18,poolMax=15;
const pool=new pg.Pool({connectionString:fixture.pool.options.connectionString,max:poolMax,options:'-c role=learning_api',application_name:'pl_v21_load'});
reuseLearningQueryPlans(pool);
const queryMetrics=new Map();
pool.on('connect',client=>{const original=client.query.bind(client);client.query=(...args)=>{
  const begin=performance.now(),key=String(args[0]?.text||args[0]).replace(/\s+/g,' ').slice(0,120);
  const record=()=>{const elapsed=performance.now()-begin;const prior=queryMetrics.get(key)||{count:0,total:0,max:0};prior.count++;prior.total+=elapsed;prior.max=Math.max(prior.max,elapsed);queryMetrics.set(key,prior);};
  if(typeof args.at(-1)==='function'){const callback=args.pop();args.push((...values)=>{record();callback(...values);});return original(...args);}
  const result=original(...args);if(result?.then)result.then(record,record);return result;
};});
const keys={v1:crypto.randomBytes(32).toString('base64')};
const service=createLearningService({pool,journeyCommentsEnabled:true,progressLinkCipher:createProgressLinkCipher({keys})});
const classes=[],history=[],responsesByStudent=new Map();let running=false,phase='Đang chuẩn bị',result=null;
for(let index=0;index<targetClasses;index++){
  const classId=String(5000+index),email=`load${index}@example.test`,reviewer={email,displayName:'Giảng viên kiểm tải',canAccessAllClasses:false};
  await fixture.pool.query(`INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot) VALUES($1,$2);
    `,[classId,'Lớp kiểm '+String(index+1).padStart(3,'0')]);
  await fixture.pool.query(`INSERT INTO mapping.reviewer_account VALUES($1,'active');`,[email]);
  await fixture.pool.query(`INSERT INTO mapping.reviewer_class_access VALUES($1,$2);`,[email,classId]);
  await fixture.pool.query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot)
    SELECT gen_random_uuid(),$1,100000+$2*100+n,'Học viên giả '||n FROM generate_series(1,$3::int) n`,[classId,index,studentsPerClass]);
  const published=await service.publishReflectionForm({reviewer,title:'Phiếu kiểm tải · dữ liệu giả',courseCode:'LOAD-V21',classId,sessionNumber:1,opensAt:null,closesAt:null,
    items:[1,2,3].map(n=>({libraryItemId:`10000000-0000-4000-8000-00000000000${n}`,checkpoint:n===1?1:2,required:true}))});
  const assignment=await service.getPublicAssignment(published.publicToken),people=[];
  for(const block of assignment.definition.blocks)await service.setBlockRelease({assignmentId:published.assignmentId,blockId:block.blockId,status:'open',operationId:crypto.randomUUID(),reviewer});
  for(const person of assignment.roster){
    const attempt=await service.startAttempt({publicToken:published.publicToken,studentRef:person.studentRef,identityConfirmed:true,clientIdempotencyKey:crypto.randomUUID()});
    people.push({...person,attemptToken:attempt.attemptToken,definitionHash:published.definitionHash,revision:0,inFlight:false});
  }
  const row={classId,email,reviewer,published,assignment,people,index};classes.push(row);
  if(index%10===9)console.log(JSON.stringify({seededClasses:index+1}));
}
// Phiên giả có đủ đường đọc/cập nhật DB thật của đăng nhập chung; không gọi Google/broker production.
await fixture.pool.query(`ALTER TABLE mapping.reviewer_account ADD COLUMN display_name text,ADD COLUMN role text DEFAULT 'reviewer',
 ADD COLUMN can_access_all_classes boolean DEFAULT false,ADD COLUMN google_subject text,ADD COLUMN last_login_at timestamptz,ADD COLUMN updated_at timestamptz;
 CREATE TABLE mapping.reviewer_session(token_hash bytea PRIMARY KEY,reviewer_email text,google_subject text,idle_expires_at timestamptz,
 absolute_expires_at timestamptz,last_seen_at timestamptz DEFAULT now(),revoked_at timestamptz);`);
const mappingPool=new pg.Pool({connectionString:fixture.pool.options.connectionString,max:5,application_name:'pl_v21_auth'});
reuseTeacherSessionQueryPlans(mappingPool);
for(const c of classes){c.fixtureSession=crypto.randomBytes(32).toString('base64url');
 await fixture.pool.query('UPDATE mapping.reviewer_account SET google_subject=$2,display_name=$1 WHERE email=$1',[c.email,'fixture-'+c.index]);
 await fixture.pool.query(`INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
 VALUES($1,$2,$3,now()+interval '90 days',now()+interval '365 days')`,[crypto.createHash('sha256').update(c.fixtureSession).digest(),c.email,'fixture-'+c.index]);}
const auth=createAuthService({config:{authMode:'google',nodeEnv:'test',teacherSessionCookieSecure:false},pool:mappingPool});
const app=express();app.set('trust proxy',1);app.use(express.json({limit:'200kb'}));
const httpDurations=new Map();let poolWaitPeak=0;
const samplePool=setInterval(()=>{poolWaitPeak=Math.max(poolWaitPeak,pool.waitingCount);},20).unref();
app.use((req,res,next)=>{
  const begin=performance.now(),path=req.path;res.on('finish',()=>{
    if(!path.startsWith('/api/learning/'))return;
    const key=req.method+' '+path.replace(/\/[a-f0-9-]{36}(?=\/|$)/g,'/:id');
    const values=httpDurations.get(key)||[];values.push(performance.now()-begin);httpDurations.set(key,values);
  });next();
});
app.use((req,res,next)=>{const teacher=classes.find(c=>c.email===(req.get('x-fixture-teacher')||classes[0].email));
 if(teacher)req.headers.cookie='izone_teacher_session='+teacher.fixtureSession;next();});
const authenticate=auth.authenticate;
app.get('/api/auth/session',authenticate,(req,res)=>res.json({ok:true,reviewer:req.reviewer}));
const router=createLearningRouter({pool,authenticate,revalidate:auth.revalidate,realtimeEnabled:true,
  journeyCommentsEnabled:true,progressLinkKeys:keys,erpScheduleReader:null,logger:{info(){}}});
app.use('/api/learning',router);
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.httpStatus||500).json({ok:false,error:error.code||'INTERNAL',message:error.message});});
app.get('/fixture/state',(req,res)=>res.json({task:'progress-realtime-v21-20261023',phase,running,result,history,poolWaiting:pool.waitingCount,queries:[...queryMetrics.entries()].map(([sql,v])=>({sql,...v,mean:v.total/v.count})).sort((a,b)=>b.total-a.total).slice(0,10),assignment:classes[0].published,people:classes[0].people.map(({studentRef})=>({studentRef}))}));
const apiDelay=monitorEventLoopDelay({resolution:20});apiDelay.enable();let generator=null;
const model=()=>({targetClasses,studentsPerClass,poolMax,classes:classes.map(c=>({classId:c.classId,email:c.email,index:c.index,published:c.published,assignment:c.assignment,people:c.people}))});
async function fixtureStats(key){
 if(key==='clock')return {serverNow:Date.now()};
 if(key==='health')return {waiting:pool.waitingCount};
 if(key==='resources')return {rssBytes:process.memoryUsage().rss,eventLoopP95Ms:apiDelay.percentile(95)/1e6,poolTotal:pool.totalCount,poolWaiting:pool.waitingCount,poolWaitPeak,httpDurations:Object.fromEntries([...httpDurations].map(([key,values])=>[key,summary(values)])),streams:router.liveUpdates.stats(),notifyQueue:Number((await fixture.pool.query('SELECT pg_notification_queue_usage() AS usage')).rows[0].usage)};
 if(key==='counts')return (await fixture.pool.query(`SELECT (SELECT count(*)::int FROM learning.submission) AS submissions,(SELECT count(*)::int FROM learning.attendance_record) AS attendance,(SELECT count(*)::int FROM learning.attendance_event) AS attendance_events,(SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS portal_jobs`)).rows[0];
 throw Error('Sai loại thống kê');
}
async function receive(message){
 if(message.kind==='phase'){phase=message.phase;apiDelay.reset();httpDurations.clear();poolWaitPeak=0;}
 if(message.kind==='report')history.push(message.report);
 if(message.kind==='complete'){result=message.result;phase=result.ok?'Đã đo tải nháp và nộp':'Đã đo · còn ngưỡng chưa đạt';running=false;await writeFile('/tmp/v21-load-result.json',JSON.stringify(result,null,2));}
}
app.get('/fixture/resources',async(req,res)=>{try{res.json({ok:true,value:await fixtureStats(req.query.key)});}catch(error){res.status(500).json({ok:false,message:error.message});}});
app.post('/fixture/observer',async(req,res)=>{await receive(req.body);res.json({ok:true});});
app.post('/fixture/start',async(req,res)=>{
 if(running||result)return res.status(409).json({ok:false});running=true;
 if(req.body?.external===true){res.json({ok:true,model:model()});return;}
 res.json({ok:true});
 generator=fork(new URL('./learning-realtime-generator.mjs',import.meta.url),[],{stdio:['ignore','inherit','inherit','ipc']});
 const health=setInterval(()=>{if(generator.connected)generator.send({kind:'health',waiting:pool.waitingCount},()=>{});},500).unref();
 generator.on('message',async message=>{
  if(message.kind==='ready')generator.send(model());
  if(message.kind==='phase'){phase=message.phase;apiDelay.reset();}
  if(message.kind==='report')history.push(message.report);
  if(message.kind==='complete'){result=message.result;phase=result.ok?'Đã đo tải nháp và nộp':'Đã đo · còn ngưỡng chưa đạt';running=false;await writeFile('/tmp/v21-load-result.json',JSON.stringify(result,null,2));}
  if(message.kind==='rpc'){
   try{let value;
    if(message.key==='resources')value=await fixtureStats('resources');
    else if(message.key==='counts')value=(await fixture.pool.query(`SELECT (SELECT count(*)::int FROM learning.submission) AS submissions,(SELECT count(*)::int FROM learning.attendance_record) AS attendance,(SELECT count(*)::int FROM learning.attendance_event) AS attendance_events,(SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS portal_jobs`)).rows[0];
    else throw Error('Sai loại thống kê');
    if(generator.connected)generator.send({kind:'reply',id:message.id,value});
   }catch(error){if(generator.connected)generator.send({kind:'reply',id:message.id,error:error.message});}
  }
 });
 generator.on('exit',code=>{clearInterval(health);if(running){result={ok:false,error:'Máy phát tải dừng trước kết quả: '+code};running=false;}});
});
const server=app.listen(28798,'127.0.0.1');await new Promise((done,reject)=>{server.once('listening',done);server.once('error',reject);});
console.log(JSON.stringify({ready:true,port:28798,classes:classes.length,students:classes.length*studentsPerClass,poolMax}));

async function close(){generator?.kill('SIGTERM');clearInterval(samplePool);apiDelay.disable();await router.liveUpdates.close();server.closeAllConnections();await new Promise(done=>server.close(done));await pool.end();await mappingPool.end();await fixture.close();process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
