import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { postgresFixture } from './learning-postgres-fixture.js';
import { createLearningClassPolicy } from '../src/learning-class-policy.js';

test('PostgreSQL learning_api: Progress Log scope uses its grants and rechecks the active directory',async()=>{
  const fixture=await postgresFixture({asApplication:true,studentCount:0});
  try{
    const ddl=await readFile(new URL('../ops/learning-migrations/202611050001_progress_log_course_viewer.sql',import.meta.url),'utf8');
    await fixture.pool.query(ddl);
    await fixture.pool.query(`INSERT INTO mapping.reviewer_account(email,status) VALUES
      ('viewer@example.test','active'),('owner@example.test','active');
      INSERT INTO learning.progress_log_admin(reviewer_email,grant_reference) VALUES
        ('owner@example.test','Native test admin only');
      INSERT INTO learning.progress_log_course_viewer(reviewer_email,course_id) VALUES
        ('viewer@example.test',4);`);
    const data=[
      {class_id:'2139',class_name:'Lớp thử được phân công',course_id:'5',class_status:'on_going',class_started_at:'2026-11-01'},
      {class_id:'2140',class_name:'Lớp chỉ xem',course_id:'4',class_status:'on_going',class_started_at:'2026-11-04'}
    ];
    let reads=0;
    const policy=createLearningClassPolicy({pool:fixture.clockPool,directoryReader:async()=>{reads++;return structuredClone(data);},
      now:()=>new Date('2026-11-04T17:30:00Z')});
    const teacher=await policy.reviewer({email:'teacher@example.test',role:'admin',canAccessAllClasses:true});
    const viewer=await policy.reviewer({email:'viewer@example.test',role:'teacher',canAccessAllClasses:false});
    const owner=await policy.reviewer({email:'owner@example.test',role:'teacher',canAccessAllClasses:false});
    assert.deepEqual([teacher.canAccessAllClasses,viewer.canReadCourse56,owner.canAccessAllClasses],[false,true,true]);
    assert.equal((await policy.classRead(viewer,'2140')).canAccessAllClasses,true);
    assert.equal((await policy.classRead(viewer,'2139')).canAccessAllClasses,false);
    assert.equal(viewer.canAccessAllClasses,false);
    const teacherOptions=await policy.options(teacher,fixture.service.listTeacherOptions);
    assert.deepEqual(teacherOptions.assignmentClasses.map(row=>row.class_id),['2139']);
    assert.equal(reads,1);
    const viewerOptions=await policy.options(viewer,fixture.service.listTeacherOptions);
    assert.deepEqual(viewerOptions.assignmentClasses,[]);
    assert.equal(viewerOptions.classes.find(row=>row.class_id==='2140').can_manage,false);
    data[0].class_status='completed';
    const validate=policy.deliveryCheck({fresh:true});
    await assert.rejects(()=>validate('2139'),{code:'CLASS_NOT_ONGOING'});
    await assert.rejects(()=>validate('2900'),{code:'CLASS_STATUS_UNAVAILABLE'});
    assert.equal(reads,2);
    await assert.rejects(()=>fixture.clockPool.query("INSERT INTO learning.progress_log_course_viewer VALUES('teacher@example.test',4)"),{code:'42501'});
  }finally{await fixture.close();}
});
