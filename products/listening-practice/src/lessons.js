// Catalog link chung chỉ nhận bài Listening đã đăng ký; bài cũ giữ link cá nhân.
import {authoredLesson} from './authored-content.js';
import {fail,CODE,AUDIO_MS,REVIEW_MS,TOTAL_MS,questionIds} from './domain.js';
export function lessonFor(code){
 // Bài buổi 8 giữ nguyên engine/đồng hồ cũ, thêm metadata cho lối vào chung.
 if(code===CODE||code==='8')return {code:CODE,lesson:8,title:'Science experiment for Year 12 students',book:19,test:3,part:3,
  totalMs:TOTAL_MS,audioMs:AUDIO_MS,reviewMs:REVIEW_MS,questionIds:[...questionIds],authored:false,
  groups:[{kind:'mcq',label:'Multiple choice',start:21,end:25},{kind:'flowchart',label:'Flow-chart completion',start:26,end:30}]};
 const lesson=authoredLesson(code);if(!lesson)fail('LESSON_NOT_FOUND','Bài Listening chưa được đăng ký.',404);return lesson;
}
