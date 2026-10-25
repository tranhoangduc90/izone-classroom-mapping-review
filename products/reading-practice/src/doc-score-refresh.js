import {canonical,fail,hash,resultSummary,statusMessage} from './domain.js';
import {ROBOTS_CODE} from './lessons.js';
import {transaction} from './service.js';

const VERSION='cam20-t3-p3-robots-and-us-v1';
const select=`SELECT b.*,a.class_id,a.class_code,c.code,c.version,w.state
 FROM reading_practice.binding b JOIN reading_practice.assignment a ON a.id=b.assignment_id
 JOIN reading_practice.content c ON c.id=a.content_id JOIN reading_practice.work w ON w.binding_id=b.id
 WHERE a.class_id='1293' AND a.class_code='IC2304' AND c.code=$1 AND c.version=$2
 AND b.document_id IS NULL AND b.owner_proof->>'mode'='shared'`;

// Chỉ lập danh sách Lesson 9 IC2304. Không tạo lượt/sự kiện và không đổi bài/điểm đã lưu.
async function describe(db,b,pageBase){
 const event=b.state.events.at(-1),a=b.state.attempts.find(a=>a.no===event?.attempt);
 const summary=a&&resultSummary(a),target=b.owner_proof.homework;
 if(event?.type!=='completed'||a?.status!=='submitted'||!a.submissionId||!summary||summary.total!==14
  ||event.sequence!==b.state.sequence||b.last_doc_sequence!==event.sequence||!target?.documentId||!target.tabId)
  fail('REFRESH_STATE_CHANGED','Hồ sơ không còn là lượt hoàn thành đã ghi Docs.');
 const jobs=(await db.query('SELECT * FROM reading_practice.doc_job WHERE binding_id=$1 ORDER BY sequence',[b.id])).rows;
 const job=jobs.find(j=>j.sequence===event.sequence);
 if(!job||job.kind!=='status'||job.payload.attemptId!==a.id||job.payload.attemptNo!==a.no
  ||job.payload.link!==pageBase+'teacher.html#submission='+a.submissionId
  ||jobs.some(j=>j.sequence!==event.sequence&&j.status!=='verified'))
  fail('REFRESH_JOBS_CHANGED','Hàng Docs đang có việc khác hoặc không khớp lượt.');
 const newText=statusMessage(a,b.state.firstCompleted);
 if(job.status!=='verified'&&!(job.payload.scoreRefresh?.version===1&&job.payload.text===newText))
  fail('REFRESH_JOBS_CHANGED','Thông báo hiện hành chưa được xác minh.');
 return {bindingId:b.id,documentId:target.documentId,tabId:target.tabId,sequence:event.sequence,
  attemptId:a.id,submissionId:a.submissionId,oldText:b.last_doc_text,newText,link:job.payload.link,
  workHash:hash(canonical(b.state)),payloadHash:hash(canonical(job.payload)),jobId:job.id,
  jobStatus:job.status,alreadyCurrent:job.status==='verified'&&job.payload.text===newText&&b.last_doc_text===newText};
}

export async function inspectLesson9ScoreRefresh({pool,pageBase}){
 const rows=(await pool.query(select+' ORDER BY b.id',[ROBOTS_CODE,VERSION])).rows;
 const candidates=[],skipped=[];
 for(const b of rows){
  try{candidates.push(await describe(pool,b,pageBase));}
  catch(e){skipped.push({bindingId:b.id,code:e.code||'REFRESH_INSPECT_FAILED'});}
 }
 return {candidates,skipped};
}

// Nhận đúng bản xem trước đã kiểm chủ Docs; khóa bài/job trước khi chuyển một job sang chờ.
// Giữ nguyên sequence. Chạy lặp chỉ báo đã xếp/đã đúng, không tạo job hoặc sửa lịch sử.
export async function queueLesson9ScoreRefresh({pool,pageBase,expected}){
 if(!expected?.bindingId||!expected.workHash||!expected.payloadHash)fail('REFRESH_PROOF_REQUIRED','Thiếu bản xem trước đã khóa.');
 return transaction(pool,async db=>{
  const b=(await db.query(select+' AND b.id=$3 FOR UPDATE OF b,w',[ROBOTS_CODE,VERSION,expected.bindingId])).rows[0];
  if(!b)fail('REFRESH_SCOPE_MISMATCH','Chỉ được làm mới Lesson 9 IC2304.');
  await db.query('SELECT id FROM reading_practice.doc_job WHERE binding_id=$1 FOR UPDATE',[b.id]);
  const current=await describe(db,b,pageBase);
  for(const key of ['documentId','tabId','sequence','attemptId','submissionId','workHash','link'])
   if(current[key]!==expected[key])fail('REFRESH_STATE_CHANGED','Hồ sơ đã đổi sau bản xem trước.');
  if(current.alreadyCurrent)return {bindingId:b.id,outcome:'already_current'};
  if(current.jobStatus!=='verified')return {bindingId:b.id,outcome:'already_queued'};
  if(current.payloadHash!==expected.payloadHash||current.oldText!==expected.oldText)
   fail('REFRESH_STATE_CHANGED','Thông báo đã đổi sau bản xem trước.');
  const job=(await db.query('SELECT payload FROM reading_practice.doc_job WHERE id=$1',[current.jobId])).rows[0];
  const payload={...job.payload,text:current.newText,scoreRefresh:{version:1,sequence:current.sequence,previousText:current.oldText}};
  await db.query(`UPDATE reading_practice.doc_job SET payload=$2,status='pending',available_at=now(),
   attempts=0,error_code=NULL,lease_id=NULL,lease_until=NULL,verified_at=NULL WHERE id=$1`,[current.jobId,payload]);
  return {bindingId:b.id,outcome:'queued'};
 });
}
