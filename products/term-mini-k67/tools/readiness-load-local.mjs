import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,randomInt,createHash,createDecipheriv} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import {createReadinessFixture} from '../test/helpers/readiness-fixture.js';
import {createApp} from '../src/app.js';
import {createDatabasePool} from '../src/db.js';

// Dữ liệu giả, HTTP thật trên loopback, DB mới có tên riêng; không nối môi trường thật.
// Mỗi học viên có UUID/phiên/đáp án riêng; tất cả dùng cùng IP thật, không giả XFF.
// Client giữ nhịp thời gian thực. Chỉ mô phỏng tiến độ API, không chứng nhận nghe bằng tai.
const here=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(here),'..');
const args=process.argv.slice(2),value=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
const out=value('--output')?path.resolve(value('--output')):null;
const usersCount=Number(value('--users')||60),smoke=args.includes('--smoke');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,Math.max(0,ms)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const q=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.ceil(a.length*p)-1)]:null;
function guard(){
  assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM,'local-synthetic-20261014','Cần xác nhận fixture giả local.');
  assert.equal(process.env.K67_ORDER_NATIVE_URL,'postgres://k67_fixture_admin@127.0.0.1:55468/postgres','Chỉ dùng cluster fixture loopback đã chỉ định.');
  assert.ok([3,60,120].includes(usersCount),'Chỉ hỗ trợ 3, 60 hoặc 120 phiên.');
  if(!args.includes('--server'))assert.ok(out&&/^E:[\\/]/i.test(out),'Cần --output trên ổ E.');
}

async function server(){
  guard();const f=await createReadinessFixture({allowedOrigins:new Set()});
  const database=(await f.db.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(database,/^term_mini_k67_test_order_[a-f0-9]{12}$/);
  // Dùng đúng giới hạn pool và timeout runtime; pool fixture chỉ dành setup/readback.
  const pool=createDatabasePool({databaseUrl:`postgres://k67_app@127.0.0.1:55468/${database}`,dbPoolMax:5});
  const students=[];
  for(let i=0;i<usersCount;i++){
    const studentRef=randomUUID();
    await f.db.query("INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot,status) VALUES($1,1293,$2,$3,'approved')",[studentRef,1000000+i,'Học viên tải giả '+i]);
    students.push({studentRef,index:i});
  }
  const app=express(),api=createApp({pool,config:f.config});
  const pages=process.env.K67_LOAD_PAGES;
  if(pages){
    assert.ok(path.isAbsolute(pages));
    app.get('/term-tests/k67-shared/config.js',(_req,res)=>res.type('js').send("window.TERM_TEST_APP_CONFIG={API_BASE_URL:location.origin+'/term-mini-k67-api'};"));
  }
  app.use('/term-mini-k67-api',api);
  const proof=async()=>({
    sessions:(await f.db.query('SELECT id,student_ref,same_computer,same_headphones,answers,draft_revision,heard_seconds,heard_confirmed,cache_state,submitted_at,reading_draft,reading_revision,reading_submitted_at,writing_draft,writing_revision,writing_submitted_at,check_report,check_revision,check_updated_at FROM assessment.k67_readiness_session ORDER BY created_at')).rows,
    examSessions:Number((await f.db.query('SELECT count(*) AS n FROM assessment.term_test_exam_session')).rows[0].n),
    examAttempts:Number((await f.db.query('SELECT count(*) AS n FROM assessment.term_test_attempt')).rows[0].n)
  });
  app.get('/__proof',async(_req,res,next)=>{try{res.json(await proof());}catch(error){next(error);}});
  if(pages)app.use(express.static(pages));
  // Windows có thể cấp port thấp thuộc danh sách bị browser/fetch cấm (ví dụ 6665).
  // Chọn vùng cao không bị cấm, chỉ retry EADDRINUSE; không đổi lỗi HTTP thành pass.
  let http;
  for(let attempt=0;attempt<20;attempt++){
    const candidate=app.listen(randomInt(20000,50000),'127.0.0.1');
    try{await once(candidate,'listening');http=candidate;break;}catch(error){if(error.code!=='EADDRINUSE')throw error;}
  }
  assert.ok(http,'Không tìm được port loopback trống.');
  // Chỉ cho đúng origin preview của lượt này, giữ guard Origin của sản phẩm hoạt động.
  f.config.allowedOrigins.add(`http://127.0.0.1:${http.address().port}`);
  const lag=monitorEventLoopDelay({resolution:10});lag.enable();const cpu=process.cpuUsage();
  let peakRss=0,peakWaiters=0,peakConnections=0,contextErrors=0,closing=false;
  const sample=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);peakWaiters=Math.max(peakWaiters,pool.waitingCount);peakConnections=Math.max(peakConnections,pool.totalCount);},100);
  const refresh=setInterval(()=>f.db.query('UPDATE mapping.k67_context_state SET captured_at=clock_timestamp()').catch(()=>contextErrors++),30000);
  async function close(){if(closing)return;closing=true;clearInterval(sample);clearInterval(refresh);lag.disable();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await pool.end();await f.db.close();}
  const safety=setTimeout(()=>close().finally(()=>process.exit(2)),300000);
  process.on('message',async m=>{
    try{
      if(m.action==='inspect')process.send({id:m.id,proof:await proof(),metrics:{peakRssMiB:peakRss/1048576,peakWaiters,peakConnections,eventLoopP99Ms:lag.percentile(99)/1e6,cpu:process.cpuUsage(cpu),contextErrors}});
      if(m.action==='close'){clearTimeout(safety);await close();process.send({id:m.id,closed:true});process.disconnect();}
    }catch(error){process.send({id:m.id,error:error.code||error.message});}
  });
  process.on('disconnect',()=>close().catch(()=>{}));
  process.send({ready:true,base:`http://127.0.0.1:${http.address().port}`,students,database});
}

async function main(){
  guard();await mkdir(out,{recursive:true});
  const child=fork(here,['--server','--users',String(usersCount)],{cwd:root,windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe','ipc']});
  let childLog='';child.stdout.on('data',d=>childLog+=d);child.stderr.on('data',d=>childLog+=d);
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Fixture chưa sẵn sàng: '+childLog));},45000);
    child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exit '+code+': '+childLog));});child.once('error',reject);
  });assert.equal(ready.ready,true);
  const rpc=action=>new Promise((resolve,reject)=>{
    const id=randomUUID(),timer=setTimeout(()=>{child.off('message',on);reject(new Error('RPC timeout'));},15000);
    const on=m=>{if(m.id!==id)return;clearTimeout(timer);child.off('message',on);m.error?reject(new Error(m.error)):resolve(m);};child.on('message',on);child.send({id,action});
  });
  const records=[],began=performance.now(),base=ready.base+'/term-mini-k67-api/api/k67-readiness/v1';
  let tickLagMs=0;
  const students=ready.students.map(u=>({...u,requestId:randomUUID(),openingProof:randomBytes(32).toString('hex'),revision:0,checkRevision:0,runId:randomUUID()}));
  async function call(u,route,data,expected=[200],label=route){
    const t=performance.now();let status=0,body={},error;
    try{
      const response=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{Origin:ready.base,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify({...data,...(u?.token?{token:u.token}:{})}),signal:AbortSignal.timeout(10000)});
      status=response.status;body=await response.json();error=body.error;
    }catch(e){error=e.name+':'+e.message+(e.cause?.message?':'+e.cause.message:'');}
    const r={label,status,ms:performance.now()-t,expected:expected.includes(status),...(error?{error}:{})};records.push(r);return{...r,body,record:r};
  }
  function report(u,code='VISIBLE'){
    // Payload đủ 13 mục như giao diện; mã đều mô phỏng, không chứng nhận thiết bị thật.
    const now=new Date().toISOString(),codes={environment:'AVAILABLE',session:'RESPONDED',localDraft:'READBACK_OK',audio:'VERIFIED',cache:'READBACK_OK',format:'MPEG_DECODED',playback:'PROGRESS',draftSync:'READBACK_OK',hearing:'RECONFIRM',page:code,load:'OBSERVING',output:'LIMITED',wake:'UNAVAILABLE'};
    return{version:'web-check-v1',runId:u.runId,startedAt:u.startedAt,checks:Object.entries(codes).map(([id,code])=>({id,state:['hearing','output','wake'].includes(id)?'unknown':'pass',code,at:now}))};
  }
  async function download(u){
    const t=performance.now();let status=0,bytes=0,error,okay=false;
    try{
      const response=await fetch(base+'/audio',{headers:{Origin:ready.base,Authorization:'Bearer '+u.token},signal:AbortSignal.timeout(30000)});status=response.status;
      if(!response.ok)throw new Error('DOWNLOAD_HTTP');
      let head=Buffer.alloc(0),tail=Buffer.alloc(0),decipher;const hash=createHash('sha256');
      for await(const chunk of response.body){let data=Buffer.from(chunk);
        if(!decipher){head=Buffer.concat([head,data]);if(head.length<17)continue;assert.equal(head.subarray(0,5).toString(),'IZTT1');decipher=createDecipheriv('aes-256-gcm',Buffer.from(u.access.audioKey,'base64'),head.subarray(5,17));data=head.subarray(17);head=Buffer.alloc(0);}
        data=Buffer.concat([tail,data]);if(data.length<=16){tail=data;continue;}const plain=decipher.update(data.subarray(0,-16));hash.update(plain);bytes+=plain.length;tail=data.subarray(-16);
      }
      decipher.setAuthTag(tail);const last=decipher.final();hash.update(last);bytes+=last.length;
      okay=bytes===u.access.manifest.byteLength&&hash.digest('hex')===u.access.manifest.sha256;
    }catch(e){error=e.name+':'+e.message;}
    records.push({label:'cold-audio-all-students',status,ms:performance.now()-t,bytes,expected:okay,...(error?{error}:{})});u.downloaded=okay;
  }
  let browser;
  try{
    await writeFile(path.join(out,'live-server.json'),JSON.stringify({base:ready.base,at:new Date().toISOString(),database:ready.database}), 'utf8');
    console.log(JSON.stringify({ready:true,base:ready.base,students:usersCount}));
    assert.equal((await call(null,'/roster?class=IC2304',undefined,[200],'origin-preflight')).status,200);
    if(value('--browser-runner')){
      // Trình duyệt thật là hai phiên bổ sung, chạy đồng thời với HTTP load; không tua audio.
      browser=fork(path.resolve(value('--browser-runner')),[new URL(ready.base).port,value('--browser-output')||'load-browser'],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
      let log='';browser.stdout.on('data',d=>log+=d);browser.stderr.on('data',d=>log+=d);
      browser.done=new Promise(resolve=>{browser.once('error',error=>resolve({code:null,error:error.message,log}));browser.once('exit',code=>resolve({code,log}));});
    }
    await Promise.all(students.map(async u=>{
      assert.equal((await call(null,'/roster?class=IC2304')).status,200);
      const opening={classCode:'IC2304',studentRef:u.studentRef,requestId:u.requestId,openingProof:u.openingProof};
      const opened=await call(null,'/sessions',opening,[201]);assert.equal(opened.status,201);u.token=opened.body.token;u.startedAt=new Date().toISOString();
      if(u.index%10===0){const retry=await call(null,'/sessions',opening,[201],'open-retry-lost-ack');assert.equal(retry.body.token,u.token);}
      assert.equal((await call(u,'/device',{sameComputer:true,sameHeadphones:true})).status,200);
      const access=await call(u,'/audio-access',{});assert.equal(access.status,200);u.access=access.body;
    }));
    // Không giới hạn xuống 8 lượt: mọi phiên đều nhận, giải mã và kiểm hash cả file.
    await Promise.all(students.map(download));assert.ok(students.every(u=>u.downloaded));
    if(process.env.K67_LOAD_PAGES)await Promise.all(students.map(async()=>{
      const t=performance.now();let status=0,okay=false,error;
      try{const r=await fetch(ready.base+'/term-tests/lam-quen-k67/assets/codec-sample-v1.mp3',{signal:AbortSignal.timeout(10000)});status=r.status;const bytes=Buffer.from(await r.arrayBuffer());okay=r.ok&&bytes.length===96548&&sha(bytes)==='28f88bb9a2aa243d322787641339773061f1906a8ae562f30f6681e9f572feb1';}catch(e){error=e.name;}
      records.push({label:'cold-codec-sample',status,ms:performance.now()-t,expected:okay,...(error?{error}:{})});assert.ok(okay);
    }));
    const steady=performance.now(),ticks=smoke?2:18;
    for(let tick=1;tick<=ticks;tick++){
      await wait(steady+tick*5000-performance.now());tickLagMs=Math.max(tickLagMs,performance.now()-(steady+tick*5000));
      await Promise.all(students.map(async u=>{
        u.revision++;u.answers={'1':`HV ${u.index} bản ${u.revision}`};
        const draft=await call(u,'/draft',{revision:u.revision,answers:u.answers,heardSeconds:Math.min(tick*5,u.access.duration),cacheState:'saved'});assert.equal(draft.status,200);
        assert.deepEqual(draft.body.session.answers,u.answers);assert.equal(draft.body.session.revision,u.revision);
        if(tick%3===0||tick===ticks){u.checkRevision++;u.lastReport=report(u);assert.equal((await call(u,'/checks',{revision:u.checkRevision,report:u.lastReport})).status,200);}
        if(tick===Math.ceil(ticks/2)){
          const restored=await call(u,'/session',{},[200],'reload-reauth');assert.equal(restored.status,200);assert.deepEqual(restored.body.session.answers,u.answers);
          const access=await call(u,'/audio-access',{},[200],'reload-cached-access');assert.equal(access.body.audioKey,u.access.audioKey);
        }
      }));
    }
    await Promise.all(students.map(async u=>{
      // HTTP runner không có tai nghe: lưu xác nhận nghe=false; browser xác nhận ở luồng riêng.
      const submit={revision:u.revision,heardConfirmed:false};
      const first=await call(u,'/submit',submit);assert.equal(first.status,200);
      const repeated=await call(u,'/submit',submit,[200],'listening-submit-retry');assert.equal(repeated.body.session.submittedAt,first.body.session.submittedAt);
      assert.equal((await call(u,'/draft',{revision:u.revision+1,answers:{1:'late'},heardSeconds:0,cacheState:'saved'},[409],'draft-after-submit')).body.error,'READINESS_ALREADY_SUBMITTED');
      for(const skill of ['reading','writing']){
        const data=skill==='reading'?{'1':`HV ${u.index}`,'2':'practice'}:{text:`Bài làm quen riêng của học viên ${u.index}. Không phải đề thi thật.`};u[skill]=data;
        const route='/practice/'+skill;
        assert.equal((await call(u,route+'/draft',{revision:1,data})).status,200);
        assert.equal((await call(u,route+'/draft',{revision:2,data})).status,200);
        const stale=await call(u,route+'/draft',{revision:1,data:skill==='reading'?{'1':'old'}:{text:'old'}},[200],skill+'-stale-draft');assert.deepEqual(stale.body.session.practice[skill].data,data);
        const submitted=await call(u,route+'/submit',{revision:2});assert.equal(submitted.status,200);
        const duplicate=await call(u,route+'/submit',{revision:2},[200],skill+'-submit-retry');assert.equal(duplicate.body.session.practice[skill].submittedAt,submitted.body.session.practice[skill].submittedAt);
      }
      const restored=await call(u,'/session',{},[200],'results-reload');assert.equal(restored.status,200);
      for(const skill of ['reading','writing'])assert.deepEqual(restored.body.session.practice[skill].data,u[skill]);
    }));
    // Kết thúc hành trình bình thường trước pha flood: mở roster mới khi IP đã bị
    // giới hạn phải bị chặn, còn phiên xác minh vẫn đọc được; không đánh tráo hai kỳ vọng.
    if(browser){const browserResult=await browser.done;await writeFile(path.join(out,'browser-under-load.log'),browserResult.log,'utf8');assert.equal(browserResult.code,0,'Luồng trình duyệt dưới tải thất bại.');}
    // Hết hạn mức IP do token lạ không được khóa các phiên hợp lệ đã xác minh.
    let rejected=0;
    for(let i=0;i<650;i++){
      const r=await call(null,'/session',{token:'k67r1_'+randomBytes(32).toString('base64url')},[401,429],'unknown-token-flood');if(r.status===429)rejected++;
    }
    assert.ok(rejected>0,'Limiter IP phải chặn flood.');
    await Promise.all(students.map(async u=>assert.equal((await call(u,'/session',{},[200],'valid-session-during-ip-limit')).status,200)));
    const inspected=await rpc('inspect'),rows=new Map(inspected.proof.sessions.map(r=>[r.id,r]));
    for(const u of students){
      const row=rows.get(u.requestId);assert.ok(row);assert.equal(row.student_ref,u.studentRef);assert.deepEqual(row.answers,u.answers);assert.equal(Number(row.draft_revision),u.revision);assert.ok(row.submitted_at);assert.equal(row.heard_confirmed,false);assert.equal(Number(row.check_revision),u.checkRevision);assert.deepEqual(row.check_report,u.lastReport);
      for(const skill of ['reading','writing']){assert.deepEqual(row[skill+'_draft'],u[skill]);assert.equal(Number(row[skill+'_revision']),2);assert.ok(row[skill+'_submitted_at']);}
    }
    assert.equal(inspected.proof.examSessions,0);assert.equal(inspected.proof.examAttempts,0);
    assert.equal(inspected.proof.sessions.length,usersCount+(browser?2:0),'Không sinh phiên trùng.');
    const groups={};for(const label of new Set(records.map(r=>r.label))){const a=records.filter(r=>r.label===label);groups[label]={count:a.length,statuses:Object.fromEntries([...new Set(a.map(r=>r.status))].map(s=>[s,a.filter(r=>r.status===s).length])),p50Ms:q(a.map(r=>r.ms),.5),p95Ms:q(a.map(r=>r.ms),.95),p99Ms:q(a.map(r=>r.ms),.99),maxMs:Math.max(...a.map(r=>r.ms)),unexpected:a.filter(r=>!r.expected).length};}
    const result={at:new Date().toISOString(),outcome:records.every(r=>r.expected)?'passed':'failed',users:usersCount,browserExtra:browser?2:0,sharedActualIp:'127.0.0.1',durationMs:performance.now()-began,requests:records.length,unexpected:records.filter(r=>!r.expected).length,groups,metrics:inspected.metrics,clientTickLagMs:tickLagMs,readbackRows:students.length,examSessions:0,examAttempts:0,unknownTokensLimited:rejected,records,productionChanged:false,limitations:['Loopback, không đo Wi-Fi/Nginx/TLS hoặc tài nguyên VPS.','HTTP tiến độ mô phỏng, heardConfirmed=false; không phải nghiệm thu tai nghe.'],runtime:{poolMax:5,connectionTimeoutMs:5000,statementTimeoutMs:15000,contextRefreshMs:30000,node:process.version,cpuCount:os.cpus().length,totalMemoryGiB:os.totalmem()/1073741824},source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),runnerSha256:sha(await readFile(here))};
    await writeFile(path.join(out,'load-result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify({...result,records:undefined}));if(result.outcome!=='passed')process.exitCode=1;
  }catch(error){
    await writeFile(path.join(out,'load-failure.json'),JSON.stringify({at:new Date().toISOString(),error:error.stack,records,productionChanged:false},null,2),'utf8');throw error;
  }finally{
    if(browser&&browser.exitCode===null)browser.kill();await writeFile(path.join(out,'server.log'),childLog,'utf8');
    if(child.connected){const exited=once(child,'exit');await rpc('close');await exited;}else assert.fail('Fixture kết thúc trước cleanup.');
  }
}
try{if(args.includes('--server'))await server();else await main();}catch(error){console.error(error);process.exitCode=2;}
