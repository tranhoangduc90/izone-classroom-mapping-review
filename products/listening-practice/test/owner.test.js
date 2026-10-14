import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerVerifier} from '../src/owner.js';
import {CODE,hash,uuid} from '../src/domain.js';
import {CTA} from '../src/docs.js';

test('binding từ Classroom: UUID đúng nhưng Doc hoặc Google user khác bị từ chối trước đăng ký',async()=>{
 const now=Date.now(),studentRef=uuid(),input={classId:'1124',studentRef,courseId:'course1',courseWorkId:'work1',submissionId:'sub1',documentId:'doc1',tabId:'t.0'};
 const payload={apiVersion:1,classId:'1124',studentRef,courseId:'course1',googleUserId:'google1'};
 let owner={...payload,capturedAt:new Date(now).toISOString(),sourceRevision:hash(JSON.stringify(payload))};
 let submission={id:'sub1',courseId:'course1',courseWorkId:'work1',userId:'google1',assignmentSubmission:{attachments:[{driveFile:{id:'doc1'}}]}};
 const text=CODE+'\n'+CTA+'\n',document={documentId:'doc1',revisionId:'rev',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[{paragraph:{elements:[{startIndex:1,endIndex:1+text.length,textRun:{content:text}}]}}]}}}]};
 const verifier=createOwnerVerifier({url:'https://owner.test',key:'private-key',clock:()=>now,auth:{getAccessToken:async()=>({token:'private-access'})},docs:{read:async()=>document},fetcher:async url=>new Response(JSON.stringify(url.startsWith('https://owner.test')?owner:submission))});
 assert.equal((await verifier(input)).googleUserId,'google1');
 submission.userId='google2';await assert.rejects(verifier(input),e=>e.code==='DOCUMENT_OWNER_MISMATCH');
 submission.userId='google1';submission.assignmentSubmission.attachments=[{driveFile:{id:'doc2'}}];await assert.rejects(verifier(input),e=>e.code==='DOCUMENT_OWNER_MISMATCH');
 owner.capturedAt=new Date(now-121000).toISOString();await assert.rejects(verifier(input),e=>e.code==='OWNER_MISMATCH');
 await assert.rejects(verifier({...input,submissionId:undefined}),e=>e.code==='OWNER_PROOF_REQUIRED');
});
