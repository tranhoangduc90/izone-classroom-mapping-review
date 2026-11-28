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
  return { documentId, revisionId: 'revision-1', tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [
    { table: { tableRows: [
      { tableCells: [{ content: [{ paragraph: { elements: [
        { startIndex: 131, endIndex: 159, textRun: { content: 'TÌNH TRẠNG NỘP BÀI SPEAKING\n' } }
      ] } }] }] },
      { tableCells: [{ content: [{ startIndex: 163, paragraph: { elements } }] }] }
    ] } }
  ] } } }] };
}

test('writer chỉ điền ô vàng và gắn link lên đúng cụm từ, dùng revision', () => {
  const plan = planSpeakingStatusWrite({ document: fixture(), documentId,
    receiptId, teacherBaseUrl });
  assert.equal(plan.status, 'write');
  assert.equal(plan.requests[0].insertText.location.index, 163);
  const hyperlink=plan.requests.find(r=>r.updateTextStyle?.textStyle?.link).updateTextStyle;
  assert.equal(hyperlink.range.startIndex,
    163 + status.indexOf('link này'));
  assert.equal(hyperlink.range.tabId, 't.0');
  assert.equal(plan.revisionId, 'revision-1');
  assert.equal(verifySpeakingStatusWrite({ document: fixture(status + '\n', plan.linkUrl),
    documentId, linkUrl: plan.linkUrl }), true);
  const repeat = planSpeakingStatusWrite({ document: fixture(status + '\n', plan.linkUrl),
    documentId, receiptId, teacherBaseUrl });
  assert.equal(repeat.status, 'already_current');
  assert.equal(repeat.requests.length, 0);
});

test('writer giữ nguyên ghi chú, hyperlink riêng và đối tượng nội tuyến', () => {
  const teacherDocs = [
    fixture('Ghi chú của giáo viên\n'),
    fixture(status + '\n', 'https://manual.example.invalid/teacher'),
    fixture(status + ' Ghi chú riêng của giáo viên\n', 'https://manual.example.invalid/teacher'),
    fixture(),
  ];
  const inline = teacherDocs.at(-1).tabs[0].documentTab.body.content[0].table.tableRows[1].tableCells[0];
  inline.content[0].paragraph.elements.unshift({ inlineObjectElement: { inlineObjectId: 'fixture-image' } });
  for (const document of teacherDocs) {
    assert.throws(() => planSpeakingStatusWrite({ document, documentId, receiptId, teacherBaseUrl }),
      /^Error: DOC_MANUAL_CONFLICT$/);
  }
});

test('writer chỉ bổ sung hyperlink khi còn đúng nguyên dòng biên nhận chưa có link', () => {
  const document = fixture(status + '\n');
  const plan = planSpeakingStatusWrite({ document, documentId, receiptId, teacherBaseUrl });
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].updateTextStyle.textStyle.link.url, teacherBaseUrl + '?receipt=' + receiptId);
  assert.equal(plan.requests[0].updateTextStyle.range.endIndex - plan.requests[0].updateTextStyle.range.startIndex, 8);
});

test('legacy writer distinguishes a matching read-only document from a wrong target',()=>{
  const document=fixture();
  delete document.revisionId;
  const input={document,documentId,receiptId,teacherBaseUrl};
  assert.throws(()=>planSpeakingStatusWrite(input),/^Error: DOC_WRITE_UNAVAILABLE$/);
  assert.throws(()=>planSpeakingStatusWrite({...input,documentId:'other'}),/^Error: DOC_IDENTITY_MISMATCH$/);
});
