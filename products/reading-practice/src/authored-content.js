import {readFileSync} from 'node:fs';

// Nhận cấu hình bài do bộ soạn sinh; chỉ giữ metadata công khai trong catalog.
// Nội dung/khóa/lời giải ở bundle riêng; sai cấu trúc báo lỗi trước khi nạp database.
const registry=new Map();
const kinds=new Set(['headings','names','endings','matching','tfng','ynng','mcq','completion','summary','flowchart']);
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const text=v=>typeof v==='string'&&v.trim().length>0;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function registerAuthoredLesson(input){
 const lesson=structuredClone(input);
 // Phụ đề nguyên văn thuộc definition riêng tư, không đưa vào catalog trước khi mở bài.
 delete lesson.subtitle;
 check(lesson&&/^[a-z0-9_-]{8,100}$/.test(lesson.code),'Mã bài không hợp lệ.');
 check(text(lesson.title)&&Number.isInteger(lesson.lesson)&&lesson.lesson>0,'Thiếu tên/số buổi.');
 check(Number.isInteger(lesson.totalMs)&&lesson.totalMs>=1000&&lesson.totalMs<=86400000,'Thời gian bài không hợp lệ.');
 check(Array.isArray(lesson.groups)&&lesson.groups.length>0,'Thiếu nhóm câu hỏi.');
 const ids=[],groupIds=new Set();
 for(const g of lesson.groups){
  check(/^[a-z][a-z0-9_-]*$/.test(g.id)&&!groupIds.has(g.id)&&kinds.has(g.kind),'Nhóm câu hỏi không hợp lệ/trùng.');
  check(Number.isInteger(g.start)&&Number.isInteger(g.end)&&g.start>0&&g.end>=g.start&&g.end<=100,'Khoảng câu không hợp lệ.');
  groupIds.add(g.id);
  for(let n=g.start;n<=g.end;n++)ids.push(String(n));
 }
 check(new Set(ids).size===ids.length&&ids.every((n,i)=>!i||+n>+ids[i-1]),'Số câu trùng hoặc sai thứ tự.');
 check(Array.isArray(lesson.paragraphs)&&lesson.paragraphs.length&&lesson.paragraphs.every(p=>/^[a-zA-Z0-9_-]+$/.test(p)),'Mã đoạn không hợp lệ.');
 if(lesson.audioMs!==undefined)check(Number.isInteger(lesson.audioMs)&&lesson.audioMs>0&&Number.isInteger(lesson.reviewMs)&&lesson.reviewMs>=0&&lesson.totalMs===lesson.audioMs+lesson.reviewMs,'Audio/thời gian rà không khớp.');
 lesson.questionIds=ids;lesson.authored=true;
 const old=registry.get(lesson.code);
 check(!old||same(old,lesson),'Mã bài đã dùng cho cấu trúc khác; cần mã mới.');
 registry.set(lesson.code,lesson);return structuredClone(lesson);
}
export const authoredLesson=code=>registry.has(code)?structuredClone(registry.get(code)):null;
for(const lesson of JSON.parse(readFileSync(new URL('./authored-lessons.json',import.meta.url),'utf8')))registerAuthoredLesson(lesson);

export function validateAuthoredContent(bundle){
 const d=bundle.definition,l=authoredLesson(bundle.code);
 check(l&&d?.authored&&same(registerAuthoredLesson(d.lesson),l),'Chưa đăng ký cấu trúc bài hoặc metadata không khớp.');
 const ids=l.questionIds,passage=l.audioMs!==undefined?bundle.explanations?.passage:d.passage;
 check(bundle.totalMs===l.totalMs&&text(bundle.version),'Version/thời gian không khớp.');
 const keys=o=>Object.keys(o||{}).sort((a,b)=>+a-+b);
 check(same(keys(bundle.key),ids)&&same(keys(bundle.explanations?.entries),ids),'Đề/key/giải thích thiếu hoặc thừa số câu.');
 check(same(Object.keys(passage||{}),l.paragraphs)&&Object.values(passage).every(text),'Đoạn nguồn chưa đủ.');
 check(Array.isArray(d.groups)&&same(d.groups.map(g=>g.id),l.groups.map(g=>g.id)),'Nhóm nội dung chưa khớp.');
 const paragraph=p=>p&&Array.isArray(p.runs)&&p.runs.length&&p.runs.every(r=>typeof r.text==='string'&&['foreground','background'].every(k=>r[k]===undefined||/^#[0-9a-f]{6}$/i.test(r[k])));
 for(const [i,g] of d.groups.entries()){
  const meta=l.groups[i],qs=g.questions,expected=ids.filter(n=>+n>=meta.start&&+n<=meta.end);
  check(g.kind===meta.kind&&text(g.instruction)&&Array.isArray(qs)&&same(qs.map(q=>String(q.n)),expected),'Thiếu chỉ dẫn/câu hỏi trong nhóm.');
  check(!g.image||/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(g.image),'Hình đề phải nhúng riêng trong bundle, không dùng URL ngoài.');
  const options=g.options;
  if(g.summaryParagraphs){
   check(Array.isArray(g.summaryParagraphs)&&g.summaryParagraphs.length&&g.summaryParagraphs.every(text),'Thiếu đoạn tóm tắt.');
   const blanks=g.summaryParagraphs.flatMap(p=>[...p.matchAll(/\{\{(\d+)\}\}/g)].map(m=>m[1]));
   check(same(blanks,expected),'Chỗ trống tóm tắt thiếu, trùng hoặc sai thứ tự câu.');
  }
  if(options)check(options.length&&new Set(options.map(o=>o.value)).size===options.length&&options.every(o=>text(o.value)&&text(o.text)),'Ngân hàng lựa chọn không hợp lệ.');
  for(const q of qs){
   check(Number.isInteger(q.n)&&text(q.text),'Số câu phải là số nguyên và câu hỏi không trống.');
   const bank=q.options||options;
   if(bank)check(bank.length&&new Set(bank.map(o=>o.value)).size===bank.length&&bank.every(o=>text(o.value)&&text(o.text)),'Lựa chọn không hợp lệ.');
   const key=bundle.key[q.n],e=bundle.explanations.entries[q.n];
   check(Array.isArray(key)&&key.length&&key.every(text),'Key trống.');
   if(bank)check(key.every(v=>v.split('|').every(x=>bank.some(o=>o.value===x))),'Key không có trong lựa chọn.');
   check(e?.number===q.n&&e.kind===g.kind&&same(e.answer,key)&&paragraph(e.prompt)&&Array.isArray(e.reason)&&e.reason.length&&e.reason.every(paragraph),'Giải thích không khớp key hoặc thiếu phân tích.');
   check(Array.isArray(e.evidenceGroups)&&e.evidenceGroups.length,'Thiếu dẫn chứng.');
   for(const ev of e.evidenceGroups){
    check(l.paragraphs.includes(ev.paragraph)&&Array.isArray(ev.paragraphs)&&ev.paragraphs.length&&ev.paragraphs.every(paragraph),'Dẫn chứng không khớp đoạn.');
    check(Array.isArray(ev.marks)&&ev.marks.length&&ev.marks.every(m=>Number.isInteger(m.start)&&Number.isInteger(m.end)&&m.start>=0&&m.end>m.start&&m.end<=passage[ev.paragraph].length),'Vị trí dẫn chứng ngoài nguồn.');
   }
  }
 }
 if(l.audioMs!==undefined)check(d.audio?.durationMs===l.audioMs&&/^[0-9a-f]{64}$/.test(d.audio.sha256),'Audio chưa khớp cấu hình.');
 return bundle;
}
export function gradeAuthored(answers,key,definition){
 const clean=v=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
 const rows=definition.groups.flatMap(g=>g.questions.map(q=>{
  const raw=String(answers[q.n]??''),value=clean(raw),multiple=Boolean(q.multiple);
  const norm=v=>multiple?clean(v).split('|').sort().join('|'):clean(v);
  const limit=q.maxWords??g.maxWords;
  const within=!limit||value.split(/\s+/).filter(Boolean).length<=limit;
  return{number:q.n,answer:raw,expected:key[q.n],state:!value?'blank':within&&key[q.n].some(k=>norm(k)===norm(value))?'correct':'incorrect'};
 }));
 return{score:rows.filter(r=>r.state==='correct').length,rows};
}
