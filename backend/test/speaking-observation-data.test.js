import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,seedBatch,id,code,token,hash} from './speaking-observation-fixture.mjs';
import {createSpeakingObservationData} from '../src/speaking-observation-data.js';
import {speakingObservationView,speakingContentRevision,speakingDocsRevision} from '../src/speaking-observation-view.js';

const independent='speaking_independent',legacy='speaking_homework';
const identity=n=>({accessToken:token(n),studentRef:id(n)});
const wire=value=>JSON.parse(JSON.stringify(value));
// PGlite trả bigint nhỏ là Number; PostgreSQL/node-pg trả String. Chỉ chuẩn hóa
// trường classId/sequence này khi đối chiếu hai driver, không đổi UUID/quyền/status.
function nativeWire(open){const value=wire(open);if(value.assignment)value.assignment.classId=String(value.assignment.classId);
 if(value.docsProgress)for(const key of ['sequence','applied_sequence'])value.docsProgress[key]=String(value.docsProgress[key]);return value;}
const scope={classId:'2304',code,courseId:'100'};

test('Speaking state data: một SELECT cho100 scope/phiên trùng và100 chủ riêng, đúng ID/lớp/kho, không mang nội dung bài',async t=>{
 const f=await fixture();try{
  for(const schema of [independent,legacy]){
   f.reads.length=0;
   const base=schema===independent?1000:2000;
   const rows=await f.data(schema).read({classes:Array.from({length:100},()=>scope),
    unitIds:Array.from({length:100},(_,index)=>id(base+(index%2+1))),
    sessions:Array.from({length:100},(_,index)=>({hash:hash(token(index%2+1)),studentRef:id(index%2+1)}))});
   assert.equal(f.reads.length,1);assert.ok(f.reads[0].startsWith('WITH '));
   const ids=rows.map(row=>row.unit_id);assert.equal(new Set(ids).size,ids.length);
   assert.deepEqual(ids.sort(),(schema===independent?[1001,1002,1003,1004]:[2001,2002,2003]).map(id));
   assert.ok(rows.every(row=>row.schema===schema&&row.content===null&&/^[a-f0-9]{32}$/.test(row.content_revision)));
   const a=rows.find(row=>row.unit_id===id(base+1)),b=rows.find(row=>row.unit_id===id(base+2));
   assert.equal(a.student_name,b.student_name);assert.notEqual(a.student_ref,b.student_ref);
   assert.equal(a.class_id,'2304');assert.equal(b.class_id,'2305');
   assert.equal(a.sent_links,3);assert.equal(a.accepted_links,1);
   assert.deepEqual(a.matched_sessions,[{hash:hash(token(1)),studentRef:id(1)}]);
   assert.deepEqual(b.matched_sessions,[{hash:hash(token(2)),studentRef:id(2)}]);
   const serialized=JSON.stringify(rows);assert.equal(serialized.includes('https://chatgpt.com/share/'),false);
   assert.equal(serialized.includes('https://fixture.invalid/'),false);assert.equal(serialized.includes(token(1)),false);
  }
  const batch=await seedBatch(f),expected=new Map(batch.map(row=>[row.unit,row]));
  const revisions=[];
  for(const schema of [independent,legacy]){
   f.reads.length=0;
   const rows=await f.data(schema).read({sessions:[...batch].reverse().map(row=>({hash:row.hash,studentRef:row.student}))});
   assert.equal(f.reads.length,1);assert.equal(rows.length,100);assert.equal(new Set(rows.map(row=>row.unit_id)).size,100);
   assert.equal(new Set(rows.map(row=>row.content_revision)).size,100);
   assert.equal(new Set(rows.map(speakingDocsRevision)).size,100);
   for(const row of rows){
    const owner=expected.get(row.unit_id);assert.ok(owner);assert.equal(row.student_ref,owner.student);assert.equal(row.schema,schema);
    assert.deepEqual(row.matched_sessions,[{hash:owner.hash,studentRef:owner.student}]);assert.equal(row.content,null);
   }
   revisions.push(rows.map(row=>speakingContentRevision(row,{exercises:[]})));
  }
  assert.ok(revisions[0].every((revision,index)=>revision!==revisions[1][index]));
  t.diagnostic(JSON.stringify({event:'speaking_observation_data_shape',descriptors:100,distinctOwners:100,sqlPerStore:1,contentPayloads:0,
   engine:f.nativeUrl?'postgresql':'pglite',scope:'data projection only; guards/stream/UI not yet wired'}));
 }finally{await f.close();}
});

test('Speaking state view: snapshot một SQL khớp open/Doctor native cho hai kho, hồ sơ liên kết và lượt nộp',async()=>{
 const f=await fixture();try{
  const context=await f.source.context({assignmentCode:code});
  for(const schema of [independent,legacy]){
   for(const n of schema===independent?[1,2,3,4]:[1,2,3]){
    const unitId=id((schema===independent?1000:2000)+n);f.reads.length=0;
    const [row]=await f.data(schema).read({sessions:[{hash:hash(token(n)),studentRef:id(n)}],contentIds:[unitId]});
    assert.equal(f.reads.length,1);assert.equal(row.unit_id,unitId);
    const view=speakingObservationView(row,context),service=schema===independent?f.independent:f.legacy;
    const opened=await service.open(identity(n)),doctor=await service.listDoctor(identity(n));
    assert.deepEqual(nativeWire(view.open),nativeWire(opened));assert.deepEqual(wire(view.doctor),wire(doctor));
    assert.equal(view.unitId,unitId);assert.equal(view.contentRevision,speakingContentRevision(row,context));
    assert.equal(view.docsRevision,speakingDocsRevision(row));
    assert.equal(view.open.links.length,n===4?0:1);assert.equal(view.open.status,n===3?'submitted':'draft');
    if(n===1){assert.equal(view.open.practiceLinks[0].status,'accepted');assert.equal(view.open.practiceLinks[0].retryable,false);
     assert.equal(view.open.practiceLinks[1].status,'rejected');assert.equal(view.open.practiceLinks[1].retryable,true);}
    if(n===4)assert.equal(view.doctor.personalCount,2);
   }
  }
 }finally{await f.close();}
});

test('Speaking state data: Docs/job Docs chỉ đổi dấu Docs; nội dung cùng ID sửa vẫn được phát hiện',async()=>{
 const f=await fixture();try{
  const context=await f.source.context({assignmentCode:code});
  for(const schema of [independent,legacy]){
   const unitId=id((schema===independent?1000:2000)+3),read=async()=>(await f.data(schema).read({unitIds:[unitId],contentIds:[unitId]}))[0];
   const before=await read(),first=speakingObservationView(before,context);
   await f.db.query(`UPDATE ${schema}.doc_progress SET status='pending',sequence=3,applied_sequence=2 WHERE unit_id=$1`,[schema===independent?unitId:id(203)]);
   await f.db.query(`UPDATE ${schema}.${schema===independent?'job':'outbox'} SET status='processing' WHERE id=$1`,[id(schema===independent?704:702)]);
   const docs=await read(),next=speakingObservationView(docs,context);
   assert.equal(next.contentRevision,first.contentRevision);assert.notEqual(next.docsRevision,first.docsRevision);
   assert.equal(next.open.docsProgress.status,'pending');assert.equal(next.open.processing.write_doc.status,'processing');
   const linkTable=schema===independent?'link':'submission_link',linkId=id(schema===independent?3031:4031);
   await f.db.query(`UPDATE ${schema}.${linkTable} SET evidence=$2,question_count=4 WHERE id=$1`,[linkId,{confirmation:'Đã hoàn thành đủ bài fixture'}]);
   const changed=await read();assert.notEqual(changed.content_revision,docs.content_revision);
   assert.equal(speakingDocsRevision(changed),speakingDocsRevision(docs));
   const current=speakingObservationView(changed,context);assert.equal(current.open.links[0].id,first.open.links[0].id);
   assert.equal(current.open.links[0].question_count,4);
  }
 }finally{await f.close();}
});

test('Speaking state data: sửa revision cũ không thay bản hiện hành; gợi ý Doctor liên kết chỉ đổi đúng hồ sơ',async()=>{
 const f=await fixture();try{
  for(const schema of [independent,legacy]){
   const base=schema===independent?1000:2000,reader=f.data(schema),request={unitIds:[id(base+1),id(base+2)],contentIds:[id(base+1)]};
   const before=await reader.read(request);
   await f.db.query(`UPDATE ${schema}.${schema===independent?'link':'submission_link'} SET question_count=99,evidence=$2 WHERE id=$1`,
    [id(schema===independent?3011:4011),{old:'Không được đưa trở lại bản mới'}]);
   const after=await reader.read(request);assert.deepEqual(after.map(row=>row.content_revision),before.map(row=>row.content_revision));
   if(schema===independent){
    const docsBefore=(await reader.read({unitIds:[id(1004)]}))[0];
    await f.db.query('UPDATE speaking_independent.doctor_recommendation SET recommendation_count=recommendation_count+1 WHERE profile_id=$1 AND exercise_id=$2',[id(301),id(201)]);
    const docsAfter=(await reader.read({unitIds:[id(1004)]}))[0];assert.notEqual(docsAfter.content_revision,docsBefore.content_revision);
   }else await f.db.query('UPDATE speaking_homework.doctor_recommendation SET recommendation_count=recommendation_count+1 WHERE class_id=2304 AND student_ref=$1 AND exercise_id=$2',[id(1),id(201)]);
   const personal=await reader.read(request);assert.notEqual(personal[0].content_revision,after[0].content_revision);
   assert.equal(personal[1].content_revision,after[1].content_revision);
  }
 }finally{await f.close();}
});

test('Speaking state data: token/người/schema tách biệt, revoke và scope/course không được gắn chéo',async()=>{
 const f=await fixture();try{
  for(const schema of [independent,legacy]){
   const reader=f.data(schema),base=schema===independent?1000:2000;
   assert.deepEqual(await reader.read({sessions:[{hash:hash(token(1)),studentRef:id(2)}]}),[]);
   const [own]=await reader.read({sessions:[{hash:hash(token(1)),studentRef:id(1)}]});assert.equal(own.unit_id,id(base+1));
   assert.equal(own.schema,schema);
   await f.db.query(`UPDATE ${schema}.${schema===independent?'work_unit':'access_grant'} SET revoked_at=$2 WHERE id=$1`,
    [schema===independent?id(1001):id(201),'2026-11-02T00:00:00Z']);
   assert.deepEqual(await reader.read({sessions:[{hash:hash(token(1)),studentRef:id(1)}]}),[]);
  }
  assert.deepEqual(await f.data(legacy).read({classes:[{classId:'2304',code,courseId:'999'}]}),[]);
  const reader=f.data(independent);const [aliased]=await reader.read({sessions:[{hash:hash(token(4)),studentRef:id(1)}]});
  assert.equal(aliased.unit_id,id(1004));assert.equal(aliased.identity_ref,id(4));assert.equal(aliased.student_ref,id(1));
  assert.deepEqual(await reader.read({sessions:[{hash:hash(token(4)),studentRef:id(2)}]}),[]);
  const [canonical]=await reader.read({unitIds:[id(1004),id(1004).toUpperCase()],contentIds:[id(1004).toUpperCase()],
   sessions:[{hash:hash(token(4)),studentRef:id(4)},{hash:hash(token(4)),studentRef:id(4).toUpperCase()}]});
  assert.equal(canonical.unit_id,id(1004));assert.ok(canonical.content);
  assert.deepEqual(canonical.matched_sessions,[{hash:hash(token(4)),studentRef:id(4)}]);
 }finally{await f.close();}
});

test('Speaking state data: giữ điều kiện grant native và lịch sử GV; độc lập còn phải kiểm nguồn hiện hành',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE mapping.erp_class_membership_snapshot SET registration_status='on_hold' WHERE erp_student_contact_id=1");
  const [historic]=(await f.data(legacy).read({sessions:[{hash:hash(token(1)),studentRef:id(1)}]}));
  assert.equal(historic.local_grant_allowed,false);assert.equal(historic.unit_id,id(2001));
  await assert.rejects(f.legacy.open(identity(1)),{code:'ACCESS_DENIED'});
  const [localOnly]=await f.data(independent).read({sessions:[{hash:hash(token(1)),studentRef:id(1)}]});
  assert.equal(localOnly.local_grant_allowed,true);
  await assert.rejects(f.independent.open(identity(1)),{code:'STUDENT_NOT_ACTIVE'});
  const classes=await f.data(legacy).read({classes:[scope]});assert.ok(classes.some(row=>row.unit_id===id(2001)));
  await f.db.query("UPDATE mapping.erp_class_membership_snapshot SET registration_status='on_going' WHERE erp_student_contact_id=1");
  await f.db.query("UPDATE speaking_homework.assignment SET status='closed' WHERE id=$1",[id(101)]);
  const rows=await f.data(legacy).read({classes:[scope]});assert.equal(rows.find(row=>row.unit_id===id(2001)).local_grant_allowed,false);
  assert.equal(rows.find(row=>row.unit_id===id(2003)).local_grant_allowed,true);
  await assert.rejects(f.legacy.open(identity(1)),{code:'ACCESS_DENIED'});assert.equal((await f.legacy.open(identity(3))).status,'submitted');
  await f.db.query('DELETE FROM mapping.classroom_course_mapping WHERE erp_course_class_id=2304');
  const [missingMapping]=await f.data(legacy).read({unitIds:[id(2003)]});assert.equal(missingMapping.local_grant_allowed,false);
  await assert.rejects(f.legacy.open(identity(3)),{code:'ACCESS_DENIED'});
 }finally{await f.close();}
});

test('Speaking state data: cấp nội dung theo ID có yêu cầu; ổn định khi không đổi, lỗi SQL không thành dữ liệu rỗng',async()=>{
 const f=await fixture();try{
  const context=await f.source.context({assignmentCode:code}),reader=f.data(independent);
  const request={unitIds:[id(1002),id(1001)],contentIds:[id(1001)]},first=await reader.read(request);
  assert.equal(first.find(row=>row.unit_id===id(1002)).content,null);assert.ok(first.find(row=>row.unit_id===id(1001)).content);
  for(let tick=0;tick<3;tick++){
   const rows=await reader.read(request);assert.deepEqual(rows.map(row=>row.content_revision),first.map(row=>row.content_revision));
   assert.deepEqual(rows.map(speakingDocsRevision),first.map(speakingDocsRevision));
  }
  assert.throws(()=>speakingObservationView(first.find(row=>row.unit_id===id(1002)),context),{code:'SPEAKING_STATE_CONTENT_REQUIRED'});
  assert.throws(()=>speakingContentRevision(first[0],{}),{code:'SPEAKING_STATE_CONTEXT_INVALID'});
  const before=speakingContentRevision(first[0],context);
  assert.notEqual(speakingContentRevision(first[0],{exercises:[...context.exercises,{id:id(203),title:'Mới',exercise_url:'https://fixture.invalid/new'}]}),before);
  const broken=createSpeakingObservationData({schema:independent,pool:{query:async()=>{throw Error('STATE_SQL_UNAVAILABLE');}}});
  await assert.rejects(broken.read(request),/STATE_SQL_UNAVAILABLE/);
 }finally{await f.close();}
});

test('Speaking state data: đầu vào sai bị chặn trước SQL; role đọc không thể DDL hoặc ghi bài',async()=>{
 let calls=0;const pool={query(){calls++;throw Error('NO_SQL');}},reader=createSpeakingObservationData({pool,schema:independent});
 assert.throws(()=>createSpeakingObservationData({pool,schema:'speaking_independent;drop table x'}),/SPEAKING_STATE_SCHEMA_INVALID/);
 for(const input of [{unitIds:['legacy_'+id(1001)]},{sessions:[{hash:token(1),studentRef:id(1)}]},
  {sessions:[{hash:hash(token(1)),studentRef:id(1),accessToken:token(1)}]},
  {classes:[{classId:'2304 OR true',code}]},{classes:[{classId:'2304',code,courseId:'bad'}]},
  {classes:[{classId:'9223372036854775808',code}]},
  {contentIds:[null]},{extra:true},{unitIds:Array.from({length:1001},()=>id(1001))}])
  await assert.rejects(reader.read(input),{code:'SPEAKING_STATE_INPUT_INVALID'});
 assert.deepEqual(await reader.read({}),[]);assert.equal(calls,0);
 await assert.rejects(createSpeakingObservationData({pool,schema:legacy}).read({classes:[{classId:'2304',code}]}),{code:'SPEAKING_STATE_INPUT_INVALID'});
 const f=await fixture();try{if(f.nativeUrl){
  await assert.rejects(f.pool.query('CREATE TABLE speaking_independent.forbidden_state_fixture(id integer)'),{code:'42501'});
  await assert.rejects(f.pool.query("UPDATE speaking_independent.work_unit SET status='submitted' WHERE id=$1",[id(1001)]),{code:'42501'});
 }}finally{await f.close();}
});
