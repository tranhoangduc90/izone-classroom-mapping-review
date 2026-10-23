// Nhận pool PostgreSQL của Progress Log. Chỉ đặt tên các câu SQL cố định thường chạy;
// PostgreSQL dùng lại kế hoạch trên cùng connection, giữ nguyên tham số, quyền, khóa và lỗi gốc.
import {createHash} from 'node:crypto';
import * as learningSql from './learning-sql.js';
import {fetchQuestionAnalyticsSql} from './learning-question-analytics.js';
const names=new Map([...Object.values(learningSql).filter(value=>typeof value==='string'),fetchQuestionAnalyticsSql].map(sql=>[
    sql,'learning_hot_'+createHash('sha256').update(sql).digest('hex').slice(0,20)]));
const installed=new WeakSet();
const sessionInstalled=new WeakSet(),sessionNames=new Map();
// Chỉ tối ưu lập kế hoạch của đúng câu kiểm phiên đang dùng; vẫn chạy điều kiện thu hồi/hạn mỗi request.
export function reuseTeacherSessionQueryPlans(pool){
  if(sessionInstalled.has(pool))return pool;sessionInstalled.add(pool);
  pool.on('connect',client=>{const original=client.query.bind(client);client.query=(sql,...args)=>{
    if(typeof sql!=='string'||!/^UPDATE mapping\.reviewer_session AS session\s/.test(sql))return original(sql,...args);
    if(!sessionNames.has(sql))sessionNames.set(sql,'teacher_session_'+createHash('sha256').update(sql).digest('hex').slice(0,20));
    return original({name:sessionNames.get(sql),text:sql},...args);
  }});
  return pool;
}
export function reuseLearningQueryPlans(pool){
  if(installed.has(pool))return pool;installed.add(pool);
  pool.on('connect',client=>{
    const original=client.query.bind(client);
    client.query=(sql,...args)=>original(names.has(sql)?{name:names.get(sql),text:sql}:sql,...args);
  });
  return pool;
}
