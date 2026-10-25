import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeChatbotCompletion,validateCompletion} from '../src/speaking-completion-policy.js';

test('recognizes final mastery confirmation before optional additional practice',async()=>{
  const messages=[{role:'assistant',text:'Bạn đã hoàn thành Bước 1 và Bước 2. Bước 3 cần trả lời hai câu Part 1.'},
    {role:'user',text:'I like reading, swimming and cooking.'},
    {role:'assistant',text:'Bạn đã đạt tiêu chí của Bước 3: trả lời hai câu hỏi Part 1 với tối đa một lỗi nhỏ về từ nối.\n\nBạn muốn luyện thêm một câu nữa không?'}];
  const result=await analyzeChatbotCompletion(messages,'Liệt kê với and, or',async(_url,options)=>{
    const prompt=JSON.parse(options.body).prompt;
    const candidates=JSON.parse(prompt.split('CÁC LỜI ỨNG VIÊN (vẫn phải phân biệt ví dụ và kết thúc bước nhỏ):\n\n')[1].split('\n\nNGỮ CẢNH HỘI THOẠI:')[0]);
    const final=candidates.find(c=>c.quote.includes('đạt tiêu chí'));
    return {ok:true,json:async()=>({text:JSON.stringify(final?{completed:true,matched:true,confidence:.99,scope:'whole_practice',candidateId:final.id}:{completed:false,confidence:1})})};
  });
  assert.equal(result.completed,true);
  assert.equal(validateCompletion(messages,result).message,3);
});

test('a step goal followed by required practice is not whole-practice completion',()=>{
  const messages=[{role:'assistant',text:'Bạn đã đạt mục tiêu Bước 2. Bây giờ chuyển sang Bước 3 luyện Part 1.'}];
  assert.throws(()=>validateCompletion(messages,{completed:true,matched:true,confidence:.99,scope:'whole_practice',message:1,quote:messages[0].text}),/COMPLETION_STEP_ONLY/);
});
