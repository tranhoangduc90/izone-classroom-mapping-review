import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedHomeworkResolver} from '../src/shared-homework.js';
import {ROBOTS_CODE} from '../src/lessons.js';
import {hash,uuid} from '../src/domain.js';
import {CTA} from '../src/docs.js';
import {registerAuthoredLesson} from '../src/authored-content.js';

// Dữ liệu giả cố ý trùng tên; nguồn ghi luôn được chọn theo UUID, Google user và submission.
function setup(){
 const now=Date.now(),binding={class_id:'1293',student_ref:uuid(),code:ROBOTS_CODE,owner_proof:{mode:'shared'}};
 const base={apiVersion:1,classId:'1293',studentRef:binding.student_ref,courseId:'course1',googleUserId:'user1'};
 const owner={...base,capturedAt:new Date(now).toISOString(),sourceRevision:hash(JSON.stringify(base))};
 const work={id:'work1',courseId:'course1',title:'Homework Lesson 9',materials:[{driveFile:{shareMode:'STUDENT_COPY',driveFile:{id:'template'}}}]};
 const submission={id:'sub1',courseId:'course1',courseWorkId:'work1',userId:'user1',assignmentSubmission:{attachments:[{driveFile:{id:'doc1'}}]}};
 const code=ROBOTS_CODE+'\n'+CTA+'\n',document={documentId:'doc1',revisionId:'revision1',tabs:[{tabProperties:{tabId:'parent'},childTabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[{paragraph:{elements:[{startIndex:1,endIndex:code.length+1,textRun:{content:code}}]}}]}}}]}]};
 const state={works:[work],submission,document,owner,requests:[],pages:false};
 const resolver=createSharedHomeworkResolver({url:'https://owner.test',key:'private-fixture',clock:()=>now,auth:{getAccessToken:async()=>({token:'fixture'})},docs:{read:async()=>state.document},fetcher:async value=>{
  const u=new URL(value);state.requests.push(u);
  if(u.origin==='https://owner.test')return Response.json(state.owner);
  if(u.pathname.includes('/work-for-other/'))return Response.json({error:{code:404}},{status:404});
  if(u.pathname.endsWith('/studentSubmissions/sub1'))return Response.json(state.submission);
  if(u.pathname.endsWith('/studentSubmissions')){assert.equal(u.searchParams.get('userId'),'user1');return Response.json({studentSubmissions:[state.submission]});}
  if(state.pages&&!u.searchParams.has('pageToken'))return Response.json({courseWork:[],nextPageToken:'next'});
  return Response.json({courseWork:state.works});
 }});
 return{binding,state,resolver};
}
test('Homework chung: phân trang, child tab, đúng UUID/user/bản sao; cache vẫn đối chiếu lại chủ',async()=>{
 const f=setup();f.state.pages=true;const target=await f.resolver(f.binding);
 assert.equal(target.documentId,'doc1');assert.equal(target.tabId,'child');assert.equal(target.studentRef,f.binding.student_ref);assert.equal(target.googleUserId,'user1');
 f.binding.owner_proof.homework=target;f.state.requests=[];
 assert.equal((await f.resolver(f.binding)).documentId,'doc1');assert.equal(f.state.requests.some(u=>u.pathname.endsWith('/courseWork')),false);
 f.state.submission.userId='user2';await assert.rejects(f.resolver(f.binding),e=>e.code==='DOCUMENT_OWNER_MISMATCH');
});
test('Homework chung: không ghi khi người/lớp sai, nhiều đích hoặc chỉ có bản mẫu',async()=>{
 for(const kind of ['wrong_user','wrong_class','ambiguous','template','shared_file']){
  const f=setup();
  if(kind==='wrong_user')f.state.submission.userId='other';
  if(kind==='wrong_class')f.state.submission.courseId='other';
  if(kind==='ambiguous')f.state.document.tabs[0].childTabs.push(structuredClone(f.state.document.tabs[0].childTabs[0]));
  if(kind==='template')f.state.submission.assignmentSubmission.attachments[0].driveFile.id='template';
  if(kind==='shared_file')f.state.works[0].materials[0].driveFile.shareMode='VIEW';
  await assert.rejects(f.resolver(f.binding),e=>['DOC_IDENTITY_MISMATCH','DOC_STATUS_AMBIGUOUS','HOMEWORK_NOT_FOUND'].includes(e.code),kind);
 }
});
test('Homework chung: mapping cũ, thiếu Homework, sai mã và cache đổi người đều dừng trước ghi',async()=>{
 const f=setup();f.state.owner.capturedAt=new Date(Date.now()-130000).toISOString();
 await assert.rejects(f.resolver(f.binding),e=>e.code==='OWNER_MISMATCH');
 const missing=setup();missing.state.works=[];await assert.rejects(missing.resolver(missing.binding),e=>e.code==='HOMEWORK_NOT_FOUND');
 const wrong=setup();wrong.binding.code='other';await assert.rejects(wrong.resolver(wrong.binding),e=>e.code==='DOC_CODE_MISMATCH');
 const cached=setup();cached.binding.owner_proof.homework={...await cached.resolver(cached.binding),studentRef:uuid()};
 await assert.rejects(cached.resolver(cached.binding),e=>e.code==='DOC_IDENTITY_MISMATCH');
});

test('Homework chung: bỏ qua bài Lesson 9 chỉ giao riêng cho học viên khác, không nhầm 404 thành thiếu quyền',async()=>{
 const f=setup();f.state.works.unshift({...structuredClone(f.state.works[0]),id:'work-for-other',assigneeMode:'INDIVIDUAL_STUDENTS',individualStudentsOptions:{studentIds:['other-user']}});
 assert.equal((await f.resolver(f.binding)).documentId,'doc1');
 assert.equal(f.state.requests.some(u=>u.pathname.includes('/work-for-other/')),false);
});

test('Homework bài mới: lấy buổi và mã đã đăng ký, không tìm cứng Lesson 9',async()=>{
 const f=setup(),code='67-practice-reading_homework-new-fixture';
 registerAuthoredLesson({code,lesson:77,title:'Fixture mới',totalMs:1200000,paragraphs:['A'],groups:[{id:'notes',kind:'completion',label:'Notes',start:1,end:1}]});
 f.binding.code=code;f.state.works[0].title='Homework Lesson 77';
 f.state.document.tabs[0].childTabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content=code+'\n'+CTA+'\n';
 const target=await f.resolver(f.binding);assert.equal(target.code,code);assert.equal(target.documentId,'doc1');
});
