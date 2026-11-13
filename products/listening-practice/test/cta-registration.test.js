import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {pathToFileURL} from 'node:url';
import {createCtaRegistrar,findListeningCta} from '../src/cta-registration.js';
import {createDocsWorker,CTA} from '../src/docs.js';
import {createOwnerSourceApp} from '../src/owner-source.js';
import {createOwnerResolver} from '../src/owner.js';
import {fixture} from './helpers.js';
import {CODE,hash,secret} from '../src/domain.js';
const {createApp}=await import(process.env.LISTENING_CTA_BASE?pathToFileURL(process.env.LISTENING_CTA_BASE+'/src/app.js'):new URL('../src/app.js',import.meta.url));
const event={schema_version:'course67_cta_registration_v2',course:67,doc_id:'fixture_new_document_1234567890',submission_id:'submission1',classroom_course_id:'123',coursework_id:'456',student_id:'789',class_name:'FIXTURE 67'};
function document(id=event.doc_id){
 let index=1;
 const p=(text,link)=>{const start=index;index+=text.length+1;return{paragraph:{elements:[{startIndex:start,endIndex:index,textRun:{content:text+'\n',textStyle:link?{link:{url:link}}:{}}}]}};};
 return{documentId:id,revisionId:'revision1',tabs:[{tabProperties:{tabId:'parent'},childTabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[p('Reading','https://reading.test/unchanged'),p('Speaking','https://speaking.test/unchanged'),p(CTA),p(CODE)]}}}]}]};
}
const body=d=>d.tabs[0].childTabs[0].documentTab.body.content;

test('Legacy MCQ CTA: eligibility checks class, pinned content and exact Classroom copy without creating work',async()=>{
 let verified=0,writes=0;
 const make=(classes,content=[{id:'content-fixture'}],verify=async()=>{verified++;})=>createCtaRegistrar({
  pool:{query:async(sql,args)=>{assert.deepEqual(args,[CODE,'fixture-v1']);return {rows:content};}},
  context:{classes:async()=>classes},service:{},docs:{read:async()=>document(),write:async()=>{writes++;}},
  verifyClassroomCopy:verify,contentVersion:'fixture-v1',resolveOwner:async()=>{throw Error('must not resolve owner during check');}
 });
 const good=[{id:'1124',classCode:event.class_name}];
 assert.equal((await make(good)({...event,check_only:true})).status,'eligible');
 assert.equal(verified,1);assert.equal(writes,0);
 await assert.rejects(make([{id:'other',classCode:'OTHER'}])({...event,check_only:true}),e=>e.code==='CTA_CLASS_MISMATCH');
 await assert.rejects(make(good,[])({...event,check_only:true}),e=>e.code==='CONTENT_NOT_FOUND');
 await assert.rejects(make(good,undefined,async()=>{throw Error('WRONG_SOURCE');})({...event,check_only:true}),/WRONG_SOURCE/);
});

test('Legacy MCQ CTA without mapped owner publishes self confirmation, preserving Doc, code and class',async()=>{
 let published;
 const registrar=createCtaRegistrar({pool:{query:async()=>({rows:[{id:'content-fixture'}]})},
  context:{classes:async()=>[{id:'1124',classCode:event.class_name}]},service:{},docs:{read:async()=>document()},
  contentVersion:'fixture-v1',pageBase:'https://tranhoangduc90.github.io/izone-ai-team-pages/listening-practice/',
  resolveOwner:async()=>{throw Object.assign(Error('unmatched'),{code:'OWNER_NOT_MAPPED'});},
  verifyClassroomCopy:async input=>{assert.equal(input.doc_id,event.doc_id);},
  publishPending:async input=>{published=input;return{status:'verified',entryMode:'self-confirmation'};}
 });
 const result=await registrar(event);assert.equal(result.entryMode,'self-confirmation');
 assert.equal(published.event.doc_id,event.doc_id);assert.equal(published.binding.code,CODE);
 const u=new URL(published.fallbackUrl);assert.equal(u.searchParams.get('assignmentCode'),CODE);assert.equal(u.searchParams.get('class'),event.class_name);
 assert.equal(u.searchParams.has('documentId'),false);
});
test('API đăng ký CTA: bắt quyền, identity và chuyển đúng một sự kiện',async()=>{
 const adminKey=secret();let seen;
 const app=createApp({pool:{query:async()=>({rows:[]})},service:{},origins:[],adminKey,registerCta:async value=>{seen=value;return{documentId:value.doc_id,status:'verified'};}});
 assert.equal((await request(app).post('/api/admin/register-cta').send(event)).status,403);
 assert.equal((await request(app).post('/api/admin/register-cta').set('X-Listening-Admin',adminKey).send({...event,course:56})).status,400);
 const response=await request(app).post('/api/admin/register-cta').set('X-Listening-Admin',adminKey).send({...event,ignored:'not an identity'});
 assert.equal(response.status,200);assert.equal(response.body.status,'verified');assert.deepEqual(seen,event);
});
test('CTA: child tab, mã cạnh CTA; thiếu, trùng và nhầm tab đều dừng trước ghi',()=>{
 const d=document();assert.deepEqual(findListeningCta(d),{tabId:'t.0'});
 const none=structuredClone(d);body(none).splice(2);assert.equal(findListeningCta(none),null);
 const duplicate=structuredClone(d);body(duplicate).push(body(duplicate)[2]);assert.throws(()=>findListeningCta(duplicate),e=>e.code==='CTA_SCOPE_AMBIGUOUS');
 const wrong=structuredClone(d);body(wrong).splice(3,0,{paragraph:{elements:[{textRun:{content:'67-listening-01\n'}}]}});assert.throws(()=>findListeningCta(wrong),e=>e.code==='CTA_CODE_MISMATCH');
});
test('Homework-only CTA is skipped without resolving an owner; ambiguous and mixed Docs still fail closed',async()=>{
 const homework='67-listening-scandinavian-studies';
 const paragraph=text=>({paragraph:{elements:[{textRun:{content:text+'\n'}}]}});
 const make=(...texts)=>{
  const d=document();body(d).splice(2,Infinity,...texts.map(paragraph));return d;
 };
 const homeworkOnly=make(CTA,'',homework);
 const registrar=createCtaRegistrar({
  docs:{read:async()=>homeworkOnly},
  resolveOwner:async()=>assert.fail('Homework does not reach the practice registrar')
 });
 assert.deepEqual(await registrar(event),{documentId:event.doc_id,status:'not_applicable',code:CODE});
 const splitTab=make(CTA);
 splitTab.tabs[0].childTabs.push({tabProperties:{tabId:'other'},documentTab:{body:{content:[paragraph(homework)]}}});
 for(const d of [make(CTA),make(CTA,'67-listening-unknown'),make(CTA,'other text',homework),
  make(CTA,homework,homework),make(CTA,homework,'67-listening-horton-castle'),
  make(CTA,homework,CTA,CODE),make(CTA,homework,CODE),splitTab]){
  assert.throws(()=>findListeningCta(d),e=>['CTA_SCOPE_AMBIGUOUS','CTA_CODE_MISMATCH'].includes(e.code));
 }
});

test('Đăng ký và chạy lại: một binding/job/link, giữ Reading/Speaking; sửa link mất và timeout có thể tiếp tục',async t=>{
 const f=await fixture();t.after(f.close);
 await f.pool.query('UPDATE listening_practice.assignment SET source_course_id=$1,source_work_id=$2',[event.classroom_course_id,event.coursework_id]);
 await f.pool.query('TRUNCATE listening_practice.binding CASCADE');
 f.context.snapshot=async()=>({classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:event.class_name}]});
 let state=document(),writes=0;const unchanged=JSON.stringify(body(state).slice(0,2));
 const docs={read:async()=>structuredClone(state),write:async(id,plan)=>{
  assert.equal(id,event.doc_id);writes++;
  for(const change of plan.requests){const u=change.updateTextStyle;assert.equal(u.range.tabId,'t.0');const target=body(state).find(p=>p.paragraph.elements[0].startIndex===u.range.startIndex);assert.ok(target);target.paragraph.elements[0].textRun.textStyle=u.textStyle;}
 }};
 const worker=createDocsWorker({pool:f.pool,docs});
 const make=(entryKey=secret(),waitMs=5000,sleep=async()=>{await worker.once();})=>createCtaRegistrar({pool:f.pool,service:f.service,context:f.context,docs,verifyClassroomCopy:async()=>{},resolveOwner:async()=>({classId:'1124',studentRef:f.studentRef}),entryKey,contentVersion:f.content.version,waitMs,sleep});
 await assert.rejects(make(secret(),0)(event),e=>e.code==='CTA_PENDING');
 const first=await make()(event);assert.equal(first.status,'verified');assert.equal(writes,1);
 assert.equal(first.studentRef,f.studentRef);
 const redirect=new URL(first.entryUrl);assert.equal(redirect.searchParams.get('class'),event.class_name);
 assert.equal(redirect.searchParams.get('mode'),'student');assert.equal(redirect.searchParams.get('documentId'),event.doc_id);
 const jobs=(await f.pool.query('SELECT id,payload FROM listening_practice.doc_job WHERE binding_id=$1',[first.bindingId])).rows;
 const repeated=await Promise.all([make()(event),make()(event)]);assert.ok(repeated.every(r=>r.bindingId===first.bindingId));
 assert.deepEqual((await f.pool.query('SELECT id,payload FROM listening_practice.doc_job WHERE binding_id=$1',[first.bindingId])).rows,jobs);assert.equal(writes,1);
 assert.equal(JSON.stringify(body(state).slice(0,2)),unchanged);
 body(state)[2].paragraph.elements[0].textRun.textStyle={};await make()(event);assert.equal(writes,2);
 const count=(await f.pool.query('SELECT count(*)::int AS n FROM listening_practice.binding WHERE document_id=$1',[event.doc_id])).rows[0].n;assert.equal(count,1);
});
test('Sai lớp hoặc sai Doc: không đăng ký, không ghi và không phát sinh bài làm',async t=>{
 const f=await fixture();t.after(f.close);f.context.snapshot=async()=>({classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'OTHER'}]});
 const make=docs=>createCtaRegistrar({pool:f.pool,service:f.service,context:f.context,docs,verifyClassroomCopy:async()=>{},resolveOwner:async()=>({classId:'1124',studentRef:f.studentRef}),entryKey:secret(),contentVersion:f.content.version});
 await assert.rejects(make({read:async()=>document()})(event),e=>e.code==='CTA_CLASS_MISMATCH');
 await assert.rejects(make({read:async()=>document('wrong')})(event),e=>e.code==='DOC_IDENTITY_MISMATCH');
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM listening_practice.binding WHERE document_id=$1',[event.doc_id])).rows[0].n,0);
});
test('Nguồn chủ Docs: tra course/Google user chính xác, từ chối thiếu key và mapping trùng',async()=>{
 const key=secret(),row={class_id:'1124',student_ref:'a67cd4c6-a61c-4ffb-bdc8-114cc04e3a64',course_id:'123',google_user_id:'789'};let rows=[row],seen;
 const app=createOwnerSourceApp({key,pool:{query:async(sql,args)=>{seen={sql,args};return{rows};}}});
 assert.equal((await request(app).get('/v1/owner-by-classroom?courseId=123&googleUserId=789')).status,401);
 const response=await request(app).get('/v1/owner-by-classroom?courseId=123&googleUserId=789').set('x-listening-owner-key',key);
 assert.equal(response.status,200);assert.deepEqual(seen.args,['123','789']);assert.match(seen.sql,/course_id=\$1 AND google_user_id=\$2/);
 const {capturedAt,sourceRevision,...payload}=response.body;assert.equal(sourceRevision,hash(JSON.stringify(payload)));
 const resolver=createOwnerResolver({url:'https://owner.test',key,fetcher:async()=>new Response(JSON.stringify(response.body))});assert.equal((await resolver({courseId:'123',googleUserId:'789'})).studentRef,row.student_ref);
 await assert.rejects(resolver({courseId:'123',googleUserId:'790'}),e=>e.code==='OWNER_MISMATCH');
 rows=[row,row];assert.equal((await request(app).get('/v1/owner-by-classroom?courseId=123&googleUserId=789').set('x-listening-owner-key',key)).status,403);
 rows=[row];assert.equal((await request(app).get('/v1/owner?classId=1124&studentRef='+row.student_ref).set('x-listening-owner-key',key)).status,200);
});
