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
