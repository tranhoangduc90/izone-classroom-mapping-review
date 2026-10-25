import test from 'node:test';
import assert from 'node:assert/strict';
import {planDocWrite,createDocsWorker,CTA,STATUS_HEADING} from '../src/docs.js';
import {fixture} from './helpers.js';
import {CODE,uuid} from '../src/domain.js';

const paragraph=(start,value,link='')=>({startIndex:start,endIndex:start+value.length+1,paragraph:{elements:[{startIndex:start,endIndex:start+value.length,textRun:{content:value,textStyle:{link:link?{url:link}:undefined}}},{startIndex:start+value.length,endIndex:start+value.length+1,textRun:{content:'\n'}}]}});
const cell=(start,value,link)=>({content:[paragraph(start,value,link)]});
function document(binding,value='',link=''){
 return{documentId:binding.document_id,revisionId:'revision1',tabs:[{tabProperties:{tabId:'parent'},childTabs:[{tabProperties:{tabId:binding.tab_id},documentTab:{body:{content:[paragraph(1,CODE),paragraph(50,CTA),{table:{tableRows:[{tableCells:[cell(100,STATUS_HEADING)]},{tableCells:[cell(200,value,link)]}]}}]}}}]}]};
}
test('Docs: tìm child tab, đúng ô trạng thái, khóa revision, thay own text và bảo toàn manual text',()=>{
 const b={document_id:'fixture',tab_id:'child',last_doc_text:''},job={kind:'status',payload:{text:'Đã bắt đầu làm bài lần đầu tiên.',link:''}};
 const initial=document(b),plan=planDocWrite(initial,b,job);assert.equal(plan.revisionId,'revision1');assert.deepEqual(plan.requests[0],{insertText:{location:{index:200,tabId:'child'},text:job.payload.text}});
 const second={kind:'status',payload:{text:'Đã hoàn thành. Giảng viên nhấn vào đây để xem kết quả.',link:'https://page.test/teacher.html#submission=fixture'}};
 const replace=planDocWrite(document(b,job.payload.text),{...b,last_doc_text:job.payload.text},second);assert.equal(replace.requests[0].deleteContentRange.range.endIndex,200+job.payload.text.length);
 assert.equal(replace.requests.at(-1).updateTextStyle.textStyle.link.url,second.payload.link);
 assert.equal(planDocWrite(document(b,second.payload.text,second.payload.link),b,second).verified,true);
 assert.throws(()=>planDocWrite(document(b,'Nhận xét riêng của giáo viên'),b,job),e=>e.code==='DOC_MANUAL_CONFLICT');
 assert.throws(()=>planDocWrite({...initial,documentId:'other'},b,job),e=>e.code==='DOC_IDENTITY_MISMATCH');
 assert.throws(()=>planDocWrite(initial,{...b,tab_id:'wrong'},job),e=>e.code==='DOC_TAB_NOT_FOUND');
});
test('Docs queue: không vượt job lỗi trước đó, retry lỗi mạng rồi readback đúng mới verified',async t=>{
 const f=await fixture();t.after(f.close);const b=(await f.pool.query('SELECT * FROM reading_practice.binding')).rows[0];
 let state=document(b),calls=0,failWrite=true;
 const docs={read:async()=>state,write:async(id,plan)=>{calls++;if(failWrite)throw new Error('network');
  for(const req of plan.requests){if(req.updateTextStyle?.textStyle.link){state.tabs[0].childTabs[0].documentTab.body.content[1]=paragraph(50,CTA,req.updateTextStyle.textStyle.link.url);}}
 }};
 const worker=createDocsWorker({pool:f.pool,docs});await f.begin();await worker.once();
 let jobs=(await f.pool.query('SELECT * FROM reading_practice.doc_job ORDER BY sequence')).rows;assert.equal(jobs[0].status,'pending');assert.equal(jobs[1].status,'pending');assert.equal(await worker.once(),false);
 failWrite=false;await f.pool.query("UPDATE reading_practice.doc_job SET available_at=now() WHERE sequence=0");await worker.once();jobs=(await f.pool.query('SELECT * FROM reading_practice.doc_job ORDER BY sequence')).rows;
 assert.equal(jobs[0].status,'verified');assert.equal(jobs[1].status,'pending');assert.equal(calls,2);
});

test('Docs link chung: giữ chữ nhập tay, thêm dòng tự động và retry không ghi trùng',()=>{
 const b={document_id:'fixture',tab_id:'child',last_doc_text:'',owner_proof:{mode:'shared'}};
 const manual='Em đã nộp bài ạ\nhttps://example.test/ket-qua-cu';
 const message='Đã hoàn thành ngay từ lần đầu. Giảng viên nhấn vào đây để xem kết quả.';
 const job={kind:'status',payload:{text:message,link:'https://page.test/teacher.html#submission=done'}};
 const plan=planDocWrite(document(b,manual),b,job);
 assert.equal(plan.requests.some(r=>r.deleteContentRange),false);
 assert.equal(plan.requests[0].insertText.text,'\nReading thực chiến (tự động): '+message);
 const ready=document(b,manual+'\nReading thực chiến (tự động): '+message,job.payload.link);
 assert.equal(planDocWrite(ready,b,job).verified,true);
 assert.deepEqual(planDocWrite(ready,b,job).requests,[]);
 const next={kind:'status',payload:{text:'Đã bắt đầu làm bài lần 2.',link:''}};
 const update=planDocWrite(ready,{...b,last_doc_text:message},next);
 assert.equal(update.requests[0].deleteContentRange.range.startIndex,200+manual.length+1);
 assert.throws(()=>planDocWrite(document(b,manual+'\nReading thực chiến (tự động): bị sửa tay'),{...b,last_doc_text:message},next),e=>e.code==='DOC_MANUAL_CONFLICT');
});

test('Docs link chung qua queue: mất phản hồi sau ghi vẫn readback, không nhân đôi hoặc đổi binding/lượt',async t=>{
 const f=await fixture();t.after(f.close);await f.begin();
 await f.pool.query("DELETE FROM reading_practice.doc_job WHERE kind='cta'");
 await f.pool.query("UPDATE reading_practice.binding SET document_id=NULL,tab_id=NULL,owner_proof=$1",[{mode:'shared'}]);
 const b=(await f.pool.query('SELECT * FROM reading_practice.binding')).rows[0];
 const before=(await f.pool.query('SELECT state,updated_at FROM reading_practice.work')).rows;
 const target={classId:'1124',studentRef:b.student_ref,code:CODE,documentId:'personal_doc',tabId:'child'};
 const effective={...b,document_id:target.documentId,tab_id:target.tabId};
 let value='Chữ nhập tay giữ nguyên',link='',writes=0;
 const docs={read:async()=>document(effective,value,link),write:async(id,plan)=>{
  assert.equal(id,target.documentId);writes++;
  for(const req of plan.requests){
   if(req.insertText){const at=req.insertText.location.index-200;value=value.slice(0,at)+req.insertText.text+value.slice(at);}
   if(req.updateTextStyle?.textStyle.link)link=req.updateTextStyle.textStyle.link.url;
  }
  throw new Error('Mất phản hồi sau ghi');
 }};
 const worker=createDocsWorker({pool:f.pool,docs,resolveSharedHomework:async()=>target});
 await worker.once();assert.equal(writes,1);assert.equal((await f.pool.query('SELECT status FROM reading_practice.doc_job')).rows[0].status,'pending');
 await f.pool.query('UPDATE reading_practice.doc_job SET available_at=now()');await worker.once();
 assert.equal(writes,1);assert.equal((await f.pool.query('SELECT status FROM reading_practice.doc_job')).rows[0].status,'verified');
 assert.ok(value.startsWith('Chữ nhập tay giữ nguyên\nReading thực chiến (tự động): '));
 const stored=(await f.pool.query('SELECT * FROM reading_practice.binding')).rows[0];
 assert.equal(stored.document_id,null);assert.equal(stored.owner_proof.mode,'shared');assert.equal(stored.owner_proof.homework.documentId,target.documentId);
 assert.deepEqual((await f.pool.query('SELECT state,updated_at FROM reading_practice.work')).rows,before);
});

test('Docs link chung qua queue: đích khác UUID bị chặn trước khi đọc/ghi',async t=>{
 const f=await fixture();t.after(f.close);await f.begin();
 await f.pool.query("DELETE FROM reading_practice.doc_job WHERE kind='cta'");
 await f.pool.query("UPDATE reading_practice.binding SET document_id=NULL,tab_id=NULL,owner_proof=$1",[{mode:'shared'}]);
 let calls=0;const worker=createDocsWorker({pool:f.pool,docs:{read:async()=>{calls++;},write:async()=>{calls++;}},resolveSharedHomework:async()=>({classId:'1124',studentRef:uuid(),code:CODE,documentId:'wrong',tabId:'child'})});
 await worker.once();assert.equal(calls,0);
 assert.deepEqual((await f.pool.query('SELECT status,error_code FROM reading_practice.doc_job')).rows,[{status:'blocked',error_code:'DOC_IDENTITY_MISMATCH'}]);
});

test('Chưa giao Homework vẫn chờ sau tám lượt; khi có đích thì ghi cùng binding và giữ bài',async t=>{
 const f=await fixture();t.after(f.close);await f.begin();
 await f.pool.query("DELETE FROM reading_practice.doc_job WHERE kind='cta'");
 await f.pool.query("UPDATE reading_practice.binding SET document_id=NULL,tab_id=NULL,owner_proof=$1",[{mode:'shared'}]);
 const b=(await f.pool.query('SELECT * FROM reading_practice.binding')).rows[0];
 const before=(await f.pool.query('SELECT state,updated_at FROM reading_practice.work')).rows;
 const job=(await f.pool.query('SELECT * FROM reading_practice.doc_job')).rows[0];
 const target={classId:'1124',studentRef:b.student_ref,code:CODE,documentId:'delivered_later',tabId:'child'};
 let delivered=false,reads=0;
 const worker=createDocsWorker({pool:f.pool,resolveSharedHomework:async()=>{
  if(!delivered)throw Object.assign(new Error('Chưa giao'),{code:'HOMEWORK_NOT_FOUND'});return target;
 },docs:{read:async()=>{reads++;return document({...b,document_id:target.documentId,tab_id:target.tabId},'Reading thực chiến (tự động): '+job.payload.text);},write:async()=>assert.fail('Đích đã khớp không ghi lại')}});
 await f.pool.query('UPDATE reading_practice.doc_job SET attempts=8');await worker.once();
 const pending=(await f.pool.query('SELECT status,error_code,attempts FROM reading_practice.doc_job')).rows[0];
 assert.equal(pending.status,'pending');assert.equal(pending.error_code,'HOMEWORK_NOT_FOUND');assert.equal(pending.attempts,9);assert.equal(reads,0);
 delivered=true;await f.pool.query('UPDATE reading_practice.doc_job SET available_at=now()');await worker.once();
 assert.equal((await f.pool.query('SELECT status FROM reading_practice.doc_job')).rows[0].status,'verified');
 assert.deepEqual((await f.pool.query('SELECT state,updated_at FROM reading_practice.work')).rows,before);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM reading_practice.binding')).rows[0].n,1);
});
