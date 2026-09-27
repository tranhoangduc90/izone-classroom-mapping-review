import assert from 'node:assert/strict';
import test from 'node:test';
import { planSpeakingStatusWrite, verifySpeakingStatusWrite } from '../src/speaking-docs-writer.js';

const documentId = '1hx2XF1bJtNCZZXbwo8PyAlYHFwY4udsDmiqhEwqrA18';
const receiptId = 'a0000000-0000-4000-8000-000000000001';
const teacherBaseUrl = 'https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/teacher.html';
const status = 'Đã nộp bài thành công - giảng viên nhấn vào link này để xem chi tiết.';
function fixture(text = '\n', link = '') {
  const split = text.indexOf('link này');
  const elements = split < 0 ? [{ startIndex: 163, endIndex: 163 + text.length,
    textRun: { content: text } }] : [
    { startIndex: 163, endIndex: 163 + split, textRun: { content: text.slice(0, split) } },
    { startIndex: 163 + split, endIndex: 163 + split + 8,
      textRun: { content: 'link này', textStyle: { link: { url: link } } } },
    { startIndex: 163 + split + 8, endIndex: 163 + text.length,
      textRun: { content: text.slice(split + 8) } }
  ];
  return { documentId, revisionId: 'revision-1', tabs: [{ tabId: 't.0', body: { content: [
    { table: { tableRows: [
      { tableCells: [{ content: [{ paragraph: { elements: [
        { startIndex: 131, endIndex: 159, textRun: { content: 'TÌNH TRẠNG NỘP BÀI SPEAKING\n' } }
      ] } }] }] },
      { tableCells: [{ content: [{ startIndex: 163, paragraph: { elements } }] }] }
    ] } }
  ] } }] };
}

test('writer chỉ điền ô vàng và gắn link lên đúng cụm từ, dùng revision', () => {
  const plan = planSpeakingStatusWrite({ document: fixture(), documentId,
    receiptId, teacherBaseUrl });
  assert.equal(plan.status, 'write');
  assert.equal(plan.requests[0].insertText.location.index, 163);
  assert.equal(plan.requests[1].updateTextStyle.range.startIndex,
    163 + status.indexOf('link này'));
  assert.equal(plan.requests[1].updateTextStyle.range.tabId, 't.0');
  assert.equal(plan.revisionId, 'revision-1');
  assert.equal(verifySpeakingStatusWrite({ document: fixture(status + '\n', plan.linkUrl),
    documentId, linkUrl: plan.linkUrl }), true);
  const repeat = planSpeakingStatusWrite({ document: fixture(status + '\n', plan.linkUrl),
    documentId, receiptId, teacherBaseUrl });
  assert.equal(repeat.status, 'already_current');
  assert.equal(repeat.requests.length, 0);
});

test('writer dừng khi ô đã có nội dung khác hoặc link trỏ sang receipt khác', () => {
  assert.throws(() => planSpeakingStatusWrite({ document: fixture('Nội dung của người khác\n'),
    documentId, receiptId, teacherBaseUrl }), /DOC_STATUS_CELL_NOT_EMPTY/);
  assert.throws(() => planSpeakingStatusWrite({ document: fixture(status + '\n', 'https://example.test/wrong'),
    documentId, receiptId, teacherBaseUrl }), /DOC_STATUS_LINK_MISMATCH/);
});
