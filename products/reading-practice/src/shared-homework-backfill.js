import {transaction} from './service.js';
import {ROBOTS_CODE,lessonFor} from './lessons.js';
import {fail,uuid} from './domain.js';

// Đọc trạng thái đã lưu và xếp đúng sự kiện cuối; không chấm lại hay sửa lịch sử bài làm.
// Khóa hàng bài làm cùng giao dịch; chạy lại dùng sequence cũ nên không tạo việc trùng.
export async function queueSharedHomeworkBackfill({pool,pageBase,commit=false,bindingId=null,code=ROBOTS_CODE}){
 lessonFor(code);
 return transaction(pool,async db=>{
  const rows=(await db.query(`SELECT b.id,w.state FROM reading_practice.binding b
   JOIN reading_practice.assignment a ON a.id=b.assignment_id
   JOIN reading_practice.content c ON c.id=a.content_id JOIN reading_practice.work w ON w.binding_id=b.id
   WHERE c.code=$1 AND b.document_id IS NULL AND b.owner_proof->>'mode'='shared'
   AND w.state->>'firstCompleted' IS NOT NULL AND ($2::uuid IS NULL OR b.id=$2::uuid)
   ORDER BY b.id FOR UPDATE OF w`,[code,bindingId])).rows;
  let queued=0,existing=0;
  for(const row of rows){
   const event=row.state.events.at(-1),attempt=row.state.attempts.find(a=>a.no===event?.attempt);
   if(!event||!attempt||!Number.isInteger(event.sequence)||!event.message||(event.type==='completed'&&!attempt.submissionId))fail('BACKFILL_STATE_INVALID','Lịch sử thiếu định danh; không xếp hàng cập nhật.');
   const found=(await db.query('SELECT id FROM reading_practice.doc_job WHERE binding_id=$1 AND sequence=$2',[row.id,event.sequence])).rows.length;
   if(found){existing++;continue;}
   if(commit)await db.query(`INSERT INTO reading_practice.doc_job(id,binding_id,sequence,kind,payload)
    VALUES($1,$2,$3,'status',$4) ON CONFLICT(binding_id,sequence) DO NOTHING`,[uuid(),row.id,event.sequence,
    {text:event.message,link:event.type==='completed'?`${pageBase}teacher.html#submission=${attempt.submissionId}`:'',attemptId:attempt.id,attemptNo:attempt.no}]);
   queued++;
  }
  return{commit,eligible:rows.length,existing,...(commit?{queued}:{wouldQueue:queued})};
 });
}
