import crypto from 'node:crypto';
import { z } from 'zod';
import {lessonFor,ROBOTS_CODE} from './lessons.js';
import {authoredLesson,validateAuthoredContent,gradeAuthored} from './authored-content.js';

export const CODE='67-practice-reading_matching_heading_mcq';
export const PRODUCT='PRODUCT-READING-PRACTICE-K67';
export const TOTAL_MS=1200000, HEARTBEAT_MS=5000, LEASE_MS=7000;
export const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
export function canonical(value){return JSON.stringify(sort(value));}
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,sort(value[k])])):value;}
export const secret=()=>crypto.randomBytes(32).toString('base64url');
export const uuid=()=>crypto.randomUUID();
export class ReadingError extends Error {
 constructor(code,message,status=409){super(message);this.code=code;this.status=status;}
}
export const fail=(code,message,status)=>{throw new ReadingError(code,message,status);};
export const questionIds=Array.from({length:13},(_,i)=>String(i+14));
const answer=z.string().max(80);
function schemaFor(code=CODE){
 const lesson=lessonFor(code),ids=lesson.questionIds;
 return z.object({
 answers:z.record(z.string(),answer).refine(a=>Object.keys(a).every(n=>ids.includes(n))),
 flags:z.array(z.number().int().refine(n=>ids.includes(String(n)))).max(ids.length),notes:z.string().max(10000),
 annotations:z.array(z.object({id:z.string().max(80),kind:z.enum(['highlight','note']),
 rootKey:z.string().max(80),skill:z.literal('reading'),start:z.number().int().nonnegative(),end:z.number().int().positive(),
 quote:z.string().max(10000),questionRef:z.string().max(100),note:z.string().max(10000).optional()}).strict()).max(100),
 scroll:z.object({passage:z.number().nonnegative(),questions:z.record(z.string(),z.number().nonnegative())}),
 activeQuestion:z.number().int().refine(n=>ids.includes(String(n))),tab:z.enum(lesson.groups.map(g=>g.kind)),
 mobilePane:z.enum(['passage','questions']).optional(),notesOpen:z.boolean().optional(),
 highlighted:z.array(z.enum(lesson.paragraphs)).max(lesson.paragraphs.length),
 sequence:z.number().int().nonnegative(),activeMs:z.number().int().nonnegative()
 }).strict();
}
export const snapshotSchema=schemaFor();
export const emptyDraft=(code=CODE)=>({answers:{},flags:[],notes:'',annotations:[],scroll:{passage:0,questions:{}},
 activeQuestion:+lessonFor(code).questionIds[0],tab:lessonFor(code).groups[0].kind,mobilePane:'passage',notesOpen:false,highlighted:[],sequence:0,activeMs:0});
export function validateSnapshot(input,code=CODE){const parsed=schemaFor(code).safeParse(input);if(!parsed.success)fail('INVALID_DRAFT','Nháp gửi lên không hợp lệ.',400);return parsed.data;}
export function validateContent(bundle){
 if(!bundle||typeof bundle!=='object')fail('CONTENT_INVALID','Gói nội dung chưa đủ cấu hình.',400);
 if(bundle.definition?.authored){try{return validateAuthoredContent(bundle);}catch(e){fail('CONTENT_INVALID',e.message,400);}}
 const lesson=lessonFor(bundle?.code),ids=lesson.questionIds;
 if(bundle.totalMs!==TOTAL_MS||!bundle.version||!bundle.definition||!bundle.key||!bundle.explanations?.entries)
  fail('CONTENT_INVALID','Gói nội dung chưa đủ cấu hình.',400);
 if(Object.keys(bundle.key).join(',')!==ids.join(',')||Object.keys(bundle.explanations.entries).join(',')!==ids.join(','))
  fail('CONTENT_INVALID','Đề và lời giải phải có đủ số câu của bài.',400);
 for(const n of ids)if(!Array.isArray(bundle.key[n])||!bundle.key[n].length||bundle.key[n].some(v=>typeof v!=='string'||!v.trim()))fail('CONTENT_INVALID','Khóa chấm không hợp lệ.',400);
 const d=bundle.definition;
 if(bundle.code===ROBOTS_CODE){
  const numbered=(items,start,end)=>Array.isArray(items)&&items.map(q=>q.n).join(',')===Array.from({length:end-start+1},(_,i)=>i+start).join(',')&&items.every(q=>typeof q.text==='string'&&q.text.trim());
  if(Object.keys(d.passage||{}).join(',')!==lesson.paragraphs.join(',')||Object.values(d.passage).some(p=>typeof p!=='string'||!p.trim())
   ||!numbered(d.names,27,33)||!numbered(d.endings,34,36)||!numbered(d.mcq,37,40)||d.mcq.some(q=>q.options?.length!==4)
   ||d.experts?.map(x=>x[0]).join('')!=='ABC'||d.endingOptions?.map(x=>x[0]).join('')!=='ABCD')fail('CONTENT_INVALID','Cấu trúc bài phải khớp Names/Endings/MCQ 7/3/4.',400);
  for(const n of ids){
   const kind=lesson.groups.find(g=>+n>=g.start&&+n<=g.end).kind,e=bundle.explanations.entries[n],options=kind==='names'?'ABC':'ABCD';
   if(bundle.key[n].length!==1||!options.split('').includes(bundle.key[n][0])||!e||e.number!==+n||e.kind!==kind||e.answer?.join()!==bundle.key[n].join())fail('CONTENT_INVALID','Khóa chấm và lời giải không khớp câu hỏi.',400);
   const paragraph=p=>p&&Array.isArray(p.runs)&&p.runs.length>0&&p.runs.every(r=>typeof r.text==='string');
   const paragraphs=ps=>Array.isArray(ps)&&ps.length>0&&ps.every(paragraph);
   const evidence=gs=>Array.isArray(gs)&&gs.length>0&&gs.every(g=>lesson.paragraphs.includes(g.paragraph)&&typeof g.speaker==='string'&&paragraphs(g.paragraphs)&&Array.isArray(g.marks)&&g.marks.every(m=>Number.isInteger(m.start)&&Number.isInteger(m.end)&&m.start>=0&&m.end>m.start&&m.end<=d.passage[g.paragraph].length));
   if(!paragraph(e.prompt)||!evidence(e.evidenceGroups)||(kind==='endings'&&(!paragraph(e.completion)||e.evidenceGroups.length<2))
    ||(kind!=='mcq'&&!paragraphs(e.reason))||(kind==='mcq'&&(!Array.isArray(e.options)||e.options.map(o=>o.letter).join('')!=='ABCD'||e.options.filter(o=>o.correct).length!==1||e.options.find(o=>o.correct).letter!==bundle.key[n][0]||e.options.some(o=>!paragraph(o.label)||!paragraphs(o.reason)||!evidence(o.evidenceGroups)))))fail('CONTENT_INVALID','Lời giải hoặc vị trí dẫn chứng chưa đầy đủ.',400);
  }
 }else if(Object.keys(d.passage||{}).join('')!=='ABCDEFG'||d.headings?.length!==8||d.mcq?.length!==3||d.summary?.filter(s=>s.question).length!==3)
  fail('CONTENT_INVALID','Cấu trúc passage không khớp 7/3/3.',400);
 return bundle;
}
export const normalize=v=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
export function grade(answers,key,code=CODE,definition){
 if(authoredLesson(code))return gradeAuthored(answers,key,definition);
 const lesson=lessonFor(code),rows=lesson.questionIds.map(n=>{
  const value=normalize(answers[n]);
  // Summary chỉ nhận một từ và/hoặc một số, không nới khóa theo chuỗi con.
  const withinLimit=lesson.groups.find(g=>+n>=g.start&&+n<=g.end).kind!=='summary'||/^(?:[a-z]+(?:[-’'][a-z]+)*|\d+(?:[.,]\d+)?)(?:\s+(?:[a-z]+(?:[-’'][a-z]+)*|\d+(?:[.,]\d+)?))?$/.test(value)
    &&value.split(' ').filter(t=>/[a-z]/.test(t)).length<=1&&value.split(' ').filter(t=>/\d/.test(t)).length<=1;
  return{number:+n,answer:answers[n]||'',expected:key[n],state:!value?'blank':withinLimit&&key[n].map(normalize).includes(value)?'correct':'incorrect'};
 });
 return{score:rows.filter(r=>r.state==='correct').length,rows};
}
// Chỉ lấy hai số tổng hợp từ kết quả đã khóa; thiếu/mâu thuẫn thì giữ thông báo cũ.
// Số câu trống vẫn thuộc mẫu số; không dùng số thứ tự câu cuối hoặc đáp án học viên nhập.
export function resultSummary(a){
 const result=a.result,rows=result?.rows,score=result?.score;
 if(!Array.isArray(rows)||!rows.length||!Number.isInteger(score)||score<0||score>rows.length
  ||a.finalScore!==score||rows.filter(r=>r.state==='correct').length!==score
  ||rows.some(r=>!Number.isInteger(r.number)||!['correct','incorrect','blank'].includes(r.state))
  ||new Set(rows.map(r=>r.number)).size!==rows.length)return null;
 return {correct:score,total:rows.length};
}
export function statusMessage(a,firstCompleted){
 if(a.status!=='submitted')return a.no===1?'Đã bắt đầu làm bài lần đầu tiên.':`Đã bắt đầu làm bài số ${a.no} (đã reset ${a.no-1} lần).`;
 const text=a.no===1?'Đã hoàn thành ngay từ lần đầu.':firstCompleted&&firstCompleted!==a.no
  ?`Đã hoàn thành lượt luyện lại số ${a.no} (tổng ${a.no-1} lần reset). Lần hoàn thành đầu tiên: lượt ${firstCompleted}.`
  :`Đã hoàn thành sau ${a.no-1} lần reset (lần làm bài số ${a.no}).`;
 const summary=resultSummary(a),scoreText=summary?` Kết quả: đúng ${summary.correct}/${summary.total} câu.`:'';
 return text+scoreText+(a.method==='timeout'?' Hệ thống tự thu bài do hết thời gian.':'')+' Giảng viên nhấn vào đây để xem kết quả.';
}
export function issueLease(a,owner,clock){
 const token=secret();a.lease={id:uuid(),owner,tokenHash:hash(token),lastSeen:clock,startedAt:clock,
  baselineMs:a.usedMs,acceptedActiveMs:0,activated:false,activationCancelled:false};a.status='paused';a.draft.activeMs=0;
 return{id:a.lease.id,token,owner};
}
export function checkLease(a,lease){
 if(!a.lease||a.lease.id!==lease?.id||a.lease.tokenHash!==hash(lease?.token||''))fail('LEASE_LOST','Bài đã chuyển sang phiên khác. Nhấn Tiếp tục để mở tại đây.');
}
export function checkpoint(a,input,lease,clock,{recovery=false,code=CODE}={}){
 checkLease(a,lease);const draft=validateSnapshot(input,code);
 if(draft.sequence<a.draft.sequence)fail('STALE_DRAFT','Nháp này cũ hơn bản đã lưu. Hãy tải lại bài.');
 const old={...a.draft,activeMs:0},next={...draft,activeMs:0};
 if(draft.sequence===a.draft.sequence&&canonical(old)!==canonical(next))fail('STALE_DRAFT','Nháp cùng phiên bản có nội dung khác nhau.');
 const delta=Math.max(0,clock-a.lease.lastSeen);
 if(!recovery&&delta>LEASE_MS)fail('LEASE_EXPIRED','Kết nối lưu bài bị gián đoạn. Hãy nhấn Tiếp tục.');
 // Khi nối lại không trừ thời gian vắng; chỉ nhận phần active chưa ACK, tối đa 5 giây.
 const unconfirmed=Math.max(0,draft.activeMs-a.lease.acceptedActiveMs);
 const increase=recovery?Math.min(HEARTBEAT_MS,unconfirmed,delta):delta;
 a.usedMs=Math.min(lessonFor(code).totalMs,a.usedMs+increase);
 a.lease.acceptedActiveMs=a.usedMs-a.lease.baselineMs;
 a.lease.lastSeen=clock;a.draft=draft;
 return a;
}
export function publicAttempt(a){
 const copy=structuredClone(a);delete copy.lease;
 return{...copy,...copy.draft,leaseId:a.lease?.id,remainingMs:Math.max(0,lessonFor(a.code||CODE).totalMs-a.usedMs)};
}
