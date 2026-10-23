// Máy phát tải riêng event loop; chỉ nhận model dữ liệu giả từ process cha qua IPC.
import crypto from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {monitorEventLoopDelay} from 'node:perf_hooks';
if(!process.send)throw Error('Chỉ chạy bằng kho fixture cách ly');
const model=await new Promise(resolve=>{process.once('message',resolve);process.send({kind:'ready'});});
const {classes,targetClasses,studentsPerClass,poolMax}=model,history=[],responsesByStudent=new Map();let running=true,phase='',result=null,sequence=0;
const pool={waitingCount:0};process.on('message',message=>{if(message.kind==='health')pool.waitingCount=message.waiting;});
const replies=new Map();
process.on('message',message=>{if(message.kind==='reply'){const pending=replies.get(message.id);if(!pending)return;replies.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(Error(message.error)):pending.resolve(message.value);}});
function rpc(key){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{replies.delete(id);reject(Error('Không đọc được thống kê API'));},15000);replies.set(id,{resolve,reject,timer});process.send({kind:'rpc',id,key});});}
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
const summary=values=>({count:values.length,p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99),max:values.length?Math.max(...values):null});
const origin=model.origin||'http://127.0.0.1:28798';
if(!['http://127.0.0.1:28798','http://127.0.0.1:7189'].includes(origin))throw Error('Chỉ phát tải vào fixture loopback');
const headers=c=>({'Content-Type':'application/json','X-Forwarded-For':'192.0.2.'+(c.index%3+1),'X-Fixture-Teacher':c.email});
let measurements=null;
async function request(c,path,options={},kind='read'){
  const begin=performance.now(),metrics=measurements;
  try{
    const response=await fetch(origin+path,{headers:headers(c),...options,signal:AbortSignal.timeout(15000)}),body=await response.json();
    if(!response.ok||!body.ok)throw Object.assign(Error(body.message||'HTTP '+response.status),{status:response.status});return body;
  }catch(error){metrics?.errors.push({kind,status:error.status,message:error.message,cause:error.cause?.code});throw error;}
  finally{metrics?.[kind].push(performance.now()-begin);}
}
async function peer(c,tab){
  const id=c.published.assignmentId,controller=new AbortController();let after='0',busy=false,queued=false,debounce=null,stopped=false;
  const name=c.index+':'+tab;
  async function read(force=false){
    if(busy){queued=true;return;}busy=true;
    try{const {update}=await request(c,'/api/learning/teacher/assignments/'+id+'/live-updates?after='+after+'&force='+(force?'1':'0'));
      after=update.revision;
      for(const student of update.live?.students||[]){
        for(const record of responsesByStudent.get(student.studentRef)||[]){
          if(!record.seen.has(name)&&((record.type==='draft'&&Number(student.draftRevision)>=record.revision)||(record.type==='final'&&student.submissionId===record.submissionId)))record.seen.set(name,Date.now());
        }
      }
    }catch(error){if(measurements)measurements.peerErrors.push({status:error.status,message:error.message});}
    finally{busy=false;if(queued&&!stopped){queued=false;debounce=setTimeout(()=>void read(),250);}}
  }
  await read(true);
  const response=await fetch(origin+'/api/learning/teacher/assignments/'+id+'/events',{headers:headers(c),signal:controller.signal});
  if(response.status!==200)throw Error('Không mở stream '+response.status);
  const reader=response.body.getReader();
  void(async()=>{let buffer='';try{while(!stopped){const {value,done}=await reader.read();if(done)break;buffer+=new TextDecoder().decode(value);let end;
    while((end=buffer.indexOf('\n\n'))>=0){const record=buffer.slice(0,end);buffer=buffer.slice(end+2);if(record.startsWith('event: change\n')){
      clearTimeout(debounce);debounce=setTimeout(()=>void read(),250);
    }}
  }}catch(error){if(!stopped&&measurements)measurements.peerErrors.push({message:error.message});}})();
  return {close(){stopped=true;clearTimeout(debounce);controller.abort();}};
}
const responseText='Nội dung giả để kiểm độ trễ và lưu bài. '.repeat(45);
async function writeDraft(c,person,tabs){
  if(person.inFlight)return;person.inFlight=true;
  const revision=++person.revision,record={type:'draft',revision,started:Date.now(),savedAt:null,acked:null,seen:new Map(),expectedTabs:tabs};
  const records=responsesByStudent.get(person.studentRef)||[];records.push(record);responsesByStudent.set(person.studentRef,records);
  const responses=Object.fromEntries(c.assignment.definition.blocks.flatMap(b=>b.items).map(i=>[i.itemVersionId,responseText]));
  try{const body=await request(c,'/api/learning/attempts/draft',{method:'PATCH',body:JSON.stringify({attemptToken:person.attemptToken,revision,definitionHash:person.definitionHash,responses})},'draft');
    record.savedAt=Date.parse(body.draft.savedAt)-(model.serverClockOffsetMs||0);record.acked=Date.now();
  }catch(error){record.failed=true;}finally{person.inFlight=false;}
}
function recordsSummary(records){
  const accepted=records.filter(r=>r.acked&&!r.failed),ackLag=[],dbLag=[];
  for(const r of accepted)for(const time of r.seen.values()){ackLag.push(Math.max(0,time-r.acked));if(Number.isFinite(r.savedAt))dbLag.push(Math.max(0,time-r.savedAt));}
  return {attempted:records.length,accepted:accepted.length,failed:records.filter(r=>r.failed).length,pending:records.filter(r=>!r.failed&&!r.acked).length,
    missing:accepted.filter(r=>r.seen.size<r.expectedTabs).length,ackToTeacherMs:summary(ackLag),dbSavedAtToTeacherMs:summary(dbLag)};
}
async function phaseRun(count,tabs,durationMs){
  phase=`${count} lớp · ${tabs} tab/GV`;process.send({kind:'phase',phase});console.log(JSON.stringify({phase}));responsesByStudent.clear();
  const peers=[];
  try{
  for(const c of classes.slice(0,count))for(let tab=0;tab<tabs;tab++)peers.push(await peer(c,tab));
  const delay=monitorEventLoopDelay({resolution:20});delay.enable();
  measurements={read:[],draft:[],checkpoint:[],final:[],errors:[],peerErrors:[]};const start=performance.now();
  const writes=new Set();let skippedBusy=0;
  const schedule=classes.slice(0,count).flatMap(c=>c.people.map((person,i)=>({c,person,next:start+(i/c.people.length)*10000+Math.random()*200})));
  while(performance.now()-start<durationMs){
    const now=performance.now();for(const job of schedule)if(now>=job.next){job.next+=10000;if(job.person.inFlight){skippedBusy++;continue;}
      const pending=writeDraft(job.c,job.person,tabs);writes.add(pending);void pending.finally(()=>writes.delete(pending));}
    if(pool.waitingCount>500)throw Error('Dừng an toàn: hàng đợi pool vượt 500');await pause(40);
  }
  await Promise.all([...writes]);await pause(4500);
  const records=[...responsesByStudent.values()].flat(),resources=await rpc('resources');
  resources.generatorEventLoopP95Ms=delay.percentile(95)/1e6;
  delay.disable();const observed=recordsSummary(records),metrics=measurements;
  measurements=null;peers.forEach(p=>p.close());await pause(300);
  const report={classes:count,students:count*studentsPerClass,tabsPerTeacher:tabs,durationMs,skippedBusy,requests:{read:summary(metrics.read),draft:summary(metrics.draft)},errors:metrics.errors,peerErrors:metrics.peerErrors,...observed,resources};
  report.ok=!report.errors.length&&!report.peerErrors.length&&!report.missing&&!report.failed&&!report.pending&&!skippedBusy&&report.requests.draft.p95<=1000&&report.dbSavedAtToTeacherMs.p95<=2000;
  history.push(report);process.send({kind:'report',report});console.log(JSON.stringify({phase,report}));
  if(report.errors.length||report.peerErrors.length||report.missing||report.failed||report.pending||skippedBusy)throw Error('Lỗi dữ liệu/kết nối trong kiểm tải: '+phase);
  }finally{measurements=null;peers.forEach(p=>p.close());}
}
async function submissionBurst(count){
  phase=`${count} lớp · nộp trong 30 giây`;process.send({kind:'phase',phase});responsesByStudent.clear();const peers=[];
  try{
    for(const c of classes.slice(0,count))peers.push(await peer(c,0));
    measurements={read:[],draft:[],checkpoint:[],final:[],errors:[],peerErrors:[]};
    const start=performance.now(),jobs=classes.slice(0,count).flatMap(c=>c.people.map((person,i)=>({c,person,delay:(i/c.people.length)*30000+Math.random()*100})));
    await Promise.all(jobs.map(async({c,person,delay})=>{
      await pause(Math.max(0,start+delay-performance.now()));
      const responses=Object.fromEntries(c.assignment.definition.blocks.flatMap(b=>b.items).map(i=>[i.itemVersionId,responseText]));
      try{
        for(const block of c.assignment.definition.blocks)await request(c,'/api/learning/attempts/checkpoints/submit',{method:'POST',body:JSON.stringify({attemptToken:person.attemptToken,
          checkpointSubmissionId:crypto.randomUUID(),blockId:block.blockId,checkpoint:block.checkpoint,draftRevision:person.revision,
          definitionHash:person.definitionHash,responses:Object.fromEntries(block.items.map(i=>[i.itemVersionId,responses[i.itemVersionId]])),idempotencyKey:crypto.randomUUID()})},'checkpoint');
        const submissionId=crypto.randomUUID(),record={type:'final',submissionId,started:Date.now(),acked:null,savedAt:null,seen:new Map(),expectedTabs:1};
        const records=responsesByStudent.get(person.studentRef)||[];records.push(record);responsesByStudent.set(person.studentRef,records);
        const body=await request(c,'/api/learning/attempts/submit',{method:'POST',body:JSON.stringify({attemptToken:person.attemptToken,submissionId,
          definitionHash:person.definitionHash,draftRevision:person.revision,responses})},'final');record.acked=Date.now();record.savedAt=Date.parse(body.receipt.receivedAt)-(model.serverClockOffsetMs||0);
      }catch(error){measurements.peerErrors.push({status:error.status,message:error.message});}
    }));
    await pause(4500);const observed=recordsSummary([...responsesByStudent.values()].flat());
    const verified=await rpc('counts'),resources=await rpc('resources');
    const report={classes:count,students:count*studentsPerClass,requests:{checkpoint:summary(measurements.checkpoint),final:summary(measurements.final),read:summary(measurements.read)},
      ...observed,verified,resources,errors:measurements.errors,peerErrors:measurements.peerErrors};
    report.ok=!report.errors.length&&!report.peerErrors.length&&!report.missing&&verified.submissions===count*studentsPerClass&&verified.attendance===count*studentsPerClass&&
      verified.attendance_events===count*studentsPerClass&&verified.portal_jobs===count*studentsPerClass&&report.requests.checkpoint.p95<=2000&&report.requests.final.p95<=2000&&report.ackToTeacherMs.p95<=2000;
    history.push(report);process.send({kind:'report',report});console.log(JSON.stringify({phase,report}));
  }finally{measurements=null;peers.forEach(p=>p.close());}
}
async function run(){
  try{
    if(!model.onlySubmissionBurst){await phaseRun(10,1,12000);await phaseRun(targetClasses,1,30000);await phaseRun(targetClasses,2,15000);}
    await submissionBurst(targetClasses);
    result={ok:history.every(report=>report.ok),history,notes:['Dữ liệu giả; '+studentsPerClass+' học viên/lớp; ba địa chỉ NAT giả; PostgreSQL riêng.',(model.origin?'API trên VPS; máy phát tải ở máy khác.':'API và máy phát tải khác process trong cùng container.')+' API giới hạn2CPU/2GiB; PG2CPU/768MiB, pool ứng dụng '+poolMax+'.','Đã gồm truy vấn xác minh/gia hạn phiên với cookie giả và 90/365 ngày; không gọi Google/broker thật.','Độ trễ DB dùng savedAt trước commit, là mốc bao gồm cả thời gian còn lại của transaction; peer nhận JSON, chưa thay kiểm browser vẽ màn.','Đã đối chiếu bài nộp/điểm danh/hàng chờ trong kho giả; không chạy consumer ghi Portal.']};phase=result.ok?'Đã đo tải nháp và nộp':'Đã đo · còn ngưỡng chưa đạt';
    if(model.onlySubmissionBurst)result.notes.push('Chỉ chẩn đoán nộp dồn; không thay lượt kiểm đủ các pha.');
    if(model.origin){result.notes.push('Máy phát tải nằm trên máy khác qua đường SSH loopback; độ trễ HTTP đã gồm mạng. Offset đồng hồ đã đo: '+model.serverClockOffsetMs+'ms.');}
    else await writeFile('/tmp/v21-load-result.json',JSON.stringify(result,null,2));
  }finally{running=false;measurements=null;}
}

void run().then(()=>process.send({kind:'complete',result},()=>process.exit(result.ok?0:1))).catch(error=>process.send({kind:'complete',result:{ok:false,error:error.stack,history}},()=>process.exit(1)));
