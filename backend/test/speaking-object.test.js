import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSubmission } from '../src/speaking-checker.js';
import { checkObjectSubmission, validObjectEvidence } from '../src/speaking-object-checker.js';
import { speakingCopyUrl } from '../src/speaking-classroom-copies.js';
import { progressPayload } from '../src/speaking-progress-docs.js';

const url = 'https://chatgpt.com/share/6906288f-7cb4-8011-bc18-643333fa38b4';
const intro = ['identity', 'origin', 'reason', 'combined'];
const description = ['appearance', 'size_material', 'content', 'function', 'life_example', 'combined'];
// Nhận danh sách bước; tạo lời thoại giả theo đúng vai trò, giữ mọi kiểm thử ngoài dịch vụ thật.
function fixture(groups) {
  const messages = [], rounds = [];
  for (const stages of groups) {
    const evidence = [];
    for (const stage of stages) {
      const q = messages.push({ role: 'assistant', text: `Hãy luyện ${stage} cho món đồ của bạn, lượt ${rounds.length + 1}.` });
      const a = messages.push({ role: 'user', text: stage === 'content' ? 'Đồ vật không có nội dung, tôi bỏ qua phần này.' : `I have a useful object. My answer for ${stage}, round ${rounds.length + 1}.` });
      const f = messages.push({ role: 'assistant', text: 'Tôi đã đọc câu trả lời và góp ý cho phần bạn vừa luyện.' });
      evidence.push({ stage, questionMessage:q, questionText:messages[q-1].text, answerMessage:a, answerQuote:messages[a-1].text, feedbackMessage:f });
    }
    rounds.push({ evidence });
  }
  return { messages, rounds };
}
function dependencies(f, overrides = {}) {
  return { readShare:async()=>({messages:f.messages,source:'fixture'}),
    analyzeObject:async()=>({rounds:f.rounds,confidence:0.95}),
    analyzeCompletion:async()=>({completed:false,confidence:1}), ...overrides };
}
test('mở bài cần hai lượt đầy đủ; dispatch dùng đúng ngưỡng và giữ snapshot', async()=>{
  const f=fixture([intro,intro]);
  const result=await checkSubmission({section:'object_intro',url,minimum:2},dependencies(f));
  assert.equal(result.kind,'pass');assert.equal(result.count,2);
  assert.equal(result.acceptanceBasis,'standard');assert.ok(result.snapshot);assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
});
test('một lượt mở bài chưa đủ ngưỡng hai',async()=>{
  const f=fixture([intro]);const r=await checkObjectSubmission({section:'object_intro',url},dependencies(f));
  assert.equal(r.kind,'blocked');assert.equal(r.count,1);
});
test('mô tả một vật chấp nhận không có nội dung và không yêu cầu đủ năm giác quan',async()=>{
  const f=fixture([description]);const r=await checkSubmission({section:'object_description',url,minimum:1},dependencies(f));
  assert.equal(r.kind,'pass');assert.equal(r.count,1);
});
test('thiếu đoạn tự ghép chưa hoàn thành lượt',async()=>{
  const f=fixture([description.slice(0,-1)]);const r=await checkObjectSubmission({section:'object_description',url},dependencies(f));
  assert.equal(r.kind,'blocked');assert.equal(r.count,0);
});
test('bài tự luyện được gộp các ý trong một câu trả lời đầy đủ',()=>{
  const f=fixture([intro]);const e=f.rounds[0].evidence[0];
  f.rounds=[{evidence:intro.map(stage=>({...e,stage}))}];
  assert.equal(validObjectEvidence('object_intro',f.messages,f.rounds).length,1);
});
for(const [name,change] of [
  ['trích dẫn bịa',f=>{f.rounds[0].evidence[0].answerQuote='Câu này không tồn tại';}],
  ['sai vai trò',f=>{f.rounds[0].evidence[0].answerMessage=1;}],
  ['lặp bước',f=>{f.rounds[0].evidence[1].stage='identity';}],
  ['đảo thứ tự bước',f=>{f.rounds[0].evidence.reverse();}],
  ['dùng lại lượt trước',f=>{f.rounds.push(structuredClone(f.rounds[0]));}]
])test(`chặn bằng chứng ${name}`,()=>{
  const f=fixture([intro]);change(f);assert.throws(()=>validObjectEvidence('object_intro',f.messages,f.rounds));
});
test('AI không chắc chắn là chưa xác minh, không phải kết luận làm thiếu',async()=>{
  const f=fixture([intro]);const r=await checkObjectSubmission({section:'object_intro',url},dependencies(f,{analyzeObject:async()=>({confidence:0.5,rounds:[]})}));
  assert.equal(r.kind,'error');assert.match(r.message,/không phải kết luận/);
});
test('chatbot hoàn tất cả bài được công nhận dù chưa đủ hai lượt',async()=>{
  const f=fixture([intro]);const quote='Chúc mừng bạn đã hoàn thành toàn bộ bài luyện Mở bài tả vật!';
  f.messages.push({role:'assistant',text:quote+' Bạn có muốn luyện thêm không?'});
  const r=await checkObjectSubmission({section:'object_intro',url,minimum:2},dependencies(f,{analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:f.messages.length,quote})}));
  assert.equal(r.kind,'pass');assert.equal(r.acceptanceBasis,'chatbot_completion');assert.equal(r.count,1);
});
test('xong bước giữa rồi còn giao bước bắt buộc không phải xong cả bài',async()=>{
  const f=fixture([intro.slice(0,2)]),quote='Bạn đã hoàn thành bước 2 rất tốt.';
  f.messages.push({role:'assistant',text:quote+' Bây giờ sang Bước 3: thực hành lý do có món đồ. Hãy trả lời câu hỏi này.'});
  const r=await checkObjectSubmission({section:'object_intro',url},dependencies(f,{analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:f.messages.length,quote})}));
  assert.equal(r.kind,'error');assert.notEqual(r.acceptanceBasis,'chatbot_completion');
});
test('snapshot giữ hội thoại dài hơn giới hạn 80.000 cũ',async()=>{
  const f=fixture([description]);f.messages[1].text+=' x'.repeat(45000);
  const r=await checkObjectSubmission({section:'object_description',url},dependencies(f));
  assert.equal(r.kind,'pass');assert.ok(JSON.stringify(r.snapshot).length>90000);
});
test('lỗi đọc Share và link riêng tư không được nhận',async()=>{
  const f=fixture([intro]);
  assert.equal((await checkObjectSubmission({section:'object_intro',url:'https://chatgpt.com/c/private'},dependencies(f))).kind,'blocked');
  assert.equal((await checkObjectSubmission({section:'object_intro',url},dependencies(f,{readShare:async()=>{throw Error('network');}}))).kind,'error');
});
test('CTA Lesson 13 giữ đúng lớp và Doc riêng',()=>{
  const u=new URL(speakingCopyUrl({documentId:'document-fixture',classCode:'LOPMAU',assignmentCode:'67-speaking-ta_vat_gioi_thieu_mieu_ta'}));
  assert.equal(u.pathname,'/izone-ai-team-pages/speaking-homework/lesson-13.html');
  assert.equal(u.searchParams.get('documentId'),'document-fixture');assert.equal(u.searchParams.get('class'),'LOPMAU');
});
test('một phần accepted có tiến độ đúng tên và đơn vị lượt trước khi có receipt',()=>{
  const r=progressPayload({parts:[{part_key:'object_intro'},{part_key:'object_description'}],links:[{kind:'main',part:'object_intro',status:'accepted',question_count:2}],requiredPracticeCount:2,assignmentCode:'67-speaking-ta_vat_gioi_thieu_mieu_ta',documentId:'document-fixture',independent:true});
  assert.match(r.text,/Đã xác nhận 1\/4 phần/);assert.match(r.text,/Mở bài tả vật: đã xác nhận 2 lượt/);
  assert.match(r.text,/Miêu tả chi tiết một vật: chưa xác nhận/);assert.match(r.text,/Bổ trợ 1: chưa xác nhận/);
  assert.equal(r.receiptId,null);assert.match(r.link,/teacher-progress\.html/);
});
