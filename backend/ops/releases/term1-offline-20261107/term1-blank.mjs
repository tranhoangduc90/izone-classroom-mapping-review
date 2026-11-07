// Chỉ bài canonical Task 2 của lượt Term 1 v2 đã nộp mới nhận điểm 0.
// Thiếu field/cấu hình/receipt không được diễn giải thành bài trắng.
import {queueK56Grades} from './k56-ordered-grade-sync.js';
import {buildErpGradePayload} from './erp-sync.js';
export const isBlank=value=>typeof value==='string'&&value.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu,'').length===0;
export async function canonicalTerm1Submission(client,attempt){
 if(attempt.test_slug!=='term-test-1-k56'||!attempt.writing_submitted_at)return null;
 const run=(await client.query("SELECT state FROM assessment.term1_offline_run WHERE attempt_id=$1 AND policy='term1-offline-v1'",[attempt.id])).rows[0];
 if(!run?.state?.writing?.sealed)return null;
 if(typeof attempt.writing_task_2!=='string')throw Object.assign(Error('Thiếu bài canonical Task 2; cần đối soát.'),{code:'WRITING_CANONICAL_MISSING'});
 return {task1:'',task2:attempt.writing_task_2};
}
export async function storeTerm1Blank(client,{attempt,taskDefinitions,version}){
 if(attempt.test_slug!=='term-test-1-k56'||!attempt.writing_submitted_at||!isBlank(attempt.writing_task_2))return false;
 if(taskDefinitions.length!==1||taskDefinitions[0]?.id!=='task2')throw Object.assign(Error('Cấu hình Task 2 chưa khớp.'),{code:'BLANK_TASK_CONFIG_CONFLICT'});
 const run=(await client.query("SELECT state FROM assessment.term1_offline_run WHERE attempt_id=$1 AND policy='term1-offline-v1'",[attempt.id])).rows[0];
 if(!run?.state?.writing?.sealed)return false;
 const prior=(await client.query('SELECT status,result_json FROM assessment.term_test_writing_grading_run WHERE attempt_id=$1 AND grading_version=$2',[attempt.id,version])).rows;
 if(prior.some(x=>x.result_json?.gradingMethod!=='blank_rule'))throw Object.assign(Error('Đã có phiên chấm khác; giữ kết quả để kiểm tra.'),{code:'BLANK_GRADING_CONFLICT'});
 const final=(await client.query('SELECT grading_version,writing_score,status FROM assessment.term_test_writing_grading_final WHERE attempt_id=$1',[attempt.id])).rows[0];
 if(final&&(Number(final.grading_version)!==version||final.status!=='ready'||final.writing_score===null||Number(final.writing_score)!==0))throw Object.assign(Error('Đã có kết quả khác; không ghi đè.'),{code:'BLANK_GRADING_CONFLICT'});
 const result={taskNumber:2,taskScore:0,criteria:[],gradingMethod:'blank_rule',ruleVersion:'term1-blank-v1',reasonCode:'BLANK_SUBMISSION',
  source:{attemptId:attempt.id,taskNumber:2,submittedAt:attempt.writing_submitted_at},report:'Không có nội dung bài làm — 0 điểm theo quy tắc. Không gọi AI.'};
 await client.query(`INSERT INTO assessment.term_test_writing_grading_run(attempt_id,task_number,grading_version,run_key,prompt_text,essay_text,word_count,status,task_score,result_json,completed_at)
  VALUES($1,2,$2,$3,$4,$5,0,'complete',0,$6::jsonb,now()) ON CONFLICT(attempt_id,task_number,grading_version) DO NOTHING`,[attempt.id,version,`term-test-1-k56:${attempt.id}:task2:v${version}`,taskDefinitions[0].prompt||'',attempt.writing_task_2,JSON.stringify(result)]);
 await client.query(`INSERT INTO assessment.term_test_writing_grading_final(attempt_id,grading_version,task_2_run_id,task_2_score,writing_score,status,ready_at)
  SELECT $1,$2,id,0,0,'ready',now() FROM assessment.term_test_writing_grading_run WHERE attempt_id=$1 AND task_number=2 AND grading_version=$2
  ON CONFLICT(attempt_id) DO NOTHING`,[attempt.id,version]);
 await queueK56Grades(client,buildErpGradePayload({...attempt,attempt_token:attempt.id,class_id:attempt.erp_course_class_id,student_id:attempt.erp_student_contact_id},null,{writing:0}));
 return true;
}
