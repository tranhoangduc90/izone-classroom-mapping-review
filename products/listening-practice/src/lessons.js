// Catalog link chung chỉ nhận bài Listening đã đăng ký; bài cũ giữ link cá nhân.
import {authoredLesson} from './authored-content.js';
import {fail} from './domain.js';
export function lessonFor(code){const lesson=authoredLesson(code);if(!lesson)fail('LESSON_NOT_FOUND','Bài Listening chưa được đăng ký.',404);return lesson;}
