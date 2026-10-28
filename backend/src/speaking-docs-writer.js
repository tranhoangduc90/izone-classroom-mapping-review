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
function isCurrentStatus(cell, linkUrl) {
  const content = cell.content || [];
  if (content.length !== 1 || !content[0].paragraph || content[0].paragraph.bullet) return false;
  const elements = content[0].paragraph.elements || [];
  if (elements.some(element => !element.textRun)) return false;
  const runs = cellRuns(cell);
  return runs.map(run => run.text).join('') === `${STATUS_TEXT}\n`
    && runs.some(run => run.text.includes(LINK_TEXT) && run.link === linkUrl);
}
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
// Việc chính: xóa mọi nội dung trong đúng ô vàng, giữ newline cuối và khóa revision.
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
  if (isCurrentStatus(cell, linkUrl)) {
    return { status: 'already_current', linkUrl, requests: [], revisionId: document.revisionId };
  }
  const first = cell.content?.[0];
  const last = cell.content?.at(-1);
  const start = first?.startIndex;
  const end = last?.endIndex ?? last?.paragraph?.elements?.at(-1)?.endIndex;
  const finalRun = last?.paragraph?.elements?.at(-1)?.textRun?.content;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start
    || !finalRun?.endsWith('\n')) throw new Error('DOC_STATUS_RANGE_INVALID');
  // Xóa chữ, hình nội tuyến và bảng lồng; newline cuối giữ cấu trúc ô nguyên vẹn.
  const deleteEnd = end - 1;
  const linkStart = start + STATUS_TEXT.indexOf(LINK_TEXT);
  const messageRange = { startIndex: start, endIndex: start + STATUS_TEXT.length, tabId };
  return {
    status: 'write', linkUrl, revisionId: document.revisionId,
    requests: [
      ...(deleteEnd > start ? [{ deleteContentRange: {
        range: { startIndex: start, endIndex: deleteEnd, tabId }
      } }] : []),
      { insertText: { location: { index: start, tabId }, text: STATUS_TEXT } },
      // Nội dung mới không mang danh sách hoặc hyperlink cũ; chỉ cụm link có URL mới.
      { deleteParagraphBullets: { range: messageRange } },
      { updateTextStyle: { range: messageRange,
        textStyle: { underline: false }, fields: 'link,underline' } },
      { updateTextStyle: { range: { startIndex: linkStart,
        endIndex: linkStart + LINK_TEXT.length, tabId },
        textStyle: { link: { url: linkUrl }, underline: true }, fields: 'link,underline' } }
    ]
  };
}

export function verifySpeakingStatusWrite({ document, documentId, tabId = 't.0', linkUrl }) {
  if (document.documentId !== documentId) return false;
  const cell = statusCell(document, tabId);
  return isCurrentStatus(cell, linkUrl);
}
