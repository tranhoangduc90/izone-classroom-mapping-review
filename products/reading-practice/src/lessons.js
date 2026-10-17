import {fail} from './domain.js';

// Chỉ chứa cấu trúc và nhãn bài; đề, khóa chấm và lời giải vẫn ở kho nội dung riêng tư.
export const LEGACY_CODE='67-practice-reading_matching_heading_mcq';
export const ROBOTS_CODE='67-practice-reading_matching_names_sentence_endings_mcq';
const lessons={
 [LEGACY_CODE]:{code:LEGACY_CODE,lesson:7,title:'The steam car',book:18,test:3,passage:2,
  subtitle:'The successes and failures of the Doble brothers and their steam cars',
  groups:[{kind:'headings',label:'Matching Headings',start:14,end:20},{kind:'mcq',label:'Multiple Choice',start:21,end:23},{kind:'summary',label:'Summary Completion',start:24,end:26}],paragraphs:'ABCDEFG'.split('')},
 [ROBOTS_CODE]:{code:ROBOTS_CODE,lesson:9,title:'Robots and us',book:20,test:3,passage:3,
  subtitle:'Three leaders in their fields answer questions about our relationships with robots',
  groups:[{kind:'names',label:'Matching Names',start:27,end:33},{kind:'endings',label:'Sentence Endings',start:34,end:36},{kind:'mcq',label:'Multiple Choice',start:37,end:40}],paragraphs:Array.from({length:11},(_,i)=>String(i+1))}
};
export function lessonFor(code=LEGACY_CODE){
 const lesson=Object.hasOwn(lessons,code)?lessons[code]:null;if(!lesson)fail('CONTENT_INVALID','Mã bài Reading chưa được hỗ trợ.',400);
 return structuredClone({...lesson,totalMs:1200000,questionIds:lesson.groups.flatMap(g=>Array.from({length:g.end-g.start+1},(_,i)=>String(g.start+i)))});
}
