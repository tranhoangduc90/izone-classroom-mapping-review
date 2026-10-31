import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {authoredLesson} from '../src/authored-content.js';
import {createCtaRegistrar} from '../src/cta-registration.js';
import {createDocsWorker,CTA,STATUS_HEADING} from '../src/docs.js';
import {secret,uuid} from '../src/domain.js';

const code='67-practice-listening_c20_t3_p4_inclusive_design';
const version='shared-cta-fixture-v1';
const p=text=>({runs:[{text}]});
function bundle(){
 const lesson=authoredLesson(code),key=Object.fromEntries(lesson.questionIds.map(n=>[n,['green']]));
 return{code,version,totalMs:lesson.totalMs,key,definition:{authored:true,lesson,groups:lesson.groups.map(g=>({...g,instruction:'ONE WORD ONLY',questions:lesson.questionIds.filter(n=>+n>=g.start&&+n<=g.end).map(n=>({n:+n,text:'The roof is {blank}.'}))})),audio:{durationMs:lesson.audioMs,sha256:'1'.repeat(64)}},explanations:{passage:{A:'The roof is green.'},entries:Object.fromEntries(lesson.questionIds.map(n=>[n,{number:+n,kind:'completion',answer:key[n],prompt:p('Roof'),reason:[p('Explicit colour.')],evidenceGroups:[{paragraph:'A',paragraphs:[p('The roof is green.')],marks:[{start:0,end:18}]}]}]))}};
}
function document(id){
 const manual='Nhận xét tay giữ nguyên.';
 let link='https://old.test/listening',revision=0,value=manual,writes=0,statusLink='';
 const paragraph=(start,text,url)=>({paragraph:{elements:[{startIndex:start,endIndex:start+text.length+1,textRun:{content:text+'\n',textStyle:url?{link:{url},bold:true}:{}}}]}});
 return{get link(){return link;},get writes(){return writes;},get value(){return value;},
  docs:{read:async doc=>{assert.equal(doc,id);return{documentId:id,revisionId:'r'+revision,tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[paragraph(1,'Reading unchanged','https://reading.test/original'),paragraph(100,CTA,link),paragraph(200,code),{table:{tableRows:[{tableCells:[{content:[paragraph(300,STATUS_HEADING)]}]},{tableCells:[{content:[paragraph(400,value,statusLink)]}]}]}}]}}}]};},
   write:async(doc,plan)=>{assert.equal(doc,id);assert.equal(plan.revisionId,'r'+revision);for(const r of plan.requests){
    if(r.updateTextStyle?.range.startIndex===100)link=r.updateTextStyle.textStyle.link.url;
    else if(r.insertText){const at=r.insertText.location.index-400;assert.ok(at>=manual.length);value=value.slice(0,at)+r.insertText.text+value.slice(at);}
    else if(r.deleteContentRange){const range=r.deleteContentRange.range;assert.ok(range.startIndex>=400+manual.length);value=value.slice(0,range.startIndex-400)+value.slice(range.endIndex-400);}
    else if(r.updateTextStyle?.range.startIndex>=400+manual.length){if(r.updateTextStyle.fields.includes('link'))statusLink=r.updateTextStyle.textStyle.link?.url||'';}
    else throw Error('Unexpected write outside CTA/status');
   }revision++;writes++;}},
  withoutCta(){return{read:async()=>({documentId:id,revisionId:'r0',tabs:[]})};}
 };
}
async function setup(t){
 const f=await fixture();t.after(f.close);await f.pool.query("UPDATE listening_practice.doc_job SET status='verified'");await f.service.seedContent(bundle());await f.service.configureSharedLesson({code,contentVersion:version,status:'open'});
 const second=uuid(),members=[{studentRef:f.studentRef,name:'Tên giống nhau'},{studentRef:second,name:'Tên giống nhau'}];
 f.context.classes=async()=>[{id:'1124',classCode:'FIXTURE 67'}];f.context.student=async(c,s)=>c==='1124'?members.find(m=>m.studentRef===s):undefined;f.context.roster=async()=>members;
 f.context.snapshot=async()=>({classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'FIXTURE 67'}]});
 const docs=new Map(members.map((m,i)=>['shared_homework_fixture_'+i+'_'+uuid().replaceAll('-',''),document('pending')]));
 const records=members.map((member,i)=>{const id=[...docs.keys()][i];docs.set(id,document(id));return{member,id,event:{schema_version:'course67_cta_registration_v2',course:67,doc_id:id,classroom_course_id:'123',coursework_id:'456',submission_id:'submission-'+i,student_id:'google-'+i,class_name:'FIXTURE 67'}};});
 const adapter={read:id=>docs.get(id).docs.read(id),write:(id,plan)=>docs.get(id).docs.write(id,plan)};
 const resolver=async b=>({...b.owner_proof.homework});
 const worker=createDocsWorker({pool:f.pool,docs:adapter,resolveSharedHomework:resolver});
 const register=createCtaRegistrar({pool:f.pool,service:f.service,context:f.context,docs:adapter,resolveOwner:async({googleUserId})=>({classId:'1124',studentRef:records.find(r=>r.event.student_id===googleUserId).member.studentRef}),entryKey:secret(),contentVersion:f.content.version,sleep:async()=>worker.once()});
 return{...f,records,documents:docs,register,worker};
}
test('Buổi 10 qua cùng API giao Homework: link chung, đúng hai Docs và retry đồng thời không nhân bản',async t=>{
 const f=await setup(t),[a,b]=f.records;
 const before=await f.service.sharedLogin({code,classId:'1124',studentRef:a.member.studentRef});
 const start=await f.service.begin({token:before.token,owner:'before-homework',operationId:uuid()});
 const stateBefore=(await f.pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[before.identity.bindingId])).rows[0].state;
 // Job trạng thái giữ lại để kiểm sau; không để fixture CTA giả nhận request của dòng trạng thái.
 await f.pool.query("UPDATE listening_practice.doc_job SET available_at=now()+interval '1 day' WHERE kind='status'");
 const first=await f.register(a.event);assert.equal(first.status,'verified');assert.equal(first.bindingId,before.identity.bindingId);
 const second=await f.register(b.event);assert.equal(second.status,'verified');assert.notEqual(first.bindingId,second.bindingId);
 for(const row of f.records){const expected=new URL('https://example.test/listening-practice/');expected.search=new URLSearchParams({lesson:code,mode:'student',class:'FIXTURE 67',documentId:row.id});assert.equal(f.documents.get(row.id).link,expected.href);assert.equal(f.documents.get(row.id).writes,1);assert.equal(f.documents.get(row.id).value,'Nhận xét tay giữ nguyên.');}
 const repeat=await Promise.all([f.register(b.event),f.register(a.event),f.register(a.event)]);assert.ok(repeat.every(r=>r.status==='verified'));
 assert.equal(f.documents.get(a.id).writes,1);assert.equal(f.documents.get(b.id).writes,1);
 const reopened=await f.service.sharedLogin({code,classId:'1124',studentRef:a.member.studentRef});
 assert.equal(reopened.identity.bindingId,before.identity.bindingId);assert.equal(reopened.identity.entryMode,'shared');assert.equal(reopened.identity.documentId,a.id);assert.equal(reopened.attempts[0].id,start.attempts[0].id);
 assert.deepEqual((await f.pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[before.identity.bindingId])).rows[0].state,stateBefore);
 const bound=(await f.pool.query('SELECT * FROM listening_practice.binding WHERE id=$1',[first.bindingId])).rows[0];assert.equal(bound.document_id,null);assert.equal(bound.owner_proof.homework.documentId,a.id);
 const jobs=(await f.pool.query("SELECT status FROM listening_practice.doc_job WHERE kind='cta' AND binding_id=ANY($1::uuid[])",[[first.bindingId,second.bindingId]])).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.status==='verified'));
 await f.pool.query("UPDATE listening_practice.doc_job SET available_at=now() WHERE kind='status'");
 assert.equal(await f.worker.once(),true);
 assert.ok(f.documents.get(a.id).value.startsWith('Nhận xét tay giữ nguyên.\nListening thực chiến (tự động): '));
 assert.equal(f.documents.get(b.id).value,'Nhận xét tay giữ nguyên.');
 assert.equal((await f.pool.query("SELECT status FROM listening_practice.doc_job WHERE binding_id=$1 AND kind='status'",[first.bindingId])).rows[0].status,'verified');
});
test('Buổi 10 không chuyển Docs đã gắn sang người khác hoặc tạo lượt khi chỉ giao bài',async t=>{
 const f=await setup(t),[a,b]=f.records;
 await f.register(a.event);
 await assert.rejects(f.register({...a.event,student_id:b.event.student_id}),e=>e.code==='DOC_IDENTITY_MISMATCH');
 assert.equal(f.documents.get(a.id).writes,1);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM listening_practice.work')).rows[0].n,0);
 await f.service.configureSharedLesson({code,contentVersion:version,status:'closed'});
 await assert.rejects(f.register(b.event),e=>e.code==='LESSON_NOT_OPEN');assert.equal(f.documents.get(b.id).writes,0);
});
