// Kiểm thao tác nhập hai Task qua textarea và tab thật, kể cả máy nhập chậm.
// Đồng hồ chỉ dừng khi nhập cặp ô; sau đó bộ lưu tự động gốc vẫn chạy một lần.
const test=require('node:test');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {chromium}=createRequire('C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json')('playwright');
const subject=process.env.D08_PAIR_SUBJECT||require.resolve('./ui-canary.cjs');
const {fillWritingPair}=require(subject);

test('nhập chậm hai Task vẫn tạo đúng một lần lưu đủ cặp',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'});
  try{
    const page=await browser.newPage();
    await page.clock.install();
    await page.setContent(`<div id="writingTaskTabs"><button onclick="a.hidden=false;b.hidden=true">Task 1</button><button onclick="a.hidden=true;b.hidden=false">Task 2</button></div>
      <textarea id="a" data-writing-task="task1"></textarea><textarea id="b" data-writing-task="task2" hidden></textarea>
      <script>window.saved=[];let timer;for(const input of [a,b])input.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>saved.push({task1:a.value,task2:b.value}),100);});</script>`);
    // Trễ sau mỗi lần fill là điều kiện tái hiện; không thay state hoặc bộ lưu của trang.
    const wrapped={clock:page.clock,evaluate:(...args)=>page.evaluate(...args),locator(selector){
      const locator=page.locator(selector);
      if(!selector.startsWith('[data-writing-task='))return locator;
      return {isVisible:()=>locator.isVisible(),async fill(value){await locator.fill(value);await new Promise(resolve=>setTimeout(resolve,350));}};
    }};
    const pair={task1:'Bản giả Task 1',task2:'Bản giả Task 2'};
    await fillWritingPair(wrapped,pair);
    await page.waitForFunction(()=>saved.length>0);
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(()=>saved),[pair]);
  }finally{await browser.close();}
});
