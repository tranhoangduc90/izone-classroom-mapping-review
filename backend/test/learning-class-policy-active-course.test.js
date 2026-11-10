import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createLearningClassPolicy} from '../src/learning-class-policy.js';
import {createLearningRouter} from '../src/learning-routes.js';

const viewer={email:'viewer@example.test',canAccessAllClasses:false,canReadCourse56:true};
const rows=[
  {class_id:'1',course_id:'4',class_status:'on_going',class_started_at:'2026-11-05'},
  {class_id:'2',course_id:'4',class_status:'completed',class_started_at:'2026-09-01'},
  {class_id:'3',course_id:'4',class_status:'pending',class_started_at:'2026-11-06'},
  {class_id:'4',course_id:'4',class_status:'cancelled',class_started_at:'2026-09-01'},
  {class_id:'5',course_id:'4',class_status:'on_going',class_started_at:'2026-11-06'},
  {class_id:'6',course_id:'4',class_status:'on_going',class_started_at:null},
  {class_id:'7',course_id:'5',class_status:'completed',class_started_at:'2026-09-01'}
];
const clock=()=>new Date('2026-11-04T17:30:00Z');
const makePolicy=(directoryReader=async()=>structuredClone(rows))=>createLearningClassPolicy({
  pool:{query:async()=>({rows:[{class_id:'2'}]})},directoryReader,now:clock
});

test('course viewer sees only ongoing K56 classes, including assigned classes',async()=>{
  const policy=makePolicy();
  const result=await policy.options(viewer,async actor=>({classes:[
    {class_id:'2',can_manage:true},{class_id:'7',can_manage:true},
    ...actor.readClassIds.map(class_id=>({class_id,can_manage:false}))
  ]}));
  assert.deepEqual(result.classes.map(row=>row.class_id).sort(),['1','7']);
  assert.equal((await policy.classRead(viewer,'1')).canAccessAllClasses,true);
  assert.equal((await policy.classRead(viewer,'7')).canAccessAllClasses,false);
});

test('direct class, assignment and course reads deny ended and not-yet-running K56',async()=>{
  const policy=makePolicy();
  for(const id of ['2','3','4','5','6']){
    await assert.rejects(()=>policy.classRead(viewer,id),{code:'CLASS_ACCESS_DENIED',httpStatus:403});
    await assert.rejects(()=>policy.courseClass(viewer,id),{code:'CLASS_ACCESS_DENIED',httpStatus:403});
  }
  await assert.rejects(()=>policy.assignmentRead(viewer,'00000000-0000-4000-8000-000000000001'),
    {code:'CLASS_ACCESS_DENIED',httpStatus:403});
});

test('ERP failure closes course-viewer reads instead of exposing assigned historical classes',async()=>{
  const policy=makePolicy(async()=>{throw Error('ERP unavailable');});
  await assert.rejects(()=>policy.options(viewer,async()=>({classes:[{class_id:'2',can_manage:true}]})),
    {code:'CLASS_STATUS_UNAVAILABLE',httpStatus:503});
  await assert.rejects(()=>policy.classRead(viewer,'2'),{code:'CLASS_STATUS_UNAVAILABLE',httpStatus:503});
});

test('admin and ordinary teacher retain their existing class scope',async()=>{
  const policy=makePolicy();
  for(const actor of [{canAccessAllClasses:true},{canAccessAllClasses:false}]){
    const result=await policy.options(actor,async()=>({classes:[{class_id:'2',can_manage:true}]}));
    assert.equal(result.classes[0].class_id,'2');
    assert.equal(await policy.classRead(actor,'2'),actor);
  }
});

test('course-viewer access follows ERP completion after the directory cache expires',async()=>{
  let time=Date.parse('2026-11-04T17:30:00Z');
  const data=structuredClone(rows);
  const policy=createLearningClassPolicy({pool:{},directoryReader:async()=>structuredClone(data),now:()=>new Date(time)});
  assert.equal((await policy.classRead(viewer,'1')).canAccessAllClasses,true);
  data[0].class_status='completed';
  time+=60001;
  await assert.rejects(()=>policy.classRead(viewer,'1'),{code:'CLASS_ACCESS_DENIED',httpStatus:403});
});

test('HTTP reads reject old class links and assignment detail before reading protected content',async()=>{
  const pool={async query(sql){
    if(sql.includes('AS global_scope'))return {rows:[{global_scope:false,course_scope:true}]};
    if(sql.includes('FROM learning.form_assignment WHERE id='))return {rows:[{class_id:'2'}]};
    throw Error('Protected content must not be queried');
  }};
  const policy=createLearningClassPolicy({pool,directoryReader:async()=>rows,now:clock});
  const app=express();app.use(express.json());
  app.use('/api/learning',createLearningRouter({pool,classPolicy:policy,
    authenticate:(req,_res,next)=>{req.reviewer=viewer;next();}}));
  for(const path of ['/teacher/classes/2/overview',
    '/teacher/classes/2/sessions/1/students/00000000-0000-4000-8000-000000000001',
    '/teacher/assignments/00000000-0000-4000-8000-000000000001/question-analytics',
    '/teacher/journey-plan?classId=2']){
    const response=await request(app).get('/api/learning'+path);
    assert.equal(response.status,403,path);
    assert.equal(response.body.error,'CLASS_ACCESS_DENIED',path);
  }
});
