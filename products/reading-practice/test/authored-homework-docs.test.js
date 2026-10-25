// Bài mới dùng dòng tự động riêng; mọi thao tác ghi phải nằm sau phần chữ/link thủ công.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthoredLesson} from '../src/authored-content.js';
import {planDocWrite,READING_STATUS_HEADING} from '../src/docs.js';

test('Homework Reading mới: giữ chữ/link tay, đúng mã/tab, khóa revision và retry không nhân đôi',()=>{
 const code='67-practice-reading_homework-manual-fixture';
 registerAuthoredLesson({code,lesson:78,title:'Homework fixture',totalMs:1200000,paragraphs:['A'],groups:[{id:'notes',kind:'completion',label:'Notes',start:1,end:1}]});
 const paragraph=(start,text,link='')=>({paragraph:{elements:[{startIndex:start,endIndex:start+text.length+1,textRun:{content:text+'\n',textStyle:{link:link?{url:link}:undefined}}}]}});
 const doc=value=>({documentId:'personal_doc',revisionId:'revision_fixture',tabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[paragraph(1,'Homework fixture'),{table:{tableRows:[{tableCells:[{content:[paragraph(50,code)]}]},{tableCells:[{content:[paragraph(100,READING_STATUS_HEADING)]}]},{tableCells:[{content:[paragraph(200,value,'https://manual.test/own')]}]}]}}]}}}]});
 const b={code,document_id:'personal_doc',tab_id:'child',last_doc_text:''},manual='Em đã nộp bài ạ; giữ link riêng.';
 const job={kind:'status',payload:{text:'Đã hoàn thành. Giảng viên nhấn vào đây để xem kết quả.',link:'https://page.test/teacher.html#submission=fixture'}};
 const plan=planDocWrite(doc(manual),b,job);assert.equal(plan.revisionId,'revision_fixture');
 assert.equal(plan.requests.some(r=>r.deleteContentRange),false);
 assert.equal(plan.requests[0].insertText.text,'\nReading thực chiến (tự động): '+job.payload.text);
 for(const req of plan.requests)if(req.updateTextStyle)assert.ok(req.updateTextStyle.range.startIndex>=200+manual.length);
 assert.throws(()=>planDocWrite(doc(manual),{...b,document_id:'wrong'},job),e=>e.code==='DOC_IDENTITY_MISMATCH');
 assert.throws(()=>planDocWrite(doc(manual),{...b,tab_id:'wrong'},job),e=>e.code==='DOC_TAB_NOT_FOUND');
 const ready=doc(manual+'\nReading thực chiến (tự động): '+job.payload.text);
 ready.tabs[0].documentTab.body.content[1].table.tableRows[2].tableCells[0].content[0].paragraph.elements[0].textRun.textStyle.link.url=job.payload.link;
 assert.equal(planDocWrite(ready,b,job).verified,true);assert.deepEqual(planDocWrite(ready,b,job).requests,[]);
 const unrelated={table:{tableRows:[{tableCells:[{content:[paragraph(500,READING_STATUS_HEADING)]}]},{tableCells:[{content:[paragraph(600,'Listening: giữ nguyên')]}]}]}};
 const combined=doc(manual);combined.tabs[0].documentTab.body.content.push(unrelated);
 const scoped=planDocWrite(combined,b,job);
 assert.ok(scoped.requests.every(r=>(r.insertText?.location.index??r.updateTextStyle?.range.startIndex??r.deleteContentRange?.range.startIndex)<500));
 const missing=doc(manual);missing.tabs[0].documentTab.body.content[1].table.tableRows[1].tableCells[0].content=[paragraph(100,'TÌNH TRẠNG NỘP BÀI THỰC CHIẾN')];
 missing.tabs[0].documentTab.body.content.push(unrelated);
 assert.throws(()=>planDocWrite(missing,b,job),e=>e.code==='DOC_STATUS_AMBIGUOUS');
 const wrapper=doc(manual);const reading=wrapper.tabs[0].documentTab.body.content[1];
 wrapper.tabs[0].documentTab.body.content=[{table:{tableRows:[{tableCells:[{content:[reading,unrelated]}]}]}}];
 assert.equal(planDocWrite(wrapper,b,job).requests[0].insertText.location.index,200+manual.length);
});
