import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

for(const slug of ['term-test-1','term-test-2','mini-test-lesson-5'])test(slug+': 100 HV làm hai thứ tự, 10 cửa sổ GV xem nháp; không tải audio/AI/Portal',
 {skip:!process.env.K67_ORDER_NATIVE_URL,timeout:90000},async t=>{
 const assets={supports:()=>true,getTiming:()=>({readingMinutes:20,readingDurationMinutes:20,listeningTotalSeconds:310,writingDurationMinutes:60}),
  getContent:async()=>({variant:'semantic-html',listening:{},reading:{},writing:{tasks:[]}}),getSessionAudioKey:()=>Buffer.alloc(32),
  getPreview:()=>{throw Error('AUDIO_FORBIDDEN');},streamEncryptedAudio:()=>{throw Error('AUDIO_FORBIDDEN');}};
 const f=await createMiniFixture({examOrder:true,completeSchema:true,assets});t.after(()=>f.db.close());f.app.set('trust proxy',1);
 await f.db.exec(await readFile(new URL('../db/017-writing-scope.sql',import.meta.url),'utf8'));
 if(slug!=='mini-test-lesson-5')await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
  SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
 const refs=['11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444'];
 for(let i=2;i<100;i++){const ref=randomUUID();refs.push(ref);await f.db.query("INSERT INTO mapping.student_mapping_review VALUES($1,1293,$2,$3,'approved')",[ref,1000000+i,'HV tải giả '+i]);}
 const prefix='/api/term-tests/'+slug,metrics={student:[],teacher:[]};
 async function post(index,path,data,shared=false){const began=performance.now();const response=await request(f.app).post(shared?'/api/term-tests/writing':prefix+path)
  .set('X-Forwarded-For','192.0.2.'+(1+Math.floor(index/25))).send({orderClientVersion:1,...data});metrics.student.push(performance.now()-began);
  assert.ok([200,201].includes(response.status),path+': '+JSON.stringify(response.body));return response.body;}
 async function detail(ref){const began=performance.now();const response=await request(f.app).get('/api/term-tests/teacher/saved-progress')
  .set('x-review-token','fixture-only-key').set('X-Forwarded-For','192.0.2.10').query({class:'IC2304',test:slug,student:ref});
  metrics.teacher.push(performance.now()-began);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;}
 const jobs=refs.map(async(studentRef,index)=>{
  const readFirst=index%2===0;
  const opened=await post(index,'/session/prepare',{classCode:'IC2304',studentRef,identityConfirmed:true,examMode:readFirst?'read_first':'lis_first',examDelivery:'cbt'});
  let token={examSessionToken:opened.examSessionToken,generation:opened.generation,...(opened.attemptToken?{attemptToken:opened.attemptToken}:{})};
  async function reading(){
   await post(index,'/reading/start',token);await post(index,'/reading/draft',{...token,revision:1,answers:{14:'A'}});
   const done=await post(index,'/reading',{...token,answers:{14:'A'},draftRevision:1});token.attemptToken=done.attemptToken||token.attemptToken;
  }
  async function listening(){
   await post(index,'/session/start',token);await post(index,'/listening/draft',{...token,revision:1,answers:{11:'A'}});
   const done=await post(index,'/listening',{...token,classCode:'IC2304',studentRef,answers:{11:'A'},draftRevision:1,clientSubmissionId:randomUUID()});token.attemptToken=done.attemptToken||token.attemptToken;
  }
  if(readFirst){await reading();await listening();}else{await listening();await reading();}
  if(slug!=='mini-test-lesson-5'){
   const start=await post(index,'/writing',{attemptToken:token.attemptToken,action:'start',task1:'',task2:''},true);
   const revision=start.writing.serverRevision??start.writing.revision??0;
   const draft=await post(index,'/writing',{attemptToken:token.attemptToken,action:'draft',baseRevision:revision,task1:slug==='term-test-2'?'Task 1 riêng '+index:'',task2:'Writing riêng '+index},true);
   assert.equal(draft.writing.accepted,true);
  }
 });
 const readers=Array.from({length:10},(_,reader)=> (async()=>{for(let i=0;i<3;i++)await detail(refs[reader*3+i]);})());
 const settled=await Promise.allSettled([...jobs,...readers]),failures={};for(const row of settled)if(row.status==='rejected'){const error=String(row.reason);failures[error]=(failures[error]||0)+1;}
 assert.deepEqual(failures,{});
 const before=(await f.db.query('SELECT row_to_json(a) AS value FROM assessment.term_test_attempt a ORDER BY id')).rows;
 for(const [index,ref]of refs.entries()){
  const result=await detail(ref);assert.equal(result.attempts.length,1);const saved=result.attempts[0];
  assert.equal(saved.order,index%2===0?'read_first':'lis_first');assert.deepEqual(saved.listening.answers,{'11':'A'});assert.deepEqual(saved.reading.answers,{'14':'A'});
  if(slug!=='mini-test-lesson-5'){assert.equal(saved.writing.task2,'Writing riêng '+index);assert.equal(saved.writing.submittedAt,null);}
 }
 assert.deepEqual((await f.db.query('SELECT row_to_json(a) AS value FROM assessment.term_test_attempt a ORDER BY id')).rows,before);
 assert.equal(before.length,100);
 const stat=values=>{const sorted=[...values].sort((a,b)=>a-b);return{requests:sorted.length,p95ms:Math.round(sorted[Math.ceil(sorted.length*.95)-1]),maxMs:Math.round(sorted.at(-1))};};
 t.diagnostic(JSON.stringify({environment:'local-HTTP-native-PostgreSQL-k67_app-pool5',students:100,teacherReaders:10,
  student:stat(metrics.student),teacher:stat(metrics.teacher),audioDownloads:0,externalCalls:0,simulatedNetworks:4,studentsPerNetwork:25}));
});
