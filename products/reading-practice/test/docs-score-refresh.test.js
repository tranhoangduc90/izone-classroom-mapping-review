import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {CODE,uuid} from '../src/domain.js';
import {ROBOTS_CODE} from '../src/lessons.js';
import {createDocsWorker,STATUS_HEADING} from '../src/docs.js';
import {inspectLesson9ScoreRefresh,queueLesson9ScoreRefresh} from '../src/doc-score-refresh.js';

const pageBase='https://example.test/reading-practice/';
// Dựng ảnh chụp lịch sử giả tương đương một lượt Lesson 9 đã ghi Docs trước khi có điểm.
async function setup(t){
 const f=await fixture();t.after(f.close);const start=await f.begin();
 await f.service.submit({token:f.token,attemptId:start.attempts[0].id,lease:start.lease,snapshot:f.draft(),method:'manual',operationId:uuid()});
 const state=(await f.pool.query('SELECT state FROM reading_practice.work')).rows[0].state,a=state.attempts[0];
 a.result={score:8,rows:Array.from({length:14},(_,i)=>({number:27+i,state:i<8?'correct':'blank',answer:i<8?'C':'',expected:['C']}))};a.finalScore=8;
 a.draft.answers=Object.fromEntries(Array.from({length:8},(_,i)=>[27+i,'C']));
 const old='Đã hoàn thành ngay từ lần đầu. Giảng viên nhấn vào đây để xem kết quả.';
 state.events.at(-1).message=old;
 await f.pool.query('UPDATE reading_practice.work SET state=$1',[state]);
 await f.pool.query("UPDATE reading_practice.content SET code=$1,version='cam20-t3-p3-robots-and-us-v1',answer_key=$2 WHERE code=$3",[ROBOTS_CODE,Object.fromEntries(Array.from({length:14},(_,i)=>[27+i,['C']])),CODE]);
 await f.pool.query("UPDATE reading_practice.assignment SET class_id='1293',class_code='IC2304'");
 const target={classId:'1293',studentRef:f.studentRef,code:ROBOTS_CODE,documentId:'lesson9_fixture',tabId:'child'};
 await f.pool.query('UPDATE reading_practice.binding SET document_id=NULL,tab_id=NULL,owner_proof=$1,last_doc_sequence=2,last_doc_text=$2,last_doc_link=$3',[{mode:'shared',homework:target},old,pageBase+'teacher.html#submission='+a.submissionId]);
 await f.pool.query("UPDATE reading_practice.doc_job SET status='verified',verified_at=now()");
 await f.pool.query("UPDATE reading_practice.doc_job SET payload=jsonb_set(payload,'{text}',$1::jsonb) WHERE sequence=2",[JSON.stringify(old)]);
 f.context.student=async(c,id)=>c==='1293'&&id===f.studentRef?{studentRef:id,name:'Học viên giả'}:undefined;
 const b=(await f.pool.query('SELECT * FROM reading_practice.binding')).rows[0];
 let value='Chữ nhập tay giữ nguyên\nReading thực chiến (tự động): '+old,link=b.last_doc_link,writes=0,loseAck=false;
 const paragraph=(index,text,url='')=>({paragraph:{elements:[{startIndex:index,endIndex:index+text.length,textRun:{content:text,textStyle:url?{link:{url}}:{}}},{startIndex:index+text.length,endIndex:index+text.length+1,textRun:{content:'\n'}}]}});
 const cell=(index,text,url='')=>({content:[paragraph(index,text,url)]});
 const docs={read:async id=>{assert.equal(id,target.documentId);return{documentId:id,revisionId:'fixture_rev',tabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[paragraph(1,ROBOTS_CODE),{table:{tableRows:[{tableCells:[cell(100,STATUS_HEADING)]},{tableCells:[cell(200,value,link)]}]}}]}}}]};},
  write:async(id,plan)=>{assert.equal(id,target.documentId);writes++;
   for(const r of plan.requests){
    if(r.deleteContentRange){const s=r.deleteContentRange.range.startIndex-200,e=r.deleteContentRange.range.endIndex-200;assert.ok(s>=value.indexOf('Reading thực chiến'));value=value.slice(0,s)+value.slice(e);}
    if(r.insertText){const s=r.insertText.location.index-200;value=value.slice(0,s)+r.insertText.text+value.slice(s);}
    if(r.updateTextStyle?.textStyle.link)link=r.updateTextStyle.textStyle.link.url;
   }
   if(loseAck)throw new Error('Mất phản hồi sau khi Google ghi');
  }};
 const worker=createDocsWorker({pool:f.pool,docs,resolveSharedHomework:async()=>target});
 return{...f,worker,a,options:{pool:f.pool,pageBase},getValue:()=>value,getWrites:()=>writes,setLoseAck:v=>loseAck=v};
}

test('Làm mới Lesson 9: đúng 8/14, giữ sequence/lịch sử, cập nhật dấu vết cùng sequence và chạy lặp không ghi',async t=>{
 const f=await setup(t),before=(await f.pool.query('SELECT state,updated_at FROM reading_practice.work')).rows;
 const preview=await inspectLesson9ScoreRefresh(f.options);assert.equal(preview.candidates.length,1);
 const expected=preview.candidates[0];assert.ok(expected.newText.includes('đúng 8/14 câu.'));
 assert.equal((await queueLesson9ScoreRefresh({...f.options,expected})).outcome,'queued');
 assert.equal((await queueLesson9ScoreRefresh({...f.options,expected})).outcome,'already_queued');
 await f.worker.once();
 const b=(await f.pool.query('SELECT last_doc_sequence,last_doc_text FROM reading_practice.binding')).rows[0];
 assert.equal(b.last_doc_sequence,2);assert.equal(b.last_doc_text,expected.newText);
 assert.ok(f.getValue().startsWith('Chữ nhập tay giữ nguyên\nReading thực chiến (tự động): '));
 assert.equal((await queueLesson9ScoreRefresh({...f.options,expected})).outcome,'already_current');
 assert.equal(await f.worker.once(),false);assert.equal(f.getWrites(),1);
 assert.deepEqual((await f.pool.query('SELECT state,updated_at FROM reading_practice.work')).rows,before);
});
test('Làm mới rồi reset: job mới nối tiếp đúng dấu vết, không bị hiểu nhầm là sửa tay',async t=>{
 const f=await setup(t),expected=(await inspectLesson9ScoreRefresh(f.options)).candidates[0];
 await queueLesson9ScoreRefresh({...f.options,expected});
 await f.service.reset({token:f.token,attemptId:f.a.id,owner:'device1',operationId:uuid()});
 await f.worker.once();await f.worker.once();
 const jobs=(await f.pool.query('SELECT status FROM reading_practice.doc_job ORDER BY sequence')).rows;
 assert.ok(jobs.every(j=>j.status==='verified'));
 assert.ok(f.getValue().includes('Đã bắt đầu làm bài số 2'));assert.ok(!f.getValue().includes('Kết quả:'));
});
test('Làm mới mất ACK: đọc lại không nhân ghi; thiếu bản xem trước, sai lớp và stale đều dừng',async t=>{
 const f=await setup(t),expected=(await inspectLesson9ScoreRefresh(f.options)).candidates[0];
 await assert.rejects(queueLesson9ScoreRefresh(f.options),e=>e.code==='REFRESH_PROOF_REQUIRED');
 await assert.rejects(queueLesson9ScoreRefresh({...f.options,expected:{...expected,workHash:'stale'}}),e=>e.code==='REFRESH_STATE_CHANGED');
 await f.pool.query("UPDATE reading_practice.assignment SET class_code='OTHER'");
 await assert.rejects(queueLesson9ScoreRefresh({...f.options,expected}),e=>e.code==='REFRESH_SCOPE_MISMATCH');
 await f.pool.query("UPDATE reading_practice.assignment SET class_code='IC2304'");
 await queueLesson9ScoreRefresh({...f.options,expected});f.setLoseAck(true);await f.worker.once();
 assert.equal(f.getWrites(),1);await f.pool.query('UPDATE reading_practice.doc_job SET available_at=now()');await f.worker.once();
 assert.equal(f.getWrites(),1);assert.equal((await queueLesson9ScoreRefresh({...f.options,expected})).outcome,'already_current');
});
test('Worker làm mới: metadata cũ không được ghi đè trạng thái đã tiến lên',async t=>{
 const f=await setup(t),expected=(await inspectLesson9ScoreRefresh(f.options)).candidates[0];
 await queueLesson9ScoreRefresh({...f.options,expected});
 await f.pool.query('UPDATE reading_practice.binding SET last_doc_sequence=3');
 await f.worker.once();assert.equal(f.getWrites(),0);
 assert.equal((await f.pool.query('SELECT error_code FROM reading_practice.doc_job WHERE sequence=2')).rows[0].error_code,'DOC_STATUS_REFRESH_CONFLICT');
});
