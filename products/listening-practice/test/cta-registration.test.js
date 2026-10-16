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
 const make=(entryKey=secret(),waitMs=5000,sleep=async()=>{await worker.once();})=>createCtaRegistrar({pool:f.pool,service:f.service,context:f.context,docs,resolveOwner:async()=>({classId:'1124',studentRef:f.studentRef}),entryKey,contentVersion:f.content.version,waitMs,sleep});
 await assert.rejects(make(secret(),0)(event),e=>e.code==='CTA_PENDING');
 const first=await make()(event);assert.equal(first.status,'verified');assert.equal(writes,1);
 const jobs=(await f.pool.query('SELECT id,payload FROM listening_practice.doc_job WHERE binding_id=$1',[first.bindingId])).rows;
 const repeated=await Promise.all([make()(event),make()(event)]);assert.ok(repeated.every(r=>r.bindingId===first.bindingId));
 assert.deepEqual((await f.pool.query('SELECT id,payload FROM listening_practice.doc_job WHERE binding_id=$1',[first.bindingId])).rows,jobs);assert.equal(writes,1);
 assert.equal(JSON.stringify(body(state).slice(0,2)),unchanged);
 body(state)[2].paragraph.elements[0].textRun.textStyle={};await make()(event);assert.equal(writes,2);
 const count=(await f.pool.query('SELECT count(*)::int AS n FROM listening_practice.binding WHERE document_id=$1',[event.doc_id])).rows[0].n;assert.equal(count,1);
});
test('Sai lớp hoặc sai Doc: không đăng ký, không ghi và không phát sinh bài làm',async t=>{
 const f=await fixture();t.after(f.close);f.context.snapshot=async()=>({classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'OTHER'}]});
 const make=docs=>createCtaRegistrar({pool:f.pool,service:f.service,context:f.context,docs,resolveOwner:async()=>({classId:'1124',studentRef:f.studentRef}),entryKey:secret(),contentVersion:f.content.version});
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
