import test from 'node:test';
import assert from 'node:assert/strict';
import {progressPayload,planProgressWrite,verifyProgressWrite} from '../src/speaking-progress-docs.js';
const docId='fixture-speaking-doc';
const payload=progressPayload({parts:[{part_key:'freestyle'}],links:[{kind:'main',part:'freestyle',status:'accepted',question_count:2}],requiredPracticeCount:2,assignmentCode:'67-speaking-fixture',documentId:docId,independent:true});
function document(text='',link='') {
  const heading={content:[{paragraph:{elements:[{textRun:{content:'TÌNH TRẠNG NỘP BÀI SPEAKING\n'}}]}}]};
  const cell={content:[{paragraph:{elements:[{startIndex:100,endIndex:101+text.length,textRun:{content:text+'\n',textStyle:{link:{url:link}}}}]}}]};
  return {documentId:docId,revisionId:'revision-fixture',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:'67-speaking-fixture\n'}}]}},{table:{tableRows:[{tableCells:[heading]},{tableCells:[cell]}]}}]}}}]};
}
const row={document_id:docId,tab_id:'t.0',assignment_code:'67-speaking-fixture',payload,last_text:'',last_link:''};
test('Docs reports accepted parts before a receipt, with short supplement labels',()=>{
  assert.match(payload.text,/1\/3 phần/);assert.match(payload.text,/Speaking chính: đã xác nhận 2 câu/);
  assert.match(payload.text,/Bổ trợ 1: chưa xác nhận/);assert.doesNotMatch(payload.text,/đã nộp/i);
  assert.match(payload.link,/teacher-progress.html\?code=/);
});
test('managed partial progress becomes final and manual edits remain protected',()=>{
  const first=planProgressWrite(document(),row);assert.ok(first.requests.length);
  assert.equal(verifyProgressWrite(document(payload.text,payload.link),row),true);
  assert.equal(planProgressWrite(document(payload.text,payload.link),row).requests.length,0);
  const done=progressPayload({parts:[{part_key:'freestyle'}],links:[],requiredPracticeCount:0,receiptId:'00000000-0000-4000-8000-000000000001',assignmentCode:'67-speaking-fixture',documentId:docId,independent:true});
  assert.ok(planProgressWrite(document(payload.text,payload.link),{...row,payload:done,last_text:payload.text,last_link:payload.link}).requests.length);
  assert.throws(()=>planProgressWrite(document('Teacher manual note'),row),/DOC_MANUAL_CONFLICT/);
});
test('lost acknowledgement can recover the attempted output when newer progress arrives',()=>{
  const newer={...row,payload:{...payload,text:payload.text.replace('1/3','2/3')},attempt_text:payload.text,attempt_link:payload.link};
  assert.ok(planProgressWrite(document(payload.text,payload.link),newer).requests.length);
});
test('wrong document or a modified link cannot count as synchronized',()=>{
  assert.equal(verifyProgressWrite(document(payload.text,'https://example.invalid'),row),false);
  assert.throws(()=>planProgressWrite({...document(),documentId:'another-doc'},row),/DOC_IDENTITY_MISMATCH/);
});
