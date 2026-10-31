import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {CODE,uuid} from '../src/domain.js';
import {ROBOTS_CODE} from '../src/lessons.js';
import {createCtaRegistrar} from '../src/cta-registration.js';
import {CTA} from '../src/docs.js';

test('Gắn chủ Docs sau khi đã làm link chung: giữ binding/lượt, nâng cấp duy nhất CTA cũ và chạy lại ổn định',async t=>{
 const f=await fixture();t.after(f.close);const other=uuid();
 f.context.classes=async()=>[{id:'1293',classCode:'IC1293'}];f.context.student=async(c,id)=>c==='1293'&&id===other?{studentRef:id,name:'Tên giả'}:null;
 await f.service.configureSharedLesson({code:CODE,contentVersion:f.content.version,status:'open'});
 const opened=await f.service.sharedLogin({code:CODE,classId:'1293',studentRef:other});
 const start=await f.service.begin({token:opened.token,owner:'A',operationId:uuid()});
 const before=(await f.pool.query('SELECT state FROM reading_practice.work WHERE binding_id=$1',[opened.identity.bindingId])).rows[0];
 const input={code:CODE,classId:'1293',classCode:'IC1293',studentRef:other,documentId:'fixture_new_reading_document_123456',tabId:'t.0',courseId:'1',courseWorkId:'2',submissionId:'3'};
 await f.pool.query("INSERT INTO reading_practice.doc_job(id,binding_id,sequence,kind,payload,status) VALUES($1,$2,0,'cta',$3,'verified')",[uuid(),opened.identity.bindingId,{url:'https://example.test/reading-practice/?lesson='+CODE}]);
 const registered=await f.service.registerSharedHomework(input);assert.equal(registered.bindingId,opened.identity.bindingId);
 const url=new URL(registered.entryUrl);assert.equal(url.searchParams.get('documentId'),input.documentId);assert.equal(url.searchParams.get('class'),'IC1293');assert.equal(url.searchParams.get('mode'),'student');
 assert.deepEqual(await f.service.registerSharedHomework(input),registered);
 const b=(await f.pool.query('SELECT * FROM reading_practice.binding WHERE id=$1',[registered.bindingId])).rows[0];assert.equal(b.document_id,null);assert.equal(b.owner_proof.homework.documentId,input.documentId);
 assert.deepEqual((await f.pool.query('SELECT state FROM reading_practice.work WHERE binding_id=$1',[b.id])).rows[0],before);assert.equal((await f.service.read({token:opened.token})).attempts[0].id,start.attempts[0].id);
 await assert.rejects(f.service.registerSharedHomework({...input,documentId:'fixture_different_document_123456'}),e=>e.code==='DOC_IDENTITY_MISMATCH');
});

test('Bộ đăng ký Reading nhận Robots buổi 9 và chỉ thành công sau readback đúng Doc/code/link',async()=>{
 const docId='fixture_robots_document_1234567890',url='https://example.test/?lesson='+ROBOTS_CODE+'&documentId='+docId;
 let seen,index=1;const paragraph=(text,link)=>{const start=index;index+=text.length+1;return{paragraph:{elements:[{startIndex:start,endIndex:index,textRun:{content:text+'\n',textStyle:link?{link:{url:link}}:{}}}]}};};
 const document={documentId:docId,revisionId:'1',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[paragraph(CTA,url),paragraph(ROBOTS_CODE)]}}}]};
 const registrar=createCtaRegistrar({pool:{query:async()=>({rows:[{status:'verified'}]})},service:{registerSharedHomework:async input=>{seen=input;return{bindingId:'bound',assignmentId:'assigned',entryUrl:url};}},context:{snapshot:async()=>({classes:[{erp_course_class_id:'1293',erp_class_name_snapshot:'IC1293'}]})},docs:{read:async()=>document},resolveOwner:async()=>({classId:'1293',studentRef:'owner'}),entryKey:'unused'});
 const result=await registrar({doc_id:docId,classroom_course_id:'1',coursework_id:'2',submission_id:'3',student_id:'4',class_name:'IC1293'});
 assert.equal(result.status,'verified');assert.equal(seen.code,ROBOTS_CODE);assert.equal(seen.documentId,docId);assert.equal(seen.tabId,'t.0');
});
