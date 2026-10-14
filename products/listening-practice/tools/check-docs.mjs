import {readFile,writeFile} from 'node:fs/promises';
import {localPool} from './local-pool.mjs';
import {createListeningService} from '../src/service.js';
import {createDocsWorker,planDocWrite} from '../src/docs.js';
import {gwsDocs} from './gws-docs.mjs';
import {secret,uuid,emptyDraft} from '../src/domain.js';
import assert from 'node:assert/strict';

// Chỉ nhận Doc kiểm thử được truyền rõ. Chạy start → reset → submit → retry; đọc lại từng trạng thái.
const [documentId,contentPath,cliPath,outputPath]=process.argv.slice(2);
if(!documentId||!contentPath||!cliPath||!outputPath)throw new Error('Usage: check-docs.mjs canaryDoc privateContent gwsCli outputJson');
const pool=await localPool(),studentRef=uuid(),entryToken=secret(),member={name:'Học viên kiểm thử',studentRef};
const context={student:async(c,id)=>c==='1124'&&id===studentRef?member:undefined,roster:async()=>[member],teacher:async()=>true};
const service=createListeningService({pool,context,pageBase:'https://tranhoangduc90.github.io/izone-ai-team-pages/listening-practice/',verifyBinding:async input=>({fixtureOnly:true,documentId:input.documentId,studentRef:input.studentRef})});
const content=JSON.parse(await readFile(contentPath,'utf8'));await service.seedContent(content);
const registration=await service.register({classId:'1124',classCode:'KIỂM THỬ',studentRef,entryToken,documentId,tabId:'t.0',contentVersion:content.version});
const docs=gwsDocs(cliPath),worker=createDocsWorker({pool,docs}),checks=[];
async function drain(label){
 await worker.once();const jobs=(await pool.query('SELECT sequence,status,error_code FROM listening_practice.doc_job ORDER BY sequence')).rows;
 assert.equal(jobs.at(-1).status,'verified',JSON.stringify(jobs));checks.push({label,sequence:jobs.at(-1).sequence,status:'verified'});
}
await drain('CTA đúng bản Docs');await pool.query("UPDATE listening_practice.assignment SET status='open'");
const login=await service.login({entryToken,studentRef,classCode:'KIỂM THỬ'}),token=login.token;
const first=await service.begin({token,owner:'canary',operationId:uuid()});await drain('Bắt đầu lần đầu');
const second=await service.reset({token,attemptId:first.attempts.at(-1).id,lease:first.lease,snapshot:emptyDraft(),owner:'canary',operationId:uuid()});await drain('Reset và bắt đầu lần 2');
const input={token,attemptId:second.attempts.at(-1).id,lease:second.lease,snapshot:emptyDraft(),operationId:uuid(),method:'manual'};
const done=await service.submit(input);await drain('Hoàn thành sau 1 reset và link GV');
const replay=await service.submit(input);assert.deepEqual(replay.attempts,done.attempts);assert.equal(replay.events.at(-1).docs,'verified');assert.equal(await worker.once(),false);checks.push({label:'Retry nộp không ghi thêm',status:'verified'});
const b=(await pool.query('SELECT * FROM listening_practice.binding WHERE id=$1',[registration.bindingId])).rows[0];
const job=(await pool.query('SELECT * FROM listening_practice.doc_job ORDER BY sequence DESC LIMIT 1')).rows[0];
const final=await docs.read(documentId);assert.equal(planDocWrite(final,b,job).verified,true);
await writeFile(outputPath,JSON.stringify({status:'passed',documentId,checks,teacherSubmissionId:done.attempts.at(-1).submissionId,finalRevisionId:final.revisionId},null,2),'utf8');
console.log(JSON.stringify({status:'passed',checks:checks.length,realGoogleDocs:true}));await pool.end();
