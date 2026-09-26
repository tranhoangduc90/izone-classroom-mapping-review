import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const STUDENT_REF = '11111111-1111-4111-8111-111111111111';
const MIME = { '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8' };

// Dữ liệu vào: kết quả chỉ của bài giả từ /__canary/result và source Pages đã ghim.
// Việc chính: mở trang Term trong Chrome cô lập, cấp đúng kết quả cùng attempt qua API giả.
// Kết quả: kiểm điểm, Task, bài viết, bốn nhận xét và tải lại; không gọi API/Portal thật.
// Khi lỗi: test đỏ, đóng browser/server và chỉ xuất mã bước, không in payload kết quả.
export async function verifyTermCanaryBrowserResult({ result, pagesRoot }) {
  const slug = String(result?.testSlug ?? '');
  const className = String(result?.className ?? '');
  const attemptToken = String(result?.attemptToken ?? '');
  const task = result?.writing?.grading?.tasks?.[0];
  if (result?.ok !== true || !['term-test-1-k56', 'term-test-2-k56'].includes(slug)
    || className !== 'CODEX-CANARY' || result?.studentName !== 'Học viên giả'
    || !/^[0-9a-f-]{36}$/iu.test(attemptToken) || result?.writing?.grading?.ready !== true
    || result?.writing?.grading?.tasks?.length !== 1
    || Number(task?.taskNumber) !== (slug === 'term-test-1-k56' ? 2 : 1)
    || !Number.isFinite(Number(result?.writing?.grading?.writingScore))
    || typeof pagesRoot !== 'string' || !pagesRoot) {
    throw new Error('CANARY_BROWSER_INPUT_INVALID');
  }
  const siteRoot = resolve(pagesRoot);
  const modules = process.env.CODEX_NODE_MODULES || resolve(
    process.env.USERPROFILE || '', '.cache', 'codex-runtimes',
    'codex-primary-runtime', 'dependencies', 'node', 'node_modules'
  );
  const { chromium } = createRequire(pathToFileURL(resolve(modules,
    'playwright', 'package.json')).href)('playwright');
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const target = resolve(siteRoot, `.${relative}`);
    if (!target.startsWith(`${siteRoot}${sep}`)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' });
      res.end(await readFile(target));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const siteBase = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      const calls = [];
      const blocked = [];
      const errors = [];
      page.on('pageerror', error => errors.push(error.name));
      await page.addInitScript(({ testSlug, classCode, token }) => {
        localStorage.setItem(`izone-test:${testSlug}:${classCode}`, JSON.stringify({
          studentRef: '11111111-1111-4111-8111-111111111111',
          studentName: 'Học viên giả', attemptToken: token,
          completed: true, writingStarted: true, writingSubmitted: true
        }));
      }, { testSlug: slug, classCode: className, token: attemptToken });
      await context.route('**/*', async route => {
        const req = route.request();
        const url = new URL(req.url());
        if (/\/k56(?:-test2)?-shared\/config\.js$/u.test(url.pathname)) {
          return route.fulfill({ contentType: 'text/javascript',
            body: "window.TERM_TEST_APP_CONFIG={API_BASE_URL:'https://ducizone.ddns.net/mapping-api'};" });
        }
        if (url.pathname === '/mapping-api/api/term-tests/roster') {
          return route.fulfill({ json: { class: { name: className },
            students: [{ ref: STUDENT_REF, name: 'Học viên giả' }] } });
        }
        if (url.pathname === '/mapping-api/api/term-tests/result' && req.method() === 'POST') {
          const body = req.postDataJSON();
          calls.push(body?.attemptToken);
          return route.fulfill({ json: result });
        }
        if (url.pathname === `/mapping-api/api/term-tests/${slug}/session/resume-attempt`) {
          const content = await page.evaluate(() => window.K56_TERM_TEST_CONTENT);
          return route.fulfill({ json: { content, serverNow: new Date().toISOString(),
            attemptToken, listeningSubmitted: true } });
        }
        if (url.pathname === '/mapping-api/api/term-tests/result/stream') {
          return route.fulfill({ status: 404, json: { message: 'Canary: đọc kết quả.' } });
        }
        if (req.method() === 'GET' && req.url().startsWith(siteBase)) return route.continue();
        blocked.push(`${req.method()} ${url.pathname}`);
        return route.abort();
      });
      await page.goto(`${siteBase}term-tests/${slug}-computer-based/?class=${className}`);
      const card = page.locator('#writingSubmissionResult .writing-score-card.is-action');
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      const scoreText = await card.innerText();
      assert.ok(scoreText.includes(`Writing Task ${task.taskNumber}`), 'CANARY_BROWSER_TASK_MISMATCH');
      assert.ok(scoreText.includes(`Band ${result.writing.grading.writingScore}`),
        'CANARY_BROWSER_SCORE_MISMATCH');
      await card.click();
      const dialog = page.locator('.writing-feedback-dialog');
      await dialog.waitFor({ state: 'visible' });
      const essay = task.taskNumber === 1 ? result.writing.task1 : result.writing.task2;
      assert.equal(await dialog.locator('.writing-feedback-essay').innerText(), essay);
      assert.equal(await dialog.locator('.writing-band-summary-item').count(), 4);
      assert.ok((await dialog.innerText()).includes(task.report), 'CANARY_BROWSER_REPORT_MISMATCH');
      const cards = dialog.locator('.writing-criterion-card');
      assert.equal(await cards.count(), task.criteria.length);
      for (let index = 0; index < task.criteria.length; index += 1) {
        const row = task.criteria[index];
        const criterion = cards.nth(index);
        const components = Array.isArray(row.components) ? row.components : [];
        if (!components.length) {
          assert.ok((await criterion.innerText()).includes(row.feedback),
            `CANARY_BROWSER_FEEDBACK_MISMATCH_${row.code}`);
          continue;
        }
        const rendered = criterion.locator('.writing-component');
        assert.ok((await rendered.count()) >= components.length,
          `CANARY_BROWSER_COMPONENT_COUNT_${row.code}`);
        for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
          const component = components[componentIndex];
          const panel = rendered.nth(componentIndex);
          if (component.summary) {
            assert.ok((await panel.innerText()).includes(component.summary),
              `CANARY_BROWSER_COMPONENT_SUMMARY_${row.code}`);
          }
          if (component.feedback) {
            await panel.locator('.writing-component-toggle').click();
            assert.ok((await panel.innerText()).includes(component.feedback),
              `CANARY_BROWSER_COMPONENT_DETAIL_${row.code}`);
          }
        }
      }
      await page.reload();
      await card.waitFor({ state: 'visible' });
      await card.click();
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.locator('.writing-feedback-essay').innerText(), essay);
      assert.ok(calls.length >= 2 && calls.every(token => token === attemptToken),
        'CANARY_BROWSER_ATTEMPT_MISMATCH');
      assert.deepEqual(blocked, [], 'CANARY_BROWSER_EXTERNAL_REQUEST');
      assert.deepEqual(errors, [], 'CANARY_BROWSER_PAGE_ERROR');
      return { passed: true, testSlug: slug, taskNumber: task.taskNumber,
        resultReads: calls.length, externalRequests: 0, pageErrors: 0 };
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
  }
}
