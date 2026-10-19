import {localPool} from '../tools/local-pool.mjs';
import {createReadingService} from '../src/service.js';
import {CODE,secret,uuid,emptyDraft} from '../src/domain.js';

// Tên và nội dung trong test đều là dữ liệu giả; kiểm nghiệp vụ bằng SQL thật, không giả lập chấm.
export function fixtureContent(){
 const key=Object.fromEntries(Array.from({length:13},(_,i)=>[i+14,[i<7?'i':i<10?'A':'word']]));
 return{code:CODE,version:'fixture-v1',totalMs:1200000,key,explanations:{entries:Object.fromEntries(Object.keys(key).map(n=>[n,{number:+n}]))},
  definition:{passage:Object.fromEntries('ABCDEFG'.split('').map(n=>[n,`Paragraph ${n} test text.`])),headings:Array.from({length:8},(_,i)=>[String(i),'Fixture heading']),mcq:[21,22,23].map(n=>({n,text:'Fixture question',options:['A','B','C','D']})),summary:[{question:24},{question:25},{question:26}]}};
}
export async function fixture(content=fixtureContent(),{poolFactory=localPool}={}){
 const pool=await poolFactory();let now=Date.now(),eligible=true,teacherAllowed=true;
 const studentRef=uuid(),entryToken=secret(),documentId='fixture_document_1234567890';
 const member={studentRef,name:'Học viên kiểm thử'},context={student:async(c,id)=>eligible&&c==='1124'&&id===studentRef?member:undefined,roster:async()=>eligible?[member]:[],teacher:async(c,email,subject)=>teacherAllowed&&c==='1124'&&email==='teacher@example.test'&&subject==='google-fixture'};
 const service=createReadingService({pool,context,clock:()=>now,pageBase:'https://example.test/reading-practice/',verifyBinding:async input=>({fixtureOnly:true,documentId:input.documentId,studentRef:input.studentRef})});
 await service.seedContent(content);
 const registration={classId:'1124',classCode:'FIXTURE 67',studentRef,documentId,tabId:'t.0',code:content.code,contentVersion:content.version,entryToken};
 const registered=await service.register(registration);
 await pool.query("UPDATE reading_practice.assignment SET status='open'");await pool.query('UPDATE reading_practice.binding SET cta_verified_at=now()');
 const logged=await service.login({entryToken,studentRef,classCode:'FIXTURE 67'}),token=logged.token;
 return{pool,service,content,context,registration,registered,studentRef,token,entryToken,clock:()=>now,advance:ms=>now+=ms,setEligible:v=>eligible=v,setTeacher:v=>teacherAllowed=v,
  begin:async()=>{const response=await service.begin({token,owner:'device1',operationId:uuid()});await service.activate({token,attemptId:response.attempts.at(-1).id,lease:response.lease});return{...await service.read({token}),lease:response.lease,definition:response.definition};},draft:()=>emptyDraft(content.code),close:()=>pool.end()};
}
