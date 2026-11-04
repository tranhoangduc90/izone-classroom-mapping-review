import assert from 'node:assert/strict';
import test from 'node:test';
import {createPendingPublisher,verifyClassroomCopy} from '../../reading-practice/src/cta-confirmation-client.js';

const event={doc_id:'fixture-genuine-document-0001',classroom_course_id:'7100',
  coursework_id:'7200',submission_id:'sub-42',student_id:'9000',class_name:'IC2353'};

test('Classroom proof checks the published assignment, Google account and unique non-template attachment',async()=>{
  let assignment={id:'7200',courseId:'7100',state:'PUBLISHED',materials:[{
    driveFile:{shareMode:'STUDENT_COPY',driveFile:{id:'fixture-template-document'}},
  }]};
  let copy={id:'sub-42',courseId:'7100',courseWorkId:'7200',userId:'9000',
    assignmentSubmission:{attachments:[{driveFile:{id:event.doc_id}}]}};
  const verify=verifyClassroomCopy({getAccessToken:async()=>({token:'fixture'})},{fetcher:async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer fixture');
    assert.equal(new URL(url).origin,'https://classroom.googleapis.com');
    return Response.json(url.endsWith('/studentSubmissions/sub-42')?copy:assignment);
  }});
  await verify(event);
  await assert.rejects(verify({...event,student_id:'9001'}),/CLASSROOM_COPY_NOT_VERIFIED/);
  copy={...copy,assignmentSubmission:{attachments:[{driveFile:{id:event.doc_id}},{driveFile:{id:event.doc_id}}]}};
  await assert.rejects(verify(event),/CLASSROOM_COPY_NOT_VERIFIED/);
  copy={...copy,assignmentSubmission:{attachments:[{driveFile:{id:event.doc_id}}]}};
  assignment={...assignment,state:'DRAFT'};
  await assert.rejects(verify(event),/CLASSROOM_COPY_NOT_VERIFIED/);
});

test('Native CTA only activates after the correct hyperlink is read back and retry keeps one revision write',async()=>{
  const id='8a73a13a-14f2-4207-98a4-d52733783810';
  const url='https://tranhoangduc90.github.io/izone-ai-team-pages/classroom-confirmation/#'+id;
  let saved={documentId:event.doc_id,revisionId:'r1'};
  let writes=0;
  let activates=0;
  let ignoreWrite=true;
  const docs={async read(documentId){assert.equal(documentId,event.doc_id);return saved;},
    async write(documentId,plan){
      assert.equal(documentId,event.doc_id);assert.equal(plan.revisionId,saved.revisionId);
      writes++;
      if(!ignoreWrite)saved={...saved,link:plan.link,revisionId:'r2'};
    }};
  const publish=createPendingPublisher({product:'reading-practice',base:'http://fixture.invalid',key:'k'.repeat(40),docs,
    planWrite:(doc,binding,job)=>{assert.equal(binding.document_id,event.doc_id);return {
      revisionId:doc.revisionId,link:job.payload.url,verified:doc.link===job.payload.url,
    };},fetcher:async(endpoint,options)=>{
      const data=JSON.parse(options.body);
      assert.equal(data.product,'reading-practice');
      if(endpoint.endsWith('/prepare')) {
        assert.equal(data.submissionId,event.submission_id);
        return Response.json({ok:true,id,entryUrl:url});
      }
      assert.equal(data.id,id);activates++;
      return Response.json({ok:true});
    }});
  const options={event,document:saved,binding:{document_id:event.doc_id,tab_id:'t.0',code:'67-reading-fixture'},
    fallbackUrl:'https://tranhoangduc90.github.io/izone-ai-team-pages/reading-practice/?lesson=67-reading-fixture&mode=student&class=IC2353'};
  await assert.rejects(publish(options),/CTA_CONFIRMATION_READBACK_FAILED/);
  assert.equal(activates,0);
  ignoreWrite=false;
  assert.equal((await publish(options)).entryUrl,url);
  assert.equal(activates,1);
  await publish({...options,document:saved});
  assert.equal(writes,2);
  assert.equal(activates,2);
});
