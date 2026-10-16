import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

// Đầu vào là hai lượt bài giả của cùng học viên. SQL/HTTP thật phải giữ điểm L/R mới
// và chọn đúng lượt Writing đã nộp; việc đọc không tạo job, ghi điểm hay đổi bài.
let fixture,api,syncCalls=0;
const ref='11111111-1111-4111-8111-111111111111';
const otherRef='44444444-4444-4444-8444-444444444444';
before(async()=>{
  fixture=await createMiniFixture({completeSchema:true,syncErpGrades:async()=>{syncCalls++;throw Error('Không được gửi điểm từ trang giáo viên');}});
  api=request(fixture.app);
  const source=await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8');
  for(const name of ['reviewer_account','reviewer_session','reviewer_class_access']){
    if(!(await fixture.db.query('SELECT to_regclass($1) AS present',['mapping.'+name])).rows[0].present)
      await fixture.db.exec(source.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0]);
  }
  await fixture.db.exec(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT 'term-test-1','Đề Writing giả',1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5';`);
});
after(async()=>fixture?.db.close());
const get=(path)=>api.get('/api/term-tests/teacher/'+path).set('x-review-token','fixture-only-key');
async function clean(){
  await fixture.db.exec(`DELETE FROM assessment.term_test_writing_grading_final;
    DELETE FROM assessment.term_test_writing_grading_run;DELETE FROM assessment.term_test_attempt;`);
  syncCalls=0;
}
async function attempt({student=900001,hours=3,writing=false,essay='Bài Writing gốc',score=6,ready=true,superseded=false}={}){
  const id=randomUUID();
  await fixture.db.query(`INSERT INTO assessment.term_test_attempt
    (id,client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,
    student_name_snapshot,listening_answers,listening_result,listening_submitted_at,reading_answers,reading_result,
    reading_submitted_at,completed_at,combined_result,created_at,writing_task_2,writing_submitted_at,superseded_at,
    writing_started_at,writing_updated_at)
    VALUES($1,$2,'term-test-1',1,1293,'IC2304',$3,'Tên học viên trùng nhau','{}','{}',now()-make_interval(hours=>$4),
    '{}','{}',now()-make_interval(hours=>$4),now()-make_interval(hours=>$4),$5,now()-make_interval(hours=>$4),$6,
    CASE WHEN $7 THEN now()-make_interval(hours=>$4)+interval '10 minutes' ELSE NULL END,
    CASE WHEN $8 THEN now() ELSE NULL END,
    CASE WHEN $7 THEN now()-make_interval(hours=>$4)+interval '1 minute' ELSE NULL END,
    CASE WHEN $7 THEN now()-make_interval(hours=>$4)+interval '10 minutes' ELSE NULL END)`,
    [id,randomUUID(),student,hours,JSON.stringify({listening:{band:hours===1?6.5:1},reading:{band:6}}),writing?essay:'',writing,superseded]);
  if(writing&&ready){
    const run=randomUUID();
    await fixture.db.query(`INSERT INTO assessment.term_test_writing_grading_run
      (id,attempt_id,task_number,run_key,prompt_text,essay_text,status,task_score,word_count,result_json,completed_at)
      VALUES($1,$2,2,$3,'Đề giả',$4,'complete',$5,281,$6,now())`,
      [run,id,randomUUID(),essay,score,JSON.stringify({criteria:[],report:'Nhận xét nguyên gốc: '+essay})]);
    await fixture.db.query(`INSERT INTO assessment.term_test_writing_grading_final
      (attempt_id,task_2_run_id,task_2_score,writing_score,status,ready_at) VALUES($1,$2,$3,$3,'ready',now())`,[id,run,score]);
  }
  return id;
}
async function details(status=200){return get(`writing-detail?class=IC2304&test=term-test-1&student=${ref}&task=2`).expect(status);}
async function overview(){
  const r=await get('results?class=IC2304&test=term-test-1').expect(200);
  return r.body.students.find(s=>s.ref===ref);
}
test('Answer sheet mới không che Writing đã chấm; điểm và bài chấm cùng nguồn, không ghi dữ liệu',async()=>{
  await clean();await attempt({writing:true});await attempt({hours:1});
  const before=(await fixture.db.query('SELECT * FROM assessment.term_test_attempt ORDER BY id')).rows;
  const student=await overview();
  assert.equal(student.result.listening.band,6.5);
  assert.equal(student.writing.status,'ready');assert.equal(student.writing.writingScore,6);
  const response=await details();
  assert.equal(response.body.writing.essay,'Bài Writing gốc');
  assert.equal(response.body.writing.report,'Nhận xét nguyên gốc: Bài Writing gốc');
  assert.equal(response.body.writing.taskScore,6);
  assert.deepEqual((await fixture.db.query('SELECT * FROM assessment.term_test_attempt ORDER BY id')).rows,before);
  assert.equal(syncCalls,0);
  assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job')).rows[0].n,0);
});
test('Writing đã nộp mới hơn thắng bài cũ, không lấy nhầm bài từ học viên trùng tên',async()=>{
  await clean();await attempt({writing:true});await attempt({hours:2,writing:true,essay:'Bài Writing lần sau',score:7});
  await attempt({hours:1});await attempt({student:900002,hours:0,writing:true,essay:'Bài của người khác',score:9});
  const student=await overview();assert.equal(student.writing.writingScore,7);
  const response=await details();assert.equal(response.body.writing.essay,'Bài Writing lần sau');
  assert.equal(response.body.writing.taskScore,7);
  const other=await get(`writing-detail?class=IC2304&test=term-test-1&student=${otherRef}&task=2`).expect(200);
  assert.equal(other.body.writing.essay,'Bài của người khác');
});
test('Writing mới đang chấm phải hiện đang chấm; không trả điểm và bài chấm cũ',async()=>{
  await clean();await attempt({writing:true});await attempt({hours:1,writing:true,ready:false,essay:'Bài mới chưa chấm'});
  const student=await overview();assert.equal(student.writing.status,'processing');assert.equal(student.writing.writingScore,null);
  await details(404);
});
test('Bài chưa nộp và lượt đã thay thế không che Writing hợp lệ',async()=>{
  await clean();await attempt({writing:true});await attempt({hours:1,writing:true,essay:'Bài đã thay thế',score:9,superseded:true});
  const draft=await attempt({hours:0});await fixture.db.query('UPDATE assessment.term_test_attempt SET writing_task_2=$2 WHERE id=$1',[draft,'Nháp chưa nộp']);
  assert.equal((await overview()).writing.writingScore,6);
  assert.equal((await details()).body.writing.essay,'Bài Writing gốc');
});
