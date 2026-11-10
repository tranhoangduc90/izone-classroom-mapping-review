// Keep queue payloads and last_doc_text in their original one-line form. Only the
// Docs writer renders them, and it recognizes both layouts during rollout/retry.
const LINK_LABEL = 'nhấn vào đây';
const BREAKS = / (?=(?:Kết quả:|Giảng viên nhấn vào đây))/gu;
const EMPHASIS = /Luyện ChatGPT: (?:đã được công nhận|đang kiểm tra link|chưa hoàn thành)|(?:Đã (?:hoàn thành|bắt đầu|nộp)|Chưa bắt đầu|Bài lần)[^.\n(,]*(?:, (?:đang chờ chấm|chưa có kết quả chấm))?|Còn \d+ (?:phần|mục) cần sửa|(?:đúng |đạt )?\d+\/\d+(?: (?:câu đúng|câu|phần đạt|mục))?/gu;

function layout(text) {
  return text
    .replace(/^(Luyện ChatGPT: (?:đã được công nhận|đang kiểm tra link|chưa hoàn thành)\.) /u, '$1' + '\n')
    .replace(BREAKS, '\n');
}

function covered(runs, start, end, matches) {
  let point = start;
  for (const run of runs) {
    if (run.end <= point) continue;
    if (run.start > point || !matches(run.style)) return false;
    point = run.end;
    if (point >= end) return true;
  }
  return false;
}

function indexAt(runs, offset, fail) {
  for (const run of runs) {
    if (offset < run.text.length) return run.start + offset;
    offset -= run.text.length;
  }
  fail('DOC_STATUS_INVALID');
}

function managedOffsets(existing, prefix) {
  let offset = 0;
  const matches = [];
  for (const line of existing.split('\n')) {
    if (line.startsWith(prefix)) matches.push(offset);
    offset += line.length + 1;
  }
  return matches;
}

export function planDocsStatus({
  revisionId, tabId, runs, existing, previous, text, link, prefix = '',
  requirePrevious = false, linkError = 'DOC_LINK_LABEL_INVALID', fail,
}) {
  if (typeof text !== 'string' || /[\r\n]/u.test(text)) fail('DOC_STATUS_INVALID');
  // Rendering can be paused without making already-formatted blocks unreadable.
  const singleLine = process.env.IZONE_DOC_STATUS_SINGLE_LINE === '1';
  const raw = prefix + text;
  const target = singleLine ? raw : prefix + layout(text);
  const emphasis = singleLine ? [] : [...target.matchAll(EMPHASIS)];
  const linkOffset = target.indexOf(LINK_LABEL);
  if (link && linkOffset < 0) fail(linkError);

  const oldRaw = typeof previous === 'string' && previous ? prefix + previous : null;
  const known = [raw, prefix + layout(text), ...(oldRaw ? [oldRaw, prefix + layout(previous)] : [])]
    .sort((a, b) => b.length - a.length);

  let offset = 0;
  let old = existing;
  if (prefix) {
    const offsets = managedOffsets(existing, prefix);
    if (offsets.length > 1) fail('DOC_STATUS_AMBIGUOUS');
    offset = offsets[0] ?? existing.length;
    old = offsets.length ? known.find(candidate => {
      const end = offset + candidate.length;
      return existing.startsWith(candidate, offset) && (end === existing.length || existing[end] === '\n');
    }) : '';
    if (old === undefined || (!old && previous && requirePrevious)) fail('DOC_MANUAL_CONFLICT');
  } else if (existing && !known.includes(existing)) {
    fail('DOC_MANUAL_CONFLICT');
  } else if (!existing && previous) {
    fail('DOC_MANUAL_CONFLICT');
  }

  const start = indexAt(runs, offset, fail);
  if (old && !covered(runs, start, start + old.length, () => true)) fail('DOC_RANGE_INVALID');
  if (!prefix && old && ![oldRaw, oldRaw && layout(previous)].includes(old) && link) {
    const point = start + old.indexOf(LINK_LABEL);
    if (!covered(runs, point, point + LINK_LABEL.length, style => style.link?.url === link)) {
      fail('DOC_MANUAL_CONFLICT');
    }
  }
  const correctLink = !link || covered(runs, start + linkOffset, start + linkOffset + LINK_LABEL.length,
    style => style.link?.url === link);
  const correctBold = emphasis.every(match => covered(runs, start + match.index,
    start + match.index + match[0].length, style => style.bold === true));
  if (old === target && correctLink && correctBold) return {revisionId, verified:true, requests:[]};

  const range = (startIndex, endIndex) => ({startIndex, endIndex, tabId});
  const style = (startIndex, endIndex, textStyle, fields) => ({
    updateTextStyle:{range:range(startIndex, endIndex), textStyle, fields},
  });
  const separator = prefix && !old && existing ? '\n' : '';
  const textStart = start + separator.length;
  const requests = [];
  if (old && old !== target) {
    requests.push({deleteContentRange:{range:range(start, start + old.length)}});
  }
  if (old !== target) {
    requests.push({insertText:{location:{index:start, tabId}, text:separator + target}});
  }
  if (target) {
    requests.push(style(textStart, textStart + target.length, {
      bold:false,
      foregroundColor:{color:{rgbColor:{red:0.082,green:0.169,blue:0.306}}},
      fontSize:{magnitude:11,unit:'PT'},
    }, 'link,bold,foregroundColor,fontSize'));
  }
  for (const match of emphasis) {
    const point = textStart + match.index;
    requests.push(style(point, point + match[0].length, {bold:true}, 'bold'));
  }
  if (link) {
    const point = textStart + linkOffset;
    requests.push(style(point, point + LINK_LABEL.length, {link:{url:link},underline:true}, 'link,underline'));
  }
  return {revisionId, verified:false, requests};
}
