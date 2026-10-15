import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createDecipheriv} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createNativeOrderFixture} from '../test/helpers/native-exam-order-fixture.js';
import {createApp} from '../src/app.js';
import {createDatabasePool} from '../src/db.js';
import {createTermTestAssetService} from '../src/term-test-assets.js';

// Chỉ kiểm HTTP/SQL/crypto trên loopback và DB giả mới. Không SSH, không Portal/n8n.
// Mỗi profile là server riêng để cửa sổ quota không lẫn nhau; không tắt limiter để đo.
// Lỗi nghiệp vụ/quota giữ nguyên trong báo cáo; runner không đổi lỗi thành pass.
const here=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(here),'..');
const slugs=['term-test-1','term-test-2','mini-test-lesson-5'];
const args=process.argv.slice(2),outIndex=args.indexOf('--output');
const out=outIndex>=0?path.resolve(args[outIndex+1]):null;
const wait=ms=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
const quantile=(values,q)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*q)-1)]:null;
const ensure=()=>{assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM,'local-synthetic-20261014');assert.equal(process.env.K67_ORDER_NATIVE_URL,'postgres://k67_fixture_admin@127.0.0.1:55468/postgres');};

async function server(){
  ensure();const n=Number(process.env.K67_LOAD_USERS);assert.ok(Number.isInteger(n)&&n>=1&&n<=120);
  const f=await createNativeOrderFixture({examOrder:true});
  const database=(await f.db.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(database,/^term_mini_k67_test_order_[a-f0-9]{12}$/);
  const pool=createDatabasePool({databaseUrl:`postgres://k67_app@127.0.0.1:55468/${database}`,dbPoolMax:5});
  const poolErrors={},seen=new WeakSet(),note=error=>{if(!error||seen.has(error))return;seen.add(error);const key=error.code||String(error.message).slice(0,120);poolErrors[key]=(poolErrors[key]||0)+1;};
  const connect=pool.connect.bind(pool);pool.connect=(...args)=>{
    if(typeof args[0]==='function'){const callback=args[0];return connect((error,...rest)=>{if(error)note(error);callback(error,...rest);});}
    return connect(...args).catch(error=>{note(error);throw error;});
  };
  const users=[];
  for(let i=0;i<n;i++){
    const group=Math.floor(i/25),classCode='IC'+(9900+group),classId=199000+group,studentId=990000+i,studentRef=randomUUID();
    await f.db.query('INSERT INTO mapping.classroom_course_mapping VALUES($1,$2) ON CONFLICT DO NOTHING',[classId,classCode]);
    await f.db.query('INSERT INTO mapping.student_mapping_review VALUES($1,$2,$3,$4,\'approved\')',[studentRef,classId,studentId,'Học viên giả '+i]);
    users.push({classCode,studentRef,slug:slugs[i%slugs.length]});
  }
  for(const slug of slugs.slice(0,2))await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
  const assets=createTermTestAssetService({assetDir:process.env.K67_LOAD_ASSETS,sessionSecret:randomBytes(40).toString('hex')});
  const errors={};const logger={info(){},warn(){},error(value){const code=typeof value==='object'?(value.code||value.name||'error'):'error';errors[code]=(errors[code]||0)+1;}};
  const app=createApp({pool,termTestAssetService:assets,logger,config:{readFirstNewEnabled:true,audioIncidentEnabled:true,audioCacheEnabled:true,audioOwnerEnabled:true,trustProxyHops:1,allowedOrigins:new Set(),authMode:'legacy',legacyReviewToken:'load-fixture-only'}});
  const http=app.listen(0,'127.0.0.1');await once(http,'listening');
  const lag=monitorEventLoopDelay({resolution:10});lag.enable();const cpu=process.cpuUsage();
  let peakRss=0,peakWaiters=0,peakConnections=0,closing=false;
  const sample=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);peakWaiters=Math.max(peakWaiters,pool.waitingCount);peakConnections=Math.max(peakConnections,pool.totalCount);},100);
  const refresh=setInterval(()=>f.db.query('UPDATE mapping.k67_context_state SET captured_at=clock_timestamp()').catch(()=>{}),30000);
  async function close(){if(closing)return;closing=true;clearInterval(sample);clearInterval(refresh);lag.disable();http.closeAllConnections();await new Promise(r=>http.close(r));await pool.end();await f.db.close();}
  const safety=setTimeout(()=>close().finally(()=>process.exit(2)),240000);
  process.on('message',async message=>{
    try{
      if(message.action==='inspect'){
        const rows=(await f.db.query(`SELECT id::text AS id,listening_started_at,listening_draft,listening_draft_revision,listening_audio_incident_id,
          listening_recovery_seconds,listening_submitted_at,audio_owner_epoch FROM assessment.term_test_exam_session`)).rows;
        process.send({id:message.id,rows,metrics:{peakRssMiB:peakRss/1048576,peakWaiters,peakConnections,eventLoopP99Ms:lag.percentile(99)/1e6,cpu:process.cpuUsage(cpu),errors,poolErrors}});
      }else if(message.action==='close'){clearTimeout(safety);await close();process.send({id:message.id,closed:true});process.disconnect();}
    }catch(error){process.send({id:message.id,error:error.code||error.message});}
  });
  process.on('disconnect',()=>close().catch(()=>{}));
  process.send({ready:true,base:`http://127.0.0.1:${http.address().port}`,users,database,poolMax:5});
}

async function runProfile(profile,assetDir,assetHash,assetBytes){
  const child=fork(here,['--server'],{cwd:root,windowsHide:true,env:{...process.env,K67_LOAD_USERS:String(profile.users),K67_LOAD_ASSETS:assetDir},stdio:['ignore','pipe','pipe','ipc']});
  let childLog='';child.stdout.on('data',d=>childLog+=d);child.stderr.on('data',d=>childLog+=d);
  let ready;
  try{
    ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture chưa ready trong 30 giây: '+childLog)),30000);
      child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exit '+code+': '+childLog));});child.once('error',reject);});assert.equal(ready.ready,true);
  }catch(error){await writeFile(path.join(out,profile.id+'-setup-failed.log'),childLog,'utf8');child.kill();throw error;}
  const rpc=action=>new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{child.off('message',on);reject(new Error('RPC timeout'));},15000);const on=m=>{if(m.id!==id)return;clearTimeout(timer);child.off('message',on);m.error?reject(new Error(m.error)):resolve(m);};child.on('message',on);child.send({id,action});});
  const records=[],startAt=performance.now();let maxTickLagMs=0;
  async function call(user,suffix,data={},expected=[200],label=suffix){
    const began=performance.now();let status=0,body={},error;
    try{
      const response=await fetch(ready.base+'/api/term-tests/'+user.slug+'/'+suffix,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':profile.sharedIp?'198.18.0.1':`198.18.${Math.floor(user.index/250)}.${user.index%250+1}`},body:JSON.stringify({orderClientVersion:1,...user.fields,...data}),signal:AbortSignal.timeout(suffix==='session/start'?30000:2500)});
      status=response.status;body=await response.json();error=body.error;
    }catch(e){error=e.name;}
    const record={label,status,ms:performance.now()-began,expected:expected.includes(status),error};records.push(record);return{status,body,record};
  }
  const users=ready.users.map((u,index)=>({...u,index,fields:{ownerId:randomUUID(),ownerProof:randomBytes(32).toString('hex'),pageId:randomUUID(),ownerEpoch:0,generation:0},revision:0,lastSavedRevision:0}));
  let inspected;
  try{
    await Promise.all(users.map(async u=>{
      const p=await call(u,'session/prepare',{classCode:u.classCode,studentRef:u.studentRef,examMode:'lis_first',examDelivery:'cbt'},[200,201]);
      if(![200,201].includes(p.status))return;u.fields.examSessionToken=p.body.examSessionToken;u.fields.generation=p.body.generation;
      const claim=await call(u,'session/audio-owner',{action:'claim'});if(claim.status!==200)return;u.fields.ownerEpoch=claim.body.ownerEpoch;
      if(profile.startGuard){
        const began=performance.now();let status=0,okay=false,error;
        try{
          const response=await fetch(ready.base+`/api/term-tests/${u.slug}/session/${u.fields.examSessionToken}/preview`,{
            headers:{'X-Forwarded-For':profile.sharedIp?'198.18.0.1':`198.18.${Math.floor(u.index/250)}.${u.index%250+1}`},signal:AbortSignal.timeout(2500)});
          status=response.status;okay=response.ok&&(await response.arrayBuffer()).byteLength===4096;
        }catch(e){error=e.name;}
        records.push({label:'preflight-preview',status,ms:performance.now()-began,expected:okay,error});if(!okay)return;
      }
      const started=await call(u,'session/start',{audioProtocolVersion:1,...(profile.startGuard?{audioStartGuardVersion:1}:{}),audioEventId:randomUUID()});if(started.status!==200)return;
      if(profile.startGuard){
        // Client mới chỉ mở bài sau khi xác nhận player tiến; giữ lại mọi lỗi handshake trong thống kê.
        if(!started.body.activeIncident?.startup){started.record.expected=false;return;}
        const incidentId=started.body.activeIncident.incidentId,resumeAttemptId=randomUUID(),anchor=started.body.activeIncident.anchorSeconds;
        const prepared=await call(u,'session/audio-resume',{incidentId,resumeAttemptId,eventId:randomUUID(),phase:'prepare',heardSeconds:anchor},[200],'startup-prepare');if(prepared.status!==200)return;
        await wait(150);
        const confirmed=await call(u,'session/audio-resume',{incidentId,resumeAttemptId,eventId:randomUUID(),phase:'confirm',heardSeconds:anchor+.1},[200],'startup-confirm');
        if(confirmed.status!==200||confirmed.body.activeIncident){confirmed.record.expected=false;return;}
      }
      u.key=started.body.audioKey;u.active=true;
    }));
    // Pacing mở theo thời gian thực: 5 giây/mốc, 15 giây/nháp; không nén 1 phút thành 1 giây.
    const steady=performance.now();
    for(let tick=1;tick<=(profile.ticks??13);tick++){
      await wait(steady+tick*5000-performance.now());maxTickLagMs=Math.max(maxTickLagMs,performance.now()-(steady+tick*5000));
      await Promise.all(users.filter(u=>u.active).map(async u=>{
        u.heard=tick*5;await call(u,'session/audio-progress',{heardSeconds:u.heard,state:'playing'});
        if(profile.busyTyping||tick%3===0){u.revision++;const r=await call(u,'listening/draft',{answers:{11:'A'},revision:u.revision});if(r.status===200&&r.body.accepted&&r.body.revision===u.revision)u.lastSavedRevision=u.revision;else if(r.status===200)r.record.expected=false;}
      }));
    }
    if(profile.reconnect)await Promise.all(users.filter(u=>u.active).map(async u=>{
      const stale={...u.fields};u.fields.pageId=randomUUID();
      const claim=await call(u,'session/audio-owner',{action:'claim',reclaim:true},[200],'reconnect-claim');if(claim.status!==200)return;
      u.fields.ownerEpoch=claim.body.ownerEpoch;const access=await call(u,'session/audio-access',{},[200],'reconnect-access');
      u.reconnected=access.body.audioCacheSupported===true&&access.body.audioKey===u.key;
      const rejected=await call(u,'session/audio-progress',{...stale,state:'playing',heardSeconds:0},[409],'stale-owner-after-reconnect');
      u.staleFenced=rejected.body.error==='AUDIO_OWNER_REQUIRED';
    }));
    const probes=users.filter(u=>u.active).slice(0,Math.max(1,Math.ceil(profile.users/5)));
    await Promise.all(probes.map(async u=>{
      const id=randomUUID(),hold=await call(u,'session/audio-incident',{eventId:id,incidentId:id,heardSeconds:u.heard??0,reason:'manual',answers:{11:'A'},draftRevision:++u.revision});
      if(hold.status!==200)return;u.lastSavedRevision=u.revision;
      const blocked=await call(u,'listening',{classCode:u.classCode,studentRef:u.studentRef,draftRevision:u.lastSavedRevision,clientSubmissionId:randomUUID(),answers:{11:'A'}},[409],'submit-held');
      if(blocked.status===409&&blocked.body.error!=='AUDIO_INCIDENT_OPEN')blocked.record.expected=false;
      await wait(1200);const resumeAttemptId=randomUUID();
      const prepared=await call(u,'session/audio-resume',{incidentId:id,resumeAttemptId,eventId:randomUUID(),phase:'prepare',heardSeconds:u.heard??0});if(prepared.status!==200)return;
      await wait(150);const confirmation={incidentId:id,resumeAttemptId,eventId:randomUUID(),phase:'confirm',heardSeconds:Number(hold.body.activeIncident.anchorSeconds)+.1};
      const confirmed=await call(u,'session/audio-resume',confirmation);if(confirmed.status!==200)return;
      u.granted=confirmed.body.listeningRecoverySeconds;
      const duplicate=await call(u,'session/audio-resume',confirmation);u.duplicateStable=duplicate.status===200&&duplicate.body.listeningRecoverySeconds===u.granted;
      const submitted=await call(u,'listening',{classCode:u.classCode,studentRef:u.studentRef,draftRevision:u.lastSavedRevision,clientSubmissionId:randomUUID(),answers:{11:'A'}},[200,201]);u.submitted=[200,201].includes(submitted.status);
    }));
    // Cold download thật và AES-GCM/hash đọc theo luồng; không gom 8 file vào RAM một lúc.
    if(profile.coldDownloads)await Promise.all(users.filter(u=>u.active&&!u.submitted).slice(0,8).map(async u=>{
      const began=performance.now();let okay=false,status=0,bytes=0,error;
      try{
        const response=await fetch(ready.base+`/api/term-tests/${u.slug}/session/${u.fields.examSessionToken}/audio`,{headers:{'X-Forwarded-For':profile.sharedIp?'198.18.0.1':`198.19.0.${u.index+1}`},signal:AbortSignal.timeout(30000)});status=response.status;if(!response.ok)throw new Error('DOWNLOAD_HTTP');
        let head=Buffer.alloc(0),tail=Buffer.alloc(0),decipher;const hash=createHash('sha256');
        for await(const chunk of response.body){let data=Buffer.from(chunk);if(!decipher){head=Buffer.concat([head,data]);if(head.length<17)continue;assert.equal(head.subarray(0,5).toString(),'IZTT1');decipher=createDecipheriv('aes-256-gcm',Buffer.from(u.key,'base64'),head.subarray(5,17));data=head.subarray(17);head=Buffer.alloc(0);}data=Buffer.concat([tail,data]);if(data.length<=16){tail=data;continue;}const plain=decipher.update(data.subarray(0,-16));hash.update(plain);bytes+=plain.length;tail=data.subarray(-16);}
        decipher.setAuthTag(tail);const last=decipher.final();hash.update(last);bytes+=last.length;okay=bytes===assetBytes&&hash.digest('hex')===assetHash;
      }catch(e){error=e.name+':'+e.message;}
      records.push({label:`cold-download-${assetBytes/1048576}MiB`,status,ms:performance.now()-began,expected:okay,error,bytes});
    }));
    inspected=await rpc('inspect');
    const rows=new Map(inspected.rows.map(r=>[r.id,r]));
    const unacknowledgedStarts=users.filter(u=>!u.active&&rows.get(u.fields.examSessionToken)?.listening_started_at).map(u=>({userIndex:u.index,incidentOpen:Boolean(rows.get(u.fields.examSessionToken).listening_audio_incident_id)}));
    const readbackMismatches=users.filter(u=>u.active).flatMap(u=>{const row=rows.get(u.fields.examSessionToken);return row&&Number(row.listening_draft_revision)===u.lastSavedRevision&&(u.lastSavedRevision===0||row.listening_draft['11']==='A')&&(!u.submitted||Boolean(row.listening_submitted_at))?[]:[{userIndex:u.index,expectedRevision:u.lastSavedRevision,actualRevision:row?.listening_draft_revision,submitted:u.submitted??false}];});
    const readback=readbackMismatches.length===0;
    const resumed=probes.filter(u=>u.submitted);
    const invariants={draftReadback:readback,noDoubleCompensation:resumed.every(u=>u.duplicateStable),allProbeSubmissions:resumed.length===probes.length,allStarted:users.every(u=>u.active),noUnprotectedUnacknowledgedStarts:unacknowledgedStarts.every(u=>u.incidentOpen),...(profile.reconnect?{allReconnected:users.every(u=>u.reconnected&&u.staleFenced)}:{})};
    const groups={};for(const label of new Set(records.map(r=>r.label))){const rows=records.filter(r=>r.label===label);groups[label]={count:rows.length,statuses:Object.fromEntries([...new Set(rows.map(r=>r.status))].map(s=>[s,rows.filter(r=>r.status===s).length])),p50Ms:quantile(rows.map(r=>r.ms),.5),p95Ms:quantile(rows.map(r=>r.ms),.95),maxMs:Math.max(...rows.map(r=>r.ms)),unexpected:rows.filter(r=>!r.expected).length};}
    const result={profile,startedAt:new Date(Date.now()-(performance.now()-startAt)).toISOString(),durationMs:performance.now()-startAt,requests:records.length,unexpected:records.filter(r=>!r.expected).length,invariants,unacknowledgedStarts,readbackMismatches,groups,metrics:inspected.metrics,maxTickLagMs,fixtureDatabase:ready.database,realPostgres:true,poolMax:5,unconstrainedLocalCpu:true,records};
    result.outcome=result.unexpected===0&&Object.values(invariants).every(Boolean)?'passed':'failed';
    return result;
  }finally{await writeFile(path.join(out,profile.id+'-server.log'),childLog,'utf8');if(child.connected){await rpc('close');await once(child,'exit');}else assert.fail('Fixture kết thúc trước readback/cleanup');}
}

async function main(){
  ensure();assert.ok(out,'Cần --output trên ổ E');assert.match(out,/^E:[\\/]/i);await mkdir(out,{recursive:true});
  const assetMiB=args.includes('--asset-mib')?Number(args[args.indexOf('--asset-mib')+1]):40;assert.ok([1,40].includes(assetMiB),'Chỉ hỗ trợ đối chứng 1 hoặc 40 MiB');
  const assetDir=path.join(out,'synthetic-assets'),bytes=Buffer.alloc(assetMiB*1048576,0x67),assetHash=createHash('sha256').update(bytes).digest('hex');
  for(const slug of slugs){const dir=path.join(assetDir,slug);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'listening-audio.mp3'),bytes);await writeFile(path.join(dir,'content.json'),JSON.stringify({baseTestSlug:slug,writing:null}),'utf8');await writeFile(path.join(dir,'listening-preview-30s.mp3'),bytes.subarray(0,4096));}
  const profiles=[{id:'25-shared-ip',users:25,sharedIp:true},{id:'60-shared-ip',users:60,sharedIp:true},{id:'60-distinct-ips',users:60,sharedIp:false},{id:'120-distinct-ips',users:120,sharedIp:false,coldDownloads:true},{id:'120-shared-ip',users:120,sharedIp:true,coldDownloads:true}];
  const extra=[{id:'25-busy-typing',users:25,sharedIp:true,busyTyping:true},{id:'60-reconnect-storm',users:60,sharedIp:false,ticks:0,reconnect:true},{id:'120-start-diagnostic',users:120,sharedIp:false,ticks:0}];
  const selected=args.includes('--smoke')?[{id:'smoke',users:3,sharedIp:false}]:args.includes('--extra')?extra:profiles;
  const requested=args.includes('--profile')?args[args.indexOf('--profile')+1]:null,chosen=requested?selected.filter(p=>p.id===requested):selected;assert.ok(chosen.length,'Profile không tồn tại');
  if(args.includes('--start-guard'))for(const profile of chosen)profile.startGuard=true;
  const runnerBytes=await readFile(here);await writeFile(path.join(out,'runner-executed.mjs'),runnerBytes);
  const summary={at:new Date().toISOString(),source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),runnerSha256:createHash('sha256').update(runnerBytes).digest('hex'),assetMiB,node:process.version,host:{platform:process.platform,cpuCount:os.cpus().length,totalMemoryGiB:os.totalmem()/1073741824},basis:'Exploratory envelopes, not actual concurrent class counts. Classes of 25 are synthetic grouping only.',productionChanged:false,profiles:[]};
  for(const profile of chosen){const result=await runProfile(profile,assetDir,assetHash,bytes.length);await writeFile(path.join(out,profile.id+'.json'),JSON.stringify(result,null,2),'utf8');summary.profiles.push({...result,records:undefined});await writeFile(path.join(out,'load-summary.json'),JSON.stringify(summary,null,2),'utf8');console.log(JSON.stringify({id:profile.id,outcome:result.outcome,requests:result.requests,unexpected:result.unexpected,invariants:result.invariants,metrics:result.metrics}));}
  if(summary.profiles.some(r=>r.outcome!=='passed'))process.exitCode=1;
}
try{if(args.includes('--server'))await server();else await main();}catch(error){console.error(error);process.exitCode=2;}
