import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSubmission} from '../src/speaking-checker.js';
import {speakingCopyUrl} from '../src/speaking-classroom-copies.js';
import {progressPayload} from '../src/speaking-progress-docs.js';

const code='67-speaking-ta_vat_mieu_ta_chuc_nang_what_if';
const url='https://chatgpt.com/share/6906288f-7cb4-8011-bc18-643333fa38b4';
const stages={object_function:['function_choice','situation','action','result','combined','independent'],
  object_what_if:['bridge','hypothesis','development','combined','independent']};
// Nhận các bước luyện; tạo hội thoại và dẫn chứng giả, không gọi Share/AI thật.
function fixture(section,omit=[]){
  const messages=[],evidence=[];
  for(const stage of stages[section].filter(s=>!omit.includes(s))){
    const q=messages.push({role:'assistant',text:`Bạn hãy thực hành bước ${stage} cho món đồ của bạn.`});
    const a=messages.push({role:'user',text:`My own practice for ${stage}: I would feel sad without my guitar.`});
    const f=messages.push({role:'assistant',text:'Tôi đã đọc và góp ý cho câu trả lời bạn vừa thực hành.'});
    evidence.push({stage,questionMessage:q,questionText:messages[q-1].text,answerMessage:a,answerQuote:messages[a-1].text,feedbackMessage:f});
  }
  return {messages,rounds:[{evidence}]};
}
function dependencies(f,completion={completed:false,confidence:1}){return {
  readShare:async()=>({messages:f.messages,source:'fixture'}),
  analyzeObject:async()=>({confidence:0.95,rounds:f.rounds}),
  analyzeCompletion:async()=>completion};}

for(const section of Object.keys(stages)){
  test(`${section}: đủ một lượt gồm thử thách cuối được công nhận qua dispatcher`,async()=>{
    const f=fixture(section),r=await checkSubmission({section,url,minimum:1},dependencies(f));
    assert.equal(r.kind,'pass');assert.equal(r.count,1);assert.equal(r.acceptanceBasis,'standard');assert.ok(r.snapshot);
  });
  test(`${section}: chưa làm thử thách cuối còn thiếu`,async()=>{
    const f=fixture(section,['independent']),r=await checkSubmission({section,url,minimum:1},dependencies(f));
    assert.equal(r.kind,'blocked');assert.equal(r.count,0);
  });
  test(`${section}: lời hoàn tất đúng toàn bài vẫn nhận khi thiếu bước chuẩn`,async()=>{
    const f=fixture(section,['independent']),quote='Chúc mừng bạn đã hoàn thành toàn bộ bài luyện '+(section==='object_function'?'Tả vật Chức năng Zoom-In Story':'Tả vật What If kết bài giả định')+'.';
    f.messages.push({role:'assistant',text:quote+' Bạn có muốn luyện thêm không?'});
    const r=await checkSubmission({section,url,minimum:1},dependencies(f,{completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:f.messages.length,quote}));
    assert.equal(r.kind,'pass');assert.equal(r.acceptanceBasis,'chatbot_completion');assert.equal(r.count,0);
  });
  test(`${section}: lời chúc mừng rồi giao thử thách bắt buộc không được tính hoàn tất`,async()=>{
    const f=fixture(section,['independent']),quote='Chúc mừng bạn đã hoàn thành phần luyện tập có hướng dẫn.';
    f.messages.push({role:'assistant',text:quote+' Bây giờ sang Phần 3: Thử thách cuối. Nhiệm vụ của bạn là tự viết bài cho đề mới. Hãy gửi câu trả lời của bạn.'});
    const r=await checkSubmission({section,url,minimum:1},dependencies(f,{completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:f.messages.length,quote}));
    assert.notEqual(r.kind,'pass');
  });
  test(`${section}: sai kỹ năng hoặc dẫn chứng bịa không được nhận`,async()=>{
    const f=fixture(section);f.rounds[0].evidence[0].answerQuote='Không tồn tại trong hội thoại';
    const r=await checkSubmission({section,url,minimum:1},dependencies(f));assert.equal(r.kind,'error');
  });
  test(`${section}: trích nguyên đoạn chúc mừng kèm thử thách vẫn là bước giữa`,async()=>{
    const f=fixture(section,['independent']);
    const quote='Chúc mừng bạn đã hoàn thành xuất sắc buổi luyện tập! Bây giờ là lúc thử thách phản xạ. Nhiệm vụ của bạn là tự viết bài cho đề mới. Hãy gửi câu trả lời của bạn.';
    f.messages.push({role:'assistant',text:quote});
    const r=await checkSubmission({section,url,minimum:1},dependencies(f,{completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:f.messages.length,quote}));
    assert.notEqual(r.kind,'pass');
  });
}
test('Lesson14: CTA đúng lesson, mã, lớp và Doc riêng',()=>{
  const u=new URL(speakingCopyUrl({assignmentCode:code,classCode:'LOPMAU',documentId:'doc-fixture'}));
  assert.equal(u.pathname,'/izone-ai-team-pages/speaking-homework/lesson-14.html');
  assert.equal(u.searchParams.get('assignmentCode'),code);assert.equal(u.searchParams.get('class'),'LOPMAU');assert.equal(u.searchParams.get('documentId'),'doc-fixture');
});
test('Lesson14: tiến độ 1/5, nhãn lượt và bổ trợ ngắn trước receipt',()=>{
  const r=progressPayload({parts:['object_description','object_function','object_what_if'].map(part_key=>({part_key})),links:[{kind:'main',part:'object_function',status:'accepted',question_count:1}],requiredPracticeCount:2,assignmentCode:code,documentId:'doc-fixture',independent:true});
  assert.match(r.text,/Đã xác nhận 1\/5 phần/);assert.match(r.text,/Tả vật – Chức năng: đã xác nhận 1 lượt/);
  assert.match(r.text,/Tả vật – What if: chưa xác nhận/);assert.match(r.text,/Bổ trợ 2: chưa xác nhận/);assert.equal(r.receiptId,null);
});
