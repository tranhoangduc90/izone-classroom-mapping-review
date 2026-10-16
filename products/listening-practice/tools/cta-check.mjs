import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createListeningService} from '../src/service.js';
import {createCtaRegistrar} from '../src/cta-registration.js';
import {createDocsWorker,CTA} from '../src/docs.js';
import {CODE,uuid,secret} from '../src/domain.js';

// Chỉ PostgreSQL canary mới; dữ liệu giả, không gọi Google và không ghi bài học viên.
const pool=new pg.Pool({connectionString:process.env.LISTENING_NATIVE_CHECK_DATABASE_URL,max:6});
try{
 const database=(await pool.query('SELECT current_database() AS db')).rows[0].db;
 assert.match(database,/^listening_practice_canary_review_cta_/);
 await pool.query(await readFile(new URL('../db/001-schema.sql',import.meta.url),'utf8'));
 const content=JSON.parse(await readFile('/private/content.json','utf8')),studentRef=uuid();
 const context={student:async(c,s)=>c==='1124'&&s===studentRef?{studentRef,name:'Học viên canary'}:undefined,
 snapshot:async()=>({classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'CANARY'}]})};
 const service=createListeningService({pool,context,pageBase:'https://example.test/listening/',verifyBinding:async i=>({fixtureOnly:true,documentId:i.documentId,studentRef:i.studentRef})});await service.seedContent(content);
 const event={doc_id:'canary_document_'+uuid(),classroom_course_id:'123',coursework_id:'456',submission_id:'canary',student_id:'789',class_name:'CANARY'};
 let index=1,writes=0;
 const p=text=>{const start=index;index+=text.length+1;return{paragraph:{elements:[{startIndex:start,endIndex:index,textRun:{content:text+'\n',textStyle:{}}}]}};};
 const document={documentId:event.doc_id,revisionId:'canary-revision',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[p('Reading unchanged'),p('Speaking unchanged'),p(CTA),p(CODE)]}}}]};
 const docs={read:async()=>structuredClone(document),write:async(id,plan)=>{assert.equal(id,event.doc_id);writes++;for(const req of plan.requests)document.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.textStyle=req.updateTextStyle.textStyle;}};
 const worker=createDocsWorker({pool,docs});
 const register=createCtaRegistrar({pool,service,context,docs,resolveOwner:async()=>({classId:'1124',studentRef}),entryKey:secret(),contentVersion:content.version,sleep:async()=>worker.once()});
 const first=await register(event),again=await Promise.all([register(event),register(event)]);
 assert.ok(again.every(r=>r.bindingId===first.bindingId&&r.status==='verified'));assert.equal(writes,1);
 const counts=(await pool.query("SELECT (SELECT count(*)::int FROM listening_practice.binding) AS bindings,(SELECT count(*)::int FROM listening_practice.doc_job) AS jobs,(SELECT count(*)::int FROM listening_practice.work) AS works")).rows[0];
 assert.deepEqual(counts,{bindings:1,jobs:1,works:0});
 console.log(JSON.stringify({status:'passed',database,counts,writes,checks:['register','readback','concurrent-repeat','stable-binding-and-job','no-student-work']}));
}finally{await pool.end();}
