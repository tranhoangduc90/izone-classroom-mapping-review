import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSubmission } from '../src/speaking-checker.js';
import { speakingCopyUrl } from '../src/speaking-classroom-copies.js';
import { progressPayload } from '../src/speaking-progress-docs.js';

// Dữ liệu giả theo ba prompt nguồn; kiểm kết quả/ranh giới bằng chứng, không gọi AI hay Docs.
const stages = {
  person_intro:['identity','reason','introduction','transfer'],
  person_traits:['attribute_proof','attributes','setup','action','resolution','recollection','transfer'],
  person_ending:['trait','influence','bridge','ending','transfer']
};
function fixture(section) {
  const messages=[],completed=[];
  for(const [i,stage] of stages[section].entries()) {
    const q=messages.length+1;
    messages.push({role:'assistant',text:`Hãy luyện ${stage} của bài ${section}.`},
      {role:'user',text:`Tôi tự thực hành bước ${i+1} với ý tưởng và câu trả lời của mình.`},
      {role:'assistant',text:`Góp ý cho phần ${stage} của bạn.`});
    completed.push({stage,questionMessage:q,questionText:messages[q-1].text,answerMessage:q+1,answerQuote:messages[q].text,feedbackMessage:q+2});
  }
  return {messages,completed};
}
const run=(section,chat=fixture(section),extra={})=>checkSubmission({section,minimum:1,url:'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111'},{
  readShare:async()=>({messages:chat.messages,source:'fixture'}),
  analyzePerson:async(s)=>{assert.equal(s,section);return {confidence:0.95,completed:chat.completed};},
  analyzeCompletion:async()=>({completed:false,confidence:0.99}),...extra
});
for(const section of Object.keys(stages)) {
  test(`${section}: đủ một lượt, có snapshot và không bắt ngoại hình hay nói lại`,async()=>{
    const r=await run(section);assert.equal(r.kind,'pass');assert.equal(r.count,1);assert.equal(r.countVerified,true);assert.equal(r.acceptanceBasis,'standard');assert.ok(r.snapshot);
  });
  test(`${section}: thiếu từng bước kể cả thử thách cuối chưa hoàn thành`,async()=>{
    for(let i=0;i<stages[section].length;i++){const chat=fixture(section);chat.completed.splice(i,1);assert.notEqual((await run(section,chat)).kind,'pass',stages[section][i]);}
  });
  test(`${section}: sai vai trò, bịa dẫn chứng, trùng bước hoặc đảo bước không được nhận`,async()=>{
    for(const mutate of [x=>{x[0].answerMessage=1;},x=>{x[0].answerQuote='Trích dẫn bịa không có trong bản gốc';},x=>{x[1]=x[0];},x=>{[x[0],x[1]]=[x[1],x[0]];}]){
      const chat=fixture(section);mutate(chat.completed);assert.notEqual((await run(section,chat)).kind,'pass');
    }
  });
  test(`${section}: lỗi dịch vụ và độ chắc chắn thấp không bị kết luận thiếu bài`,async()=>{
    for(const extra of [{readShare:async()=>{throw Error('OFFLINE');}},{analyzePerson:async()=>{throw Error('TIMEOUT');}},{analyzePerson:async()=>({confidence:0.1,completed:[]})}])assert.equal((await run(section,fixture(section),extra)).kind,'error');
  });
  test(`${section}: chatbot xác nhận toàn bài thiếu bước vẫn nhận, lời học viên không được nhận`,async()=>{
    for(const role of ['assistant','user']){
      const chat=fixture(section);chat.completed=[];chat.messages.push({role,text:'Chúc mừng bạn đã hoàn thành toàn bộ bài luyện Tả người hôm nay.'});
      const r=await run(section,chat,{analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:chat.messages.length,quote:chat.messages.at(-1).text})});
      assert.equal(r.kind==='pass',role==='assistant');
      if(role==='assistant'){assert.equal(r.acceptanceBasis,'chatbot_completion');assert.ok(r.snapshot);}
    }
  });
}
test('Tả người: lời xong bước giữa còn giao Part 3 không phải hoàn thành',async()=>{
  const chat=fixture('person_intro');chat.completed=[];chat.messages.push({role:'assistant',text:'Bạn đã hoàn thành Phần 2. Bây giờ chuyển sang Part 3: hãy trả lời đề thử thách mới.'});
  const r=await run('person_intro',chat,{analyzeCompletion:async()=>({completed:true,matched:true,confidence:0.99,scope:'whole_practice',message:chat.messages.length,quote:chat.messages.at(-1).text})});
  assert.notEqual(r.kind,'pass');
});
test('Tả người: snapshot 95.000 ký tự giữ nguyên, vượt trần chung không nhận',async()=>{
  const chat=fixture('person_intro');chat.messages[0].text+='x'.repeat(95_000);
  const r=await run('person_intro',chat);assert.equal(r.kind,'pass');assert.ok(r.snapshot.messages[0].text.length>95_000);
  chat.messages[0].text+='x'.repeat(70_000);assert.equal((await run('person_intro',chat)).kind,'error');
});
test('Lesson 15: CTA giữ Doc/lớp và đúng route, không rơi về lesson cũ',()=>{
  const u=new URL(speakingCopyUrl({documentId:'doc_fixture',classCode:'LOPTHU',assignmentCode:'67-speaking-ta_nguoi'}));
  assert.equal(u.pathname,'/izone-ai-team-pages/speaking-homework/lesson-15.html');
  assert.equal(u.searchParams.get('documentId'),'doc_fixture');assert.equal(u.searchParams.get('class'),'LOPTHU');assert.equal(u.searchParams.get('assignmentCode'),'67-speaking-ta_nguoi');
});
test('Lesson 15: nhận một phần có tiến độ 1/5 trước receipt; bổ trợ giữ nhãn ngắn',()=>{
  const parts=[{part_key:'person_intro',display_title:'Tả người – Giới thiệu'},{part_key:'person_traits',display_title:'Tả người – Đặc điểm'},{part_key:'person_ending',display_title:'Tả người – Kết thúc'}];
  const p=progressPayload({parts,links:[{kind:'main',part:'person_intro',status:'accepted',question_count:1}],requiredPracticeCount:2,assignmentCode:'67-speaking-ta_nguoi',documentId:'doc_fixture',independent:true});
  assert.match(p.text,/1\/5 phần/);assert.match(p.text,/Tả người – Giới thiệu: đã xác nhận/);assert.match(p.text,/Bổ trợ 1: chưa xác nhận/);assert.match(p.text,/Bổ trợ 2: chưa xác nhận/);assert.equal(p.receiptId,null);assert.doesNotMatch(p.text,/Đã nộp bài thành công/);
});
