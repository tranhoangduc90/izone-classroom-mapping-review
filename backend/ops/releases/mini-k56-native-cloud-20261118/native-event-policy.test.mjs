import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
assert.ok(process.env.MINI_NATIVE_JOURNAL_ROOT,'Use the isolated staged journal runtime');
const {projectMiniK56CbtNativeEvent,checkMiniK56CbtNativeEvent}=await import(pathToFileURL(process.env.MINI_NATIVE_JOURNAL_ROOT+'/adapters/mini-k56-cbt-native/native-event-policy.mjs'));
const scope={product:'term-mini-k56',testSlug:'mini-test-k56',classCode:'FIXTURE',generation:0};
const wrap=(type,data)=>({id:randomUUID(),pageVisitId:randomUUID(),sequence:1,source:'server',type,data,build:'mini-native-fixture'});
test('Mini native policy keeps report status and Task2 job metadata without answer content',()=>{
 const incidentId=randomUUID(),jobId=randomUUID();
 const report=projectMiniK56CbtNativeEvent('decision_made',{action:'mini_listening_report',answers:{'1':'Never copied'},checkpointState:{
  mini_k56OfflineVersion:1,miniListeningReportVersion:1,incidentId,mode:'offline',phase:'enqueue',reportStatus:'open'}},0);
 assert.equal(report.answers,undefined);assert.equal(report.checkpointState.incidentId,incidentId);
 assert.equal(report.checkpointState.reportStatus,'open');checkMiniK56CbtNativeEvent(wrap('decision_made',report),scope);
 const job=projectMiniK56CbtNativeEvent('job_queued',{jobId,task:2,checkpointState:{submissionOperationId:randomUUID(),submissionReceiptId:randomUUID()}},0);
 assert.equal(job.task,2);assert.equal(job.jobId,jobId);checkMiniK56CbtNativeEvent(wrap('job_queued',job),scope);
 for(const suffix of ['attempt/prepare','listening/report'])assert.ok(projectMiniK56CbtNativeEvent('request_completed',{
  requestId:randomUUID(),method:'POST',route:'/api/term-tests/mini-test-k56/'+suffix,status:200},0));
});
test('Mini native policy rejects another Task, delivery, scope and unapproved metadata',()=>{
 const jobId=randomUUID();assert.equal(projectMiniK56CbtNativeEvent('job_queued',{jobId,task:1},0),null);
 const data=projectMiniK56CbtNativeEvent('job_queued',{jobId,task:2},0);
 assert.throws(()=>checkMiniK56CbtNativeEvent(wrap('job_queued',{...data,task:1}),scope),/PILOT_NATIVE_EVENT_DENIED/);
 assert.throws(()=>checkMiniK56CbtNativeEvent(wrap('job_queued',data),{...scope,testSlug:'term-test-1-k56'}),/PILOT_NATIVE_EVENT_DENIED/);
 assert.throws(()=>checkMiniK56CbtNativeEvent(wrap('job_queued',{...data,checkpointState:{...data.checkpointState,delivery:'answer_sheet'}}),scope),/PILOT_NATIVE_EVENT_DENIED/);
 assert.throws(()=>checkMiniK56CbtNativeEvent(wrap('job_queued',{...data,rawAnswers:{'1':'Rejected'}}),scope),/PILOT_NATIVE_EVENT_DENIED/);
});
