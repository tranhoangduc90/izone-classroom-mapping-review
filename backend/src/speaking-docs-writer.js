const STATUS_HEADING = 'TÌNH TRẠNG NỘP BÀI SPEAKING';
const STATUS_TEXT = 'Đã nộp bài thành công - giảng viên nhấn vào link này để xem chi tiết.';
const LINK_TEXT = 'link này';

function cellRuns(cell) {
  return (cell?.content || []).flatMap(item => item.paragraph?.elements || [])
    .filter(item => item.textRun).map(item => ({
      text: item.textRun.content || '', start: item.startIndex,
      end: item.endIndex, link: item.textRun.textStyle?.link?.url || ''
    }));
}
function cellText(cell) { return cellRuns(cell).map(run => run.text).join('').trim(); }
function statusCell(document, tabId) {
  const tab = document.tabs?.find(item => item.tabProperties?.tabId === tabId);
  if (!tab) throw new Error('DOC_TAB_NOT_FOUND');
  const matches = [];
  function walk(content) {
    for (const element of content || []) {
      if (!element.table) continue;
      const rows = element.table.tableRows || [];
      for (let i = 0; i < rows.length - 1; i += 1) {
        const heading = rows[i].tableCells?.[0];
        if (cellText(heading) === STATUS_HEADING) {
          const target = rows[i + 1].tableCells?.[0];
          if (target) matches.push(target);
        }
      }
      for (const row of rows) for (const cell of row.tableCells || []) walk(cell.content);
    }
  }
  walk(tab.documentTab?.body?.content);
  if (matches.length !== 1) throw new Error('DOC_STATUS_CELL_AMBIGUOUS');
  return matches[0];
}

// Dữ liệu vào: Docs JSON đã đọc, đúng Doc ID, receipt và URL màn giáo viên.
// Việc chính: chỉ nhắm ô vàng dưới heading, gắn link lên đúng hai từ, khóa revision.
// Kết quả: batchUpdate có thể chạy một lần; khi đã ghi đúng thì trả no-op.
export function planSpeakingStatusWrite({ document, documentId, tabId = 't.0', receiptId, teacherBaseUrl }) {
  if (document.documentId !== documentId || !document.revisionId) throw new Error('DOC_IDENTITY_MISMATCH');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(receiptId)) throw new Error('RECEIPT_ID_INVALID');
  const teacherUrl = new URL(teacherBaseUrl);
  if (teacherUrl.protocol !== 'https:' || teacherUrl.origin !== 'https://tranhoangduc90.github.io'
    || !teacherUrl.pathname.endsWith('/speaking-homework/teacher.html')) {
    throw new Error('TEACHER_URL_INVALID');
  }
  teacherUrl.search = '';
  teacherUrl.searchParams.set('receipt', receiptId);
  const linkUrl = teacherUrl.href;
  const cell = statusCell(document, tabId);
  const existing = cellText(cell);
  if (existing === STATUS_TEXT) {
    const runs = cellRuns(cell);
    if (runs.some(run => run.text.includes(LINK_TEXT) && run.link === linkUrl)) {
      return { status: 'already_current', linkUrl, requests: [], revisionId: document.revisionId };
    }
    throw new Error('DOC_STATUS_LINK_MISMATCH');
  }
  if (existing) throw new Error('DOC_STATUS_CELL_NOT_EMPTY');
  const paragraph = cell.content?.find(item => item.paragraph);
  if (!paragraph || paragraph.startIndex == null) throw new Error('DOC_STATUS_PARAGRAPH_MISSING');
  const start = paragraph.startIndex;
  const linkStart = start + STATUS_TEXT.indexOf(LINK_TEXT);
  return {
    status: 'write', linkUrl, revisionId: document.revisionId,
    requests: [
      { insertText: { location: { index: start, tabId }, text: STATUS_TEXT } },
      { updateTextStyle: { range: { startIndex: linkStart,
        endIndex: linkStart + LINK_TEXT.length, tabId },
        textStyle: { link: { url: linkUrl }, underline: true }, fields: 'link,underline' } }
    ]
  };
}

export function verifySpeakingStatusWrite({ document, documentId, tabId = 't.0', linkUrl }) {
  if (document.documentId !== documentId) return false;
  const cell = statusCell(document, tabId);
  return cellText(cell) === STATUS_TEXT
    && cellRuns(cell).some(run => run.text.includes(LINK_TEXT) && run.link === linkUrl);
}
