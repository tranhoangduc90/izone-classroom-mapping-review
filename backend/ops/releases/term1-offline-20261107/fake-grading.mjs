// Chỉ fixture cách ly: mô phỏng đầu ra AI, đi qua hàm nhận kết quả native.
import assert from 'node:assert/strict';
export async function completeFakeResult(f,taskNumber=2){
 await f.db.exec(`ALTER TABLE assessment.term_test_writing_grading_run ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz, ADD COLUMN IF NOT EXISTS lark_record_id text, ADD COLUMN IF NOT EXISTS last_error_code text;
 ALTER TABLE assessment.term_test_writing_grading_job ADD COLUMN IF NOT EXISTS worker_id text,ADD COLUMN IF NOT EXISTS completed_at timestamptz,ADD COLUMN IF NOT EXISTS lease_until timestamptz,ADD COLUMN IF NOT EXISTS updated_at timestamptz,ADD COLUMN IF NOT EXISTS last_error_code text;
 ALTER TABLE assessment.term_test_writing_grading_final ADD COLUMN IF NOT EXISTS updated_at timestamptz;
 CREATE TABLE IF NOT EXISTS assessment.term_test_writing_grading_criterion(run_id uuid,criterion_code text,status text,band_score numeric,feedback text,completed_at timestamptz,updated_at timestamptz,PRIMARY KEY(run_id,criterion_code));
 CREATE TABLE IF NOT EXISTS assessment.term_test_writing_grading_component(run_id uuid,criterion_code text,component_code text,status text,label text,summary text,feedback text,completed_at timestamptz,updated_at timestamptz,PRIMARY KEY(run_id,component_code));`);
 const job=(await f.db.query('SELECT j.id,r.run_key,r.task_number FROM assessment.term_test_writing_grading_job j JOIN assessment.term_test_writing_grading_run r ON j.run_id=r.id')).rows;assert.equal(job.length,1);assert.equal(Number(job[0].task_number),taskNumber);
 await f.db.query("UPDATE assessment.term_test_writing_grading_job SET job_type='collect',status='processing',worker_id='fixture'");
 const catalog={...(taskNumber===2?{TR:['tr_task_coverage','tr_position','tr_idea_development']}:{TA:['ta_key_features_overview','ta_data_support']}),CC:['cc_organization','cc_cohesive_devices','cc_referencing'],LR:['lr_range','lr_word_choice','lr_word_formation_spelling'],GRA:['gra_detail']};
 const result={taskScore:6,report:'Fixture feedback only; no external AI call.',criteria:Object.entries(catalog).map(([code,keys])=>({code,bandScore:6,feedback:'Fixture feedback',components:keys.map(code=>({code,feedback:'Fixture detail'}))}))};
 await f.grading.completeResult({jobId:job[0].id,workerId:'fixture',runKey:job[0].run_key,result});
 const final=(await f.db.query('SELECT writing_score,task_1_score,task_2_score,status FROM assessment.term_test_writing_grading_final')).rows[0];assert.equal(Number(final.writing_score),6);assert.equal(final.status,'ready');if(taskNumber===2){assert.equal(final.task_1_score,null);assert.equal(Number(final.task_2_score),6);}return final;
}
