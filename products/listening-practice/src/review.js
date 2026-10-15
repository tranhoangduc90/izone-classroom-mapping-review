import {readFile} from 'node:fs/promises';

// Nhận transcript/mốc nghe từ file riêng tư. Kiểm trước khi mở API để không phát sai audio.
// File hỏng làm dừng khởi động; nội dung bài làm và các quyền vẫn do dịch vụ gốc quyết định.
export function validateReview(value,audioHash){
 const fail=()=>{throw new Error('Invalid Listening review data or audio version');};
 if(!value||value.audioSha256!==audioHash||!value.contentVersion||value.audioDurationMs!==459207)fail();
 if(!Array.isArray(value.words)||!value.words.length||!Array.isArray(value.segments)||!value.segments.length)fail();
 const range=(start,end)=>Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start&&end<=value.words.length;
 for(const word of value.words){
  if(typeof word.word!=='string'||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<word.start||word.end*1000>value.audioDurationMs+1)fail();
 }
 for(const segment of value.segments){
  if(!range(segment.wordStart,segment.wordEnd)||!Number.isFinite(segment.start)||segment.start<0)fail();
 }
 const validateReplay=replay=>{
  if(!Array.isArray(replay))fail();
  for(const part of replay){
   if(typeof part.id!=='string'||!range(part.wordStart,part.wordEnd)||!Number.isInteger(part.startMs)||!Number.isInteger(part.endMs)||part.startMs<0||part.endMs<=part.startMs||part.endMs>value.audioDurationMs)fail();
   if(!Array.isArray(part.paragraphs)||part.paragraphs.some(p=>!Array.isArray(p.runs)||p.runs.some(r=>typeof r.text!=='string')))fail();
  }
 };
 for(let n=21;n<=30;n++){
  const question=value.questions?.[n];
  if(!question?.replay?.length||!question.optionReplay||typeof question.optionReplay!=='object')fail();
  validateReplay(question.replay);
  for(const replay of Object.values(question.optionReplay))validateReplay(replay);
 }
 return value;
}

export async function loadReview(file,audioHash){
 if(!file)return null;
 return validateReview(JSON.parse(await readFile(file,'utf8')),audioHash);
}

export function matchingReview(review,result){
 return Boolean(review&&result.attempt?.status==='submitted'&&result.contentVersion===review.contentVersion&&result.definition?.audio?.sha256===review.audioSha256);
}
