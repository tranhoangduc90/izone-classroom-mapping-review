import test from 'node:test';
import assert from 'node:assert/strict';
import {httpFixture,post,cookie,origin} from './speaking-observation-http-fixture.mjs';
import {id,token,code} from './speaking-observation-fixture.mjs';
const identity={accessToken:token(1),studentRef:id(1)};

test('Speaking Docs metadata: both student stores carry only the small native Docs state when content stays unchanged',async()=>{
 const f=await httpFixture();try{
  for(const [base,schema,unit] of [[f.independent,'speaking_independent',id(1001)],[f.parent,'speaking_homework',id(201)]]){
   const first=(await post(base+'/observation/student/status',identity)).data.state;
   if(schema==='speaking_independent')await f.db.query(`INSERT INTO ${schema}.doc_progress VALUES($1,'pending',NULL,1,0,NULL)`,[unit]);
   await f.db.query(`UPDATE ${schema}.doc_progress SET status='verified',applied_sequence=sequence,verified_at=now() WHERE unit_id=$1`,[unit]);
   const {response,data}=await post(base+'/observation/student/status',identity),next=data.state;assert.equal(response.status,200);
   assert.equal(next.contentRevision,first.contentRevision);assert.notEqual(next.docsRevision,first.docsRevision);
   assert.equal(next.docsProgress.status,'verified');assert.equal(String(next.docsProgress.sequence),String(next.docsProgress.applied_sequence));
   assert.ok(Array.isArray(next.docsJobs));assert.ok(next.docsJobs.every(job=>job.kind==='write_doc'));
   for(const key of ['open','doctor','links','practiceLinks','body','accessToken','matched_sessions'])assert.equal(Object.hasOwn(next,key),false);
  }
 }finally{await f.close();}
});

test('Speaking Docs metadata: teacher content revisions stay stable while selected-unit Docs metadata changes',async()=>{
 const f=await httpFixture();try{
  for(const [base,schema,unit,work] of [[f.independent,'speaking_independent',id(1001),id(1001)],[f.parent,'speaking_homework',id(201),id(2001)]]){
   const url=base+'/teacher/progress/state?'+new URLSearchParams({classId:'2304',classCode:'IC2304',code,unitId:work});
   const firstResponse=await fetch(url,{headers:{cookie,origin}});assert.equal(firstResponse.status,200);const first=(await firstResponse.json()).state;
   if(schema==='speaking_independent')await f.db.query(`INSERT INTO ${schema}.doc_progress VALUES($1,'pending',NULL,1,0,NULL)`,[unit]);
   await f.db.query(`UPDATE ${schema}.doc_progress SET status='verified',applied_sequence=sequence,verified_at=now() WHERE unit_id=$1`,[unit]);
   const response=await fetch(url,{headers:{cookie,origin}});assert.equal(response.status,200);const next=(await response.json()).state;
   assert.equal(next.classRevision,first.classRevision);assert.match(next.unitContentRevision,/^[a-f0-9]{64}$/);
   assert.equal(next.unitContentRevision,first.unitContentRevision);assert.notEqual(next.unitDocsRevision,first.unitDocsRevision);
   assert.notEqual(next.unitRevision,first.unitRevision);assert.equal(next.unitDocs.docsProgress.status,'verified');
   assert.ok(next.unitDocs.docsJobs.every(job=>job.kind==='write_doc'));assert.equal(Object.hasOwn(next.unitDocs,'links'),false);
  }
 }finally{await f.close();}
});

test('Speaking native open advertises student tracking only when its own runtime flag is enabled',async()=>{
 for(const enabled of [false,true]){
  const f=await httpFixture({enabled,nativeOpen:true});try{
   for(const base of [f.parent,f.independent]){
    const {response,data}=await post(base+'/open',identity);assert.equal(response.status,200);assert.ok(Array.isArray(data.links));
    assert.equal(data.capabilities?.studentStateStream===true,enabled);assert.equal(data.capabilities?.studentCombinedView===true,enabled);
   }
  }finally{await f.close();}
 }
});
