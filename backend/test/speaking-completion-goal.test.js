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

test('worded early-step completion cannot pass when a required Part 3 task follows',()=>{
  const quote='Bạn đã hoàn thành cả ba bước đầu tiên!';
  const messages=[{role:'assistant',text:quote+'\n\n## Bước 4: Thực hành tự do với IELTS Speaking Part 3\nWhat can people do to stay healthy?\nHãy trả lời bằng 4–6 câu. Đến lượt bạn!\n\nNếu bạn muốn, tôi có thể cho thêm gợi ý.'}];
  assert.throws(()=>validateCompletion(messages,{completed:true,matched:true,confidence:.99,scope:'whole_practice',message:1,quote}),/COMPLETION_STEP_ONLY/);
});

test('early-step candidates are removed before AI so a late optional menu cannot override the required task',async()=>{
  const messages=[{role:'assistant',text:'Bạn đã hoàn thành cả ba bước đầu tiên!\n\n## Bước 4: Thực hành tự do với Part 3\nWhy should people exercise?\nĐến lượt bạn!\n\nNếu bạn muốn, tôi có thể đưa thêm gợi ý.'}];
  const result=await analyzeChatbotCompletion(messages,'Cấu trúc song song',async()=>{throw Error('AI_MUST_NOT_APPROVE_EARLY_STEP');});
  assert.equal(result.completed,false);
});

test('completed points do not replace a required whole-answer repetition',()=>{
  const quote='Bạn đã hoàn thành 2 điểm làm rõ và một câu phát triển tổng quan.';
  const messages=[{role:'assistant',text:quote+'\n\nHãy ghép toàn bộ thành một câu trả lời hoàn chỉnh. Nhiệm vụ: hãy nói lại toàn bộ câu trả lời từ đầu đến cuối. Your turn!'}];
  assert.throws(()=>validateCompletion(messages,{completed:true,matched:true,confidence:.99,scope:'whole_practice',message:1,quote}),/COMPLETION_STEP_ONLY/);
});

test('an explicit whole-practice confirmation survives a later change of mind',()=>{
  const quote='Bạn đã hoàn thành toàn bộ bài luyện hôm nay.';
  const messages=[{role:'assistant',text:quote},{role:'assistant',text:'Bây giờ sang Bước 4 luyện Part 3. Why do people travel?'}];
  assert.equal(validateCompletion(messages,{completed:true,matched:true,confidence:.99,scope:'whole_practice',message:1,quote}).message,1);
});
