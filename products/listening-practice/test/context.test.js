import test from 'node:test';
import assert from 'node:assert/strict';
import {createContext} from '../src/context.js';
import {hash,uuid} from '../src/domain.js';
import {createContextSnapshot} from '../src/context-contract.js';

test('nguồn quyền chỉ đọc: active/approved, đúng lớp, Google subject; cũ hoặc sửa payload bị chặn',async()=>{
 let now=Date.now(),id=uuid(),calls=0;
 const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'TEST'}],students:[{public_id:id,erp_course_class_id:'1124',erp_student_contact_id:'1',erp_student_name_snapshot:'Fixture',status:'approved'}],memberships:[{erp_course_class_id:'1124',erp_student_contact_id:'1',source_state:'active'}],accounts:[{email:'teacher@example.test',status:'active',role:'teacher',google_subject:'subject',can_access_all_classes:false}],access:[{reviewer_email:'teacher@example.test',erp_course_class_id:'1124'}]};
 payload.memberships[0].erp_student_name_snapshot='Fixture';payload.accounts[0].display_name='Teacher';
 let value=createContextSnapshot(payload,now);
 const context=createContext({url:'https://source.test',key:'x'.repeat(43),clock:()=>now,fetcher:async(url,options)=>{calls++;assert.equal(options.headers['x-k67-context-key'],'x'.repeat(43));assert.equal(options.method,undefined);return new Response(JSON.stringify(value));}});
 assert.equal((await context.student('1124',id)).name,'Fixture');assert.equal(await context.student('999',id),undefined);
 assert.equal(await context.teacher('1124','teacher@example.test','subject'),true);assert.equal(await context.teacher('1124','teacher@example.test','other'),false);
 assert.equal(calls,1);now+=121000;await assert.rejects(context.roster('1124'),e=>e.code==='CONTEXT_INVALID');
 value.capturedAt=new Date(now).toISOString();value.students[0].status='rejected';await assert.rejects(context.roster('1124'),e=>e.code==='CONTEXT_INVALID');
});
