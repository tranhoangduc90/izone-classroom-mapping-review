// Kiểm nối điểm theo mã ERP, phân biệt ô trống/0, cache và snapshot khi dịch vụ lỗi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stableStringify} from '../src/learning-domain.js';
import {parsePortalMiniRows,createLearningPortalTestReader} from '../src/learning-portal-tests.js';
const at='2026-10-22T05:00:00.000Z',ref='12940000-0000-4000-8000-000000000001';
test('Mini thật giữ 0 khác thiếu; chặn trùng mã và điểm vượt mẫu số',()=>{
 const rows=parsePortalMiniRows([{student_contact_id:10,mini_test:{listening_grade:0,reading_grade:null}},{student_contact_id:11,mini_test:null}],at);
 assert.equal(rows[0].result.listening.correct,0);assert.equal(rows[0].result.reading,null);assert.equal(rows[1].result,null);
 assert.equal(rows[0].result.completedAt,null);
 assert.throws(()=>parsePortalMiniRows([{student_contact_id:10},{student_contact_id:10}],at),/AMBIGUOUS/);
 assert.throws(()=>parsePortalMiniRows([{student_contact_id:10,mini_test:{reading_grade:14}}],at),/SCORE_INVALID/);
});
test('ERP lỗi dùng snapshot có ngày; chỉ ghép mã được cấp, không ghép tên',async()=>{
 const rows=[{student_contact_id:10,mini_test:{listening_grade:6,reading_grade:4}}];let calls=0;
 const pool={query:async sql=>({rows:sql.includes('external_class_test_snapshot')?[{payload:rows,captured_at:at,source_hash:createHash('sha256').update(stableStringify(rows)).digest('hex')}]:[{student_ref:ref,student_id:'10'}]})};
 const reader=createLearningPortalTestReader({pool,url:'https://example.test',username:'fixture',password:'fixture',now:()=>Date.parse(at)+600000,fetchImpl:async()=>{calls++;throw Error('offline');}});
 const result=await reader({classId:'1294',studentRefs:[ref]});assert.equal(result.coverage,'stale_snapshot');assert.equal(result.results[0].studentRef,ref);assert.equal(result.results[0].result.reading.total,13);
 await reader({classId:'1294',studentRefs:[ref]});assert.equal(calls,1);
 assert.equal((await reader({classId:'1295',studentRefs:[ref]})).coverage,'not_connected');
 await assert.rejects(()=>reader({classId:'1294',studentRefs:[ref,ref]}),/INPUT_INVALID/);
});
