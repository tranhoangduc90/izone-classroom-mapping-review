import crypto from 'node:crypto';
import { z } from 'zod';
import {authoredLesson,validateAuthoredContent,gradeAuthored} from './authored-content.js';

export const CODE='67-practice-listening_mcq_flowchart';
export const PRODUCT='PRODUCT-LISTENING-PRACTICE-K67';
export const AUDIO_MS=459207, REVIEW_MS=120000, TOTAL_MS=AUDIO_MS+REVIEW_MS, HEARTBEAT_MS=5000, LEASE_MS=7000;
// Cửa sổ lưu gồm một chu kỳ heartbeat và request đang chờ, không gồm thời gian rời tab.
export const REQUEST_TIMEOUT_MS=5000, RECOVERY_MS=HEARTBEAT_MS+REQUEST_TIMEOUT_MS;
export const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
export function canonical(value){return JSON.stringify(sort(value));}
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,sort(value[k])])):value;}
export const secret=()=>crypto.randomBytes(32).toString('base64url');
export const uuid=()=>crypto.randomUUID();
export class ListeningError extends Error {
 constructor(code,message,status=409){super(message);this.code=code;this.status=status;}
}
export const fail=(code,message,status)=>{throw new ListeningError(code,message,status);};
export const questionIds=Array.from({length:10},(_,i)=>String(i+21));
const answer=z.string().max(80);
export const timingFor=(code=CODE)=>authoredLesson(code)||{code,audioMs:AUDIO_MS,reviewMs:REVIEW_MS,totalMs:TOTAL_MS,questionIds};
export const snapshotSchema=z.object({
 answers:z.record(z.string(),answer).refine(a=>Object.keys(a).every(n=>questionIds.includes(n))),
 flags:z.array(z.number().int().min(21).max(30)).max(10),notes:z.string().max(10000),
 annotations:z.array(z.object({id:z.string().max(80),kind:z.enum(['highlight','note']),
 rootKey:z.string().max(80),skill:z.literal('reading'),start:z.number().int().nonnegative(),end:z.number().int().positive(),
 quote:z.string().max(10000),questionRef:z.string().max(100),note:z.string().max(10000).optional()}).strict()).max(100),
 scroll:z.object({passage:z.number().nonnegative(),questions:z.record(z.string(),z.number().nonnegative())}),
 activeQuestion:z.number().int().min(21).max(30),tab:z.enum(['mcq','flowchart']),
 mobilePane:z.enum(['passage','questions']).optional(),notesOpen:z.boolean().optional(),
 highlighted:z.array(z.enum(['A','B','C','D','E','F','G'])).max(7),
 phase:z.enum(['listening','review']),audioPosition:z.number().min(0).max(AUDIO_MS/1000),
 sequence:z.number().int().nonnegative(),activeMs:z.number().int().nonnegative()
}).strict();
export const emptyDraft=(code=CODE)=>({answers:{},flags:[],notes:'',annotations:[],scroll:{passage:0,questions:{}},
 phase:'listening',audioPosition:0,activeQuestion:+timingFor(code).questionIds[0],tab:authoredLesson(code)?.groups[0].kind||'mcq',mobilePane:'passage',notesOpen:false,highlighted:[],sequence:0,activeMs:0});
export function validateSnapshot(input,code=CODE){
 const l=authoredLesson(code),ids=l?.questionIds;
 const schema=l?snapshotSchema.extend({answers:z.record(z.string(),answer).refine(a=>Object.keys(a).every(n=>ids.includes(n))),flags:z.array(z.number().int().refine(n=>ids.includes(String(n)))).max(ids.length),activeQuestion:z.number().int().refine(n=>ids.includes(String(n))),tab:z.enum([...new Set(l.groups.map(g=>g.kind))]),highlighted:z.array(z.enum(l.paragraphs)).max(l.paragraphs.length),audioPosition:z.number().min(0).max(l.audioMs/1000)}):snapshotSchema;
 const parsed=schema.safeParse(input);if(!parsed.success)fail('INVALID_DRAFT','Nháp gửi lên không hợp lệ.',400);return parsed.data;}
export function validateContent(bundle){
 if(bundle?.definition?.authored){try{return validateAuthoredContent(bundle);}catch(e){fail('CONTENT_INVALID',e.message,400);}}
 if(bundle?.code!==CODE||bundle.totalMs!==TOTAL_MS||!bundle.version||!bundle.definition||!bundle.key||!bundle.explanations?.entries)
  fail('CONTENT_INVALID','Gói nội dung chưa đủ cấu hình.',400);
 if(Object.keys(bundle.key).join(',')!==questionIds.join(',')||Object.keys(bundle.explanations.entries).join(',')!==questionIds.join(','))
  fail('CONTENT_INVALID','Đề và lời giải phải có đủ câu 21–30.',400);
 for(const n of questionIds)if(!Array.isArray(bundle.key[n])||!bundle.key[n].length||bundle.key[n].some(v=>typeof v!=='string'||!v.trim()))fail('CONTENT_INVALID','Khóa chấm không hợp lệ.',400);
 if(bundle.definition.mcq?.length!==5||bundle.definition.flow?.length!==5||bundle.definition.bank?.length!==8||bundle.definition.audio?.durationMs!==AUDIO_MS||!/^\w{64}$/.test(bundle.definition.audio?.sha256||''))fail('CONTENT_INVALID','Cấu trúc Listening hoặc audio chưa khớp.',400);
 return bundle;
}
export const normalize=v=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
export function grade(answers,key,code=CODE,definition){
 if(authoredLesson(code))return gradeAuthored(answers,key,definition);
 const rows=questionIds.map(n=>{
  const value=normalize(answers[n]);
  return{number:+n,answer:answers[n]||'',expected:key[n],state:!value?'blank':key[n].map(normalize).includes(value)?'correct':'incorrect'};
 });
 return{score:rows.filter(r=>r.state==='correct').length,rows};
}
// Giữ bản sửa điểm trong Docs đang chạy trên production trước đợt phục hồi này.
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
  baselineMs:a.usedMs,acceptedActiveMs:0,awaitingPlayback:true,activated:false,activationCancelled:false};a.status='paused';a.draft.activeMs=0;
 return{id:a.lease.id,token,owner};
}
export function checkLease(a,lease){
 if(!a.lease||a.lease.id!==lease?.id||a.lease.tokenHash!==hash(lease?.token||''))fail('LEASE_LOST','Bài đã chuyển sang phiên khác. Nhấn Tiếp tục để mở tại đây.');
}
export function checkpoint(a,input,lease,clock,{recovery=false}={}){
 checkLease(a,lease);const timing=timingFor(a.code),draft=validateSnapshot(input,a.code);
 if(draft.sequence<a.draft.sequence)fail('STALE_DRAFT','Nháp này cũ hơn bản đã lưu. Hãy tải lại bài.');
 const old={...a.draft,activeMs:0},next={...draft,activeMs:0};
 if(draft.sequence===a.draft.sequence&&canonical(old)!==canonical(next))fail('STALE_DRAFT','Nháp cùng phiên bản có nội dung khác nhau.');
 const delta=Math.max(0,clock-a.lease.lastSeen);
 if(!recovery&&delta>LEASE_MS)fail('LEASE_EXPIRED','Kết nối lưu bài bị gián đoạn. Hãy nhấn Tiếp tục.');
 // Chỉ nhận active chưa ACK trong cửa sổ lưu; thời gian vắng không được cộng vào bài.
 const unconfirmed=Math.max(0,draft.activeMs-a.lease.acceptedActiveMs);
 let increase=recovery?Math.min(RECOVERY_MS,unconfirmed,delta):a.lease.awaitingPlayback?Math.min(unconfirmed,delta):delta;
 if(recovery&&a.phase==='listening'){
  const audioAdvance=Math.max(0,(draft.audioPosition-(a.draft.audioPosition||0))*1000);
  if(audioAdvance>unconfirmed+1000||audioAdvance>0&&!a.lease.activated)fail('AUDIO_POSITION_INVALID','Vị trí nghe chưa khớp thời gian phát đã xác nhận.',400);
  if(draft.phase==='listening')increase=Math.min(increase,Math.max(0,draft.audioPosition*1000-a.usedMs));
 }
 // Thời gian máy chủ giới hạn tiến độ audio; không nhận tua hoặc chuyển rà bài sớm.
 const used=a.usedMs+increase;
 if(draft.audioPosition>(Math.min(used,timing.audioMs)+1000)/1000)fail('AUDIO_POSITION_INVALID','Vị trí nghe vượt thời gian đã xác nhận.',400);
 if(draft.audioPosition+0.3<(a.draft.audioPosition||0))fail('AUDIO_REWIND_DENIED','Không tua lại trong lượt đang làm.',400);
 if(a.phase!=='review'&&draft.phase==='review'){
  if(used<timing.audioMs-1000||draft.audioPosition<timing.audioMs/1000-0.3)fail('AUDIO_NOT_FINISHED','Audio chưa kết thúc.',400);
  a.phase='review';a.usedMs=Math.min(timing.totalMs,Math.max(timing.audioMs,used));
 }else{
  if(a.phase==='review'&&draft.phase!=='review')fail('AUDIO_REPLAY_DENIED','Lượt này đã chuyển sang rà bài.',400);
  a.usedMs=Math.min(a.phase==='review'?timing.totalMs:timing.audioMs-1,used);
 }
 draft.audioPosition=Math.min(timing.audioMs/1000,draft.audioPosition);
 if(a.phase==='review')draft.audioPosition=timing.audioMs/1000;
 if(increase>0)a.lease.awaitingPlayback=false;
 a.lease.acceptedActiveMs=a.usedMs-a.lease.baselineMs;
 a.lease.lastSeen=clock;a.draft=draft;
 delete a.progressRecovery;
 return a;
}
// Lưu riêng nội dung hợp lệ khi tiến độ chưa xác minh được; giữ mốc nghe cũ và dừng bài.
// Sai người/lease/thứ tự/cấu trúc vẫn bị từ chối, không nhận nháp của phiên khác.
export function recoverCheckpoint(a,input,lease,clock){
 const candidate=structuredClone(a);
 try{checkpoint(candidate,input,lease,clock,{recovery:true});Object.assign(a,candidate);delete a.progressRecovery;return true;}
 catch(error){
  if(!['AUDIO_POSITION_INVALID','AUDIO_REWIND_DENIED','AUDIO_NOT_FINISHED','AUDIO_REPLAY_DENIED'].includes(error.code))throw error;
  checkLease(a,lease);const draft=validateSnapshot(input,a.code);
  const {phase,audioPosition,activeMs,...content}=draft;
  a.draft={...a.draft,...content};a.status='paused';a.lease.activationCancelled=true;
  a.progressRecovery={code:'PROGRESS_RESYNC_REQUIRED',reason:error.code,
   message:'Đáp án và ghi chú đã được giữ. Chưa xác minh được vị trí nghe; hãy giữ nguyên bản nháp và báo giảng viên để tiếp tục đúng lượt.',
   reportedAudioPosition:audioPosition,reportedPhase:phase,reportedActiveMs:activeMs};
  return false;
 }
}
export function publicAttempt(a){
 const timing=timingFor(a.code);
 const copy=structuredClone(a);delete copy.lease;
 return{...copy,...copy.draft,leaseId:a.lease?.id,phase:a.phase||'listening',reviewRemainingMs:a.phase==='review'?Math.max(0,timing.totalMs-a.usedMs):timing.reviewMs,remainingMs:Math.max(0,timing.totalMs-a.usedMs)};
}
