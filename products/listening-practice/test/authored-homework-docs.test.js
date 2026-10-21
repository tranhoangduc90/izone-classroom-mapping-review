// Bài mới dùng dòng tự động riêng; mọi thao tác ghi phải nằm sau phần chữ/link thủ công.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthoredLesson} from '../src/authored-content.js';
import {planDocWrite,STATUS_HEADING} from '../src/docs.js';

test('Homework Listening mới: giữ chữ/link tay, đúng mã/tab, khóa revision và retry không nhân đôi',()=>{
 const code='67-practice-listening_homework-manual-fixture';
 registerAuthoredLesson({code,lesson:78,title:'Homework fixture',totalMs:3000,audioMs:1000,reviewMs:2000,paragraphs:['A'],groups:[{id:'notes',kind:'completion',label:'Notes',start:31,end:31}]});
 const paragraph=(start,text,link='')=>({paragraph:{elements:[{startIndex:start,endIndex:start+text.length+1,textRun:{content:text+'\n',textStyle:{link:link?{url:link}:undefined}}}]}});
 const doc=value=>({documentId:'personal_doc',revisionId:'revision_fixture',tabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[paragraph(1,code),{table:{tableRows:[{tableCells:[{content:[paragraph(100,STATUS_HEADING)]}]},{tableCells:[{content:[paragraph(200,value,'https://manual.test/own')]}]}]}}]}}}]});
 const b={code,document_id:'personal_doc',tab_id:'child',last_doc_text:''},manual='Em đã nộp bài ạ; giữ link riêng.';
 const job={kind:'status',payload:{text:'Đã hoàn thành. Giảng viên nhấn vào đây để xem kết quả.',link:'https://page.test/teacher.html#submission=fixture'}};
 const plan=planDocWrite(doc(manual),b,job);assert.equal(plan.revisionId,'revision_fixture');
 assert.equal(plan.requests.some(r=>r.deleteContentRange),false);
 assert.equal(plan.requests[0].insertText.text,'\nListening thực chiến (tự động): '+job.payload.text);
 for(const req of plan.requests)if(req.updateTextStyle)assert.ok(req.updateTextStyle.range.startIndex>=200+manual.length);
 assert.throws(()=>planDocWrite(doc(manual),{...b,document_id:'wrong'},job),e=>e.code==='DOC_IDENTITY_MISMATCH');
 assert.throws(()=>planDocWrite(doc(manual),{...b,tab_id:'wrong'},job),e=>e.code==='DOC_TAB_NOT_FOUND');
 const ready=doc(manual+'\nListening thực chiến (tự động): '+job.payload.text);
 ready.tabs[0].documentTab.body.content[1].table.tableRows[1].tableCells[0].content[0].paragraph.elements[0].textRun.textStyle.link.url=job.payload.link;
 assert.equal(planDocWrite(ready,b,job).verified,true);assert.deepEqual(planDocWrite(ready,b,job).requests,[]);
});
