// Nhận Docs gốc, định nghĩa chấm và content riêng tư; ghép đúng câu bằng nhãn “Câu”.
// Giữ chữ/màu từ hai ô của từng hàng. Thiếu/trùng câu hoặc khác key thì dừng, không xuất.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const [documentFile, definitionFile, contentFile, outputDir] = process.argv.slice(2);
if (!outputDir) throw Error('Cần Docs JSON, định nghĩa JSON, content JSON và thư mục xuất riêng tư.');
const document = JSON.parse(await fs.readFile(documentFile, 'utf8'));
const definitions = JSON.parse(await fs.readFile(definitionFile, 'utf8'));
const definition = definitions.find(d => d.slug === 'term-test-2');
assert.ok(definition, 'Không có định nghĩa Term 2');
const raw = await fs.readFile(contentFile, 'utf8'), content = JSON.parse(raw);
const canonical = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const hex = color => color ? '#' + ['red', 'green', 'blue'].map(k => Math.round((color[k] || 0) * 255).toString(16).padStart(2, '0')).join('') : null;
const tabs = [];
function visit(items) { for (const tab of items) { tabs.push(tab); visit(tab.childTabs || []); } }
visit(document.tabs || []);
const paragraphs = cell => (cell?.content || []).flatMap(b => b.paragraph ? [b.paragraph.elements.filter(e => e.textRun).map(e => ({
  text: e.textRun.content.replace(/\u000b/g, '\n'), bold: !!e.textRun.textStyle?.bold,
  italic: !!e.textRun.textStyle?.italic,
  foreground: hex(e.textRun.textStyle?.foregroundColor?.color?.rgbColor),
  background: hex(e.textRun.textStyle?.backgroundColor?.color?.rgbColor)
}))] : []).filter(p => p.some(r => r.text.trim()));
const text = p => p.map(r => r.text).join('').trim();
// Bỏ nhãn vị trí khỏi trích dẫn chính để giao diện tìm đúng câu trong bài đọc.
function withoutLocation(paragraph) {
  const value = paragraph.map(r => r.text).join('');
  let trim = value.match(/^(?:Đáp án\s+[A-H]\s*[—–-]\s*)?Đoạn\s+[^:]+:\s*/)?.[0].length || 0;
  return paragraph.flatMap(run => {
    const cut = Math.min(trim, run.text.length); trim -= cut;
    return cut === run.text.length ? [] : [{ ...run, text: run.text.slice(cut) }];
  });
}
const normalize = v => v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const bundle = { schemaVersion: 1, testSlug: definition.slug, definitionVersion: definition.version,
  contentSha256: hash(raw), definitionSha256: hash(canonical({ listening: definition.listening_definition, reading: definition.reading_definition })), skills: {} };
const audit = [];
for (const [skill, title] of [['listening', 'Giải thích'], ['reading', 'Giải thích Reading']]) {
  const matches = tabs.filter(t => t.tabProperties.title === title);
  assert.equal(matches.length, 1, 'Tab không duy nhất: ' + title);
  const tab = matches[0], rows = new Map();
  for (const [table, block] of tab.documentTab.body.content.filter(b => b.table).entries()) {
    for (const [row, record] of block.table.tableRows.entries()) {
      const analysis = paragraphs(record.tableCells[0]);
      const marker = text(analysis[0] || []).match(/^Câu\s+(\d+)(?:[–—-](\d+))?\s*:/);
      if (!marker) continue;
      const first = Number(marker[1]), last = Number(marker[2] || marker[1]);
      const evidence = paragraphs(record.tableCells[1]);
      assert.ok(evidence.length, 'Thiếu dẫn chứng ' + skill + first);
      for (let n = first; n <= last; n++) {
        assert.ok(!rows.has(n), 'Trùng câu ' + skill + n);
        rows.set(n, { table, row, analysis, evidence, numbers: Array.from({ length: last - first + 1 }, (_, i) => first + i) });
      }
    }
  }
  const sd = definition[skill + '_definition'], entries = {};
  assert.equal(rows.size, sd.questions.length, 'Số câu nguồn khác đề ' + skill);
  for (const q of sd.questions) {
    const source = rows.get(q.number); assert.ok(source, 'Thiếu câu ' + skill + q.number);
    // Q28 nguồn trả bài dùng chính tả Mỹ; trích đúng “enquiring” trong đề đang thi.
    // Chỉ chuẩn hóa biến thể này, không đổi ý, đáp án hoặc màu của lời giải.
    if (skill === 'reading' && q.number === 28) {
      for (const p of [...source.analysis, ...source.evidence]) for (const run of p) run.text = run.text.replaceAll('inquiring', 'enquiring');
    }
    const answers = q.pairGroup ? sd.pairGroups[q.pairGroup].expected : q.accepted;
    const answerLine = source.analysis.map(text).find(t => /⇒\s*Đáp án:/.test(t));
    assert.ok(answerLine, 'Thiếu đáp án trong lời giải ' + skill + q.number);
    const declared = answerLine.split('Đáp án:')[1].trim();
    if (answers.every(a => /^[A-H]$/.test(a))) {
      const letters = [...declared.matchAll(/(?:^|\s)([A-H])(?:\.|$)/g)].map(m => m[1]).sort();
      assert.deepEqual(letters, [...answers].sort(), 'Sai key chữ ' + skill + q.number);
    } else {
      assert.deepEqual(declared.split('/').map(normalize).sort(), answers.map(normalize).sort(), 'Sai key từ ' + skill + q.number);
    }
    if (q.pairGroup) assert.deepEqual(source.numbers, sd.pairGroups[q.pairGroup].numbers);
    else assert.equal(source.numbers.length, 1);
    // Chỉ đưa dẫn chứng đúng vào ô đối chiếu. Toàn bộ bẫy và dẫn chứng nhiễu vẫn ở lời giải.
    const primary = [];
    for (const p of source.evidence) {
      const t = text(p);
      if (/^(Option\s+[A-H]|Chi tiết dễ nhầm|Thông tin về)/i.test(t)) break;
      if (/^Đáp án\s+[A-H]:$/.test(t) || /^Ed xác nhận/.test(t)) continue;
      primary.push(skill === 'reading' ? withoutLocation(p) : p);
    }
    assert.ok(primary.length, 'Thiếu dẫn chứng chính ' + skill + q.number);
    const section = content[skill].sections.findIndex(s => {
      const [a, b] = s.range.match(/\d+/g).map(Number); return q.number >= a && q.number <= b;
    });
    assert.ok(section >= 0, 'Sai section ' + skill + q.number);
    entries[q.number] = { number: q.number, section, type: q.type, answers,
      pairNumbers: q.pairGroup ? source.numbers : null, prompt: [source.analysis[0]], evidence: primary,
      blocks: [{ row: source.row, analysis: source.analysis, evidence: source.evidence }],
      source: { documentId: document.documentId, tabId: tab.tabProperties.tabId, table: source.table, rows: [source.row, source.row] } };
    audit.push({ skill, number: q.number, answers, declared, sourceRow: source.row, evidenceParagraphs: primary.length });
  }
  bundle.skills[skill] = { entries };
}
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'explanations.json'), JSON.stringify(bundle, null, 2) + '\n');
await fs.writeFile(path.join(outputDir, 'answer-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ testSlug: bundle.testSlug, entries: audit.length, keysVerified: audit.length }));
