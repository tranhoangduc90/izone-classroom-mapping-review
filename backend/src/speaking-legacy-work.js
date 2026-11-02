import {createSpeakingHomeworkService} from './speaking-homework.js';
import {runSpeakingCheckJob} from './speaking-check-worker.js';
import {runSpeakingDoctorJob} from './speaking-doctor-worker.js';
import {runPracticeCheckJob,runPracticeAnalysisJob} from './speaking-practice-worker.js';
import {createDurableWorkLoop,announceCommittedWork} from './test-work-runtime.js';

const capacities=Object.freeze({check:4,doctor:2,practice:1,grade:1});

// One admission loop/transaction serves every legacy AI queue, with native per-lane caps.
// Actual handlers remain independent; the one admission slot is never held across AI I/O.
export function startSpeakingLegacyWorker({pool,service,enabled=true,pollMs=5000,dependencies={},loopOptions={},onError=()=>{}}){
 if(!enabled||(!pool&&!service))return{async stop(){},wake(){},snapshot:()=>({closed:true,running:{check:0,doctor:0,practice:0,grade:0}})};
 service??=createSpeakingHomeworkService({pool});
 const running={check:0,doctor:0,practice:0,grade:0},active=new Set(),stats={started:0,completed:0,errors:0};
 let practiceAnalysisFirst=false,closing;
 const report=error=>{stats.errors++;try{onError(error);}catch{}};
 async function run(job){
  if(dependencies.handlers?.[job.lane])return dependencies.handlers[job.lane](service,job);
  if(job.lane==='check')return runSpeakingCheckJob(service,job,dependencies.check);
  if(job.lane==='doctor')return runSpeakingDoctorJob(service,job,dependencies.doctor);
  if(job.lane==='practice')return job.work_kind==='practice_check'?runPracticeCheckJob(service,job,dependencies.practice):runPracticeAnalysisJob(service,job,dependencies.doctor);
  try{return await service.completeGradeJob(job.job_id);}
  catch(error){report(error);return service.failOutboxJob({jobId:job.job_id,errorCode:'GRADE_ERROR'});}
 }
 const loop=createDurableWorkLoop({...loopOptions,capacity:1,scanMs:pollMs,onError:report,
  async claim(){
   const free=Object.fromEntries(Object.entries(capacities).map(([lane,max])=>[lane,max-running[lane]]));
   if(!Object.values(free).some(Boolean))return[];
   const jobs=await service.claimWorkerJobs(free,{practiceAnalysisFirst});
   if(!Array.isArray(jobs))throw new Error('SPEAKING_WORK_BATCH_INVALID');
   const selected={check:0,doctor:0,practice:0,grade:0},ids=new Set();
   for(const job of jobs){
    if(!job||!Object.hasOwn(capacities,job.lane)||typeof job.job_id!=='string'
      ||(job.lane==='practice'&&!['practice_check','practice_analysis'].includes(job.work_kind)))throw new Error('SPEAKING_WORK_BATCH_INVALID');
    const key=job.lane+':'+(job.work_kind||'')+':'+job.job_id;
    if(ids.has(key)||++selected[job.lane]>free[job.lane])throw new Error('SPEAKING_WORK_BATCH_CAPACITY_INVALID');ids.add(key);
   }
   return jobs.length?[jobs]:[];
  },
  run(jobs){
   for(const job of jobs){
    running[job.lane]++;stats.started++;
    if(job.lane==='practice')practiceAnalysisFirst=job.work_kind==='practice_check';
    const task=Promise.resolve().then(()=>run(job)).catch(report).finally(()=>{
     running[job.lane]--;stats.completed++;active.delete(task);announceCommittedWork(pool,'state');loop.wake();
    });active.add(task);
   }
  }});
 return{wake:()=>loop.wake(),snapshot:()=>({...stats,closed:loop.snapshot().closed,running:{...running}}),
  stop(){return closing??=(async()=>{await loop.close();await Promise.all([...active]);})();}};
}
