// Chỉ loopback, dữ liệu giả. Nhận xét đi qua router/service/SQL thật; bài/Test dùng fixture UI.
import {readFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import {setupDatabase,poolFrom} from './journey-comment-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningRouter} from '../src/learning-routes.js';
import {createProgressLinkCipher} from '../src/learning-journey-comments.js';

export async function startThe24Fixture({port=0,pages=process.env.PAGES_SOURCE_ROOT}={}){
  if(!pages)throw Error('Cần PAGES_SOURCE_ROOT là worktree Pages đang sửa.');
  const {startThe22Server,uid,A,B}=await import(pathToFileURL(resolve(pages,'tests/fixtures/progress-the22-23-server.mjs')));
  const old=await startThe22Server();
  const {database}=await setupDatabase();
  for(const name of ['202610070001_student_journey_comments','202610220001_assignment_management','202611020001_teacher_comment_drafts'])
    await database.exec(await readFile(new URL('../ops/learning-migrations/'+name+'.sql',import.meta.url),'utf8'));
  await database.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'IC_TEST24');
    INSERT INTO mapping.reviewer_class_access VALUES('teacher@example.test',1294);
    INSERT INTO mapping.reviewer_class_access VALUES('second@example.test',1294);
    INSERT INTO mapping.reviewer_account VALUES('second@example.test','active');
    INSERT INTO learning.class_journey_plan(erp_course_class_id,total_sessions,revision,confirmed_by_email) VALUES(1294,12,1,'teacher@example.test');`);
  for(const [i,ref]of [A,B].entries())await database.query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES($1,1294,$2,$3)`,[ref,99001+i,'Học viên giả '+(i?'B':'A')]);
  const pool=poolFrom(database),keys={v1:Buffer.alloc(32,17).toString('base64')};
  const reviewer={email:'teacher@example.test',displayName:'Giảng viên thử',canAccessAllClasses:false};
  const service=createLearningService({pool,journeyCommentsEnabled:true,progressLinkCipher:createProgressLinkCipher({keys})});
  await service.saveSessionComment({classId:'1294',studentRef:A,sessionNumber:3,reviewer,noteText:'Nhận xét đã gửi trước khi sửa.\n'+old.longComment,expectedRevision:0,operationId:crypto.randomUUID()});
  const api=express();api.use(express.json());api.use('/api/learning',createLearningRouter({pool,journeyCommentsEnabled:true,progressLinkKeys:keys,authenticate:(req,_res,next)=>{req.reviewer=reviewer;next();}}));
  api.use((error,_req,res,_next)=>res.status(error.httpStatus||500).json({ok:false,error:error.code,message:error.message}));
  const apiServer=await new Promise(done=>{const s=api.listen(0,'127.0.0.1',()=>done(s));});
  const apiOrigin='http://127.0.0.1:'+apiServer.address().port;
  const testResult={testSlug:'term-test-1',title:'Term Test 1',completedAt:'2026-10-29T12:00:00Z',resultRef:'a'.repeat(64),
    listening:{correct:7,total:10,completedAt:'2026-10-29T12:00:00Z',analysis:{status:'available',needsImprovement:[{label:'Multiple choice'}]}},
    reading:{correct:8,total:10,completedAt:'2026-10-29T12:00:00Z',analysis:{status:'available',needsImprovement:[{label:'Matching headings'}]}},
    writing:{status:'ready',score:6,tasks:{1:{score:5.5,status:'ready'},2:{score:6.5,status:'ready'}}}};
  const person=ref=>({studentRef:ref,name:'Học viên giả '+(ref===B?'B':'A')});
  const comments=ref=>service.readComments('1294',ref,{visibleOnly:true});
  const dates=n=>new Date(Date.UTC(2026,10,n-4)).toISOString().slice(0,10);
  let lesson6Complete=false;
  async function journey(ref){
    const notes=await comments(ref);return {class:{classId:'1294',name:'IC_TEST24'},student:person(ref),
      summary:{totalSessions:12,submittedComplete:5,attendedSessions:5,availableReports:0},reports:[],externalTests:[testResult],
      coverage:{schedule:'teacher_confirmed',plannedSessions:12,testResults:'connected',portalTests:'connected'},sessions:Array.from({length:12},(_,i)=>{
        const n=i+1;return {sessionNumber:n,sessionDate:dates(n),assignmentId:n<=6?uid(100+n):null,publicToken:n<=6?uid(100+n):null,
          assignmentStatus:'published',sessionKind:'lesson',title:n===6?'Listening 2 + Speaking 5':n===1?'Listening 1 + Reading 1':'Reading 3 + Writing 1',
          completeness:n<6||n===6&&lesson6Complete?'complete':null,submissionWindow:{canSubmit:n===6},sessionComment:notes.find(note=>note.sessionNumber===n)||null};})};
  }
  const server=await startThe22Server({port,studentMemory:true,extraApi:async({path,url,body,method,send,res})=>{
    if(path.startsWith('/teacher/session-comments')){
      const response=await fetch(apiOrigin+'/api/learning'+path+url.search,{method,headers:{'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});
      res.setHeader('cache-control','no-store');send(await response.json(),response.status);return true;
    }
    if(['/teacher/dashboard','/teacher/live-drafts','/teacher/classes/1294/overview'].includes(path)){
      const data=await(await fetch(old.origin+url.pathname+url.search)).json();
      const root=data.dashboard||data.live||data.overview;
      for(const s of root.students){const notes=await service.readComments('1294',s.studentRef);if(s.cells)for(const cell of s.cells)cell.sessionComment=notes.find(note=>note.sessionNumber===cell.sessionNumber)||null;
        else s.sessionComment=notes.find(note=>note.sessionNumber===(root.sessionNumber||3))||null;}
      if(data.overview){data.overview.scheduleStatus='needs_review';for(const s of root.students)s.externalTests=[{...testResult,testSlug:'mini-test',title:'Mini Test',writing:{score:9}},testResult,{...testResult,testSlug:'term-test-2',title:'Term Test 2',writing:{score:7,tasks:{1:{score:7,status:'ready'}}}}];}
      send(data);return true;
    }
    if(path==='/student/course-journey'||path==='/student/session-comments'||path==='/student/course-session-detail'){
      let ref=body.studentRef;
      if(body.accessToken){const identity=await service.studentCommentIdentity({accessToken:body.accessToken});ref=identity.student_ref;}
      if(![A,B].includes(ref)){send({ok:false,message:'Sai người trong fixture'},403);return true;}
      if(path==='/student/course-journey')send({ok:true,journey:await journey(ref)});
      else if(path==='/student/session-comments')send({ok:true,classId:'1294',studentRef:ref,comments:await comments(ref)});
      else{
        const data=await(await fetch(old.origin+'/api/learning/teacher/dashboard?assignment='+uid(103))).json();
        send({ok:true,detail:{classId:'1294',student:person(ref),sessionNumber:body.sessionNumber,sessionDate:dates(body.sessionNumber),status:'complete',submissionId:uid(300+body.sessionNumber),definition:data.dashboard.definition,responses:{[uid(22)]:{correct:7,total:10},[uid(24)]:['vocab']},sessionComment:(await comments(ref)).find(n=>n.sessionNumber===body.sessionNumber)||null}});
      }return true;
    }
    if(path==='/assignments/open'){
      const data=await(await fetch(old.origin+'/api/learning/teacher/dashboard?assignment='+uid(103))).json();
      send({ok:true,assignment:{assignmentId:body.publicToken,class:{id:'1294',name:'IC_TEST24'},courseCode:'56',sessionNumber:Number(body.publicToken.slice(-3))-100,title:'Listening 2 + Speaking 5',definitionHash:'d'.repeat(64),definition:data.dashboard.definition,roster:[person(A),person(B)],submissionWindow:{canSubmit:false,reason:'closed'},blockReleases:[]}});return true;
    }
    if(path==='/student/portal-classes'){send({ok:true,classes:[{classId:'1294',name:'IC_TEST24'}]});return true;}
    if(path==='/student/portal-context'){send({ok:true,class:{classId:'1294',name:'IC_TEST24'},students:[A,B].map(ref=>({...person(ref),publicToken:uid(103)}))});return true;}
    if(url.pathname==='/api/student-identity/resolve'){
      const ref=body.studentRef||([A,B].find((_,i)=>String(99001+i)===body.identity?.id))||A;
      send({ok:true,status:'unique',identity:{authority:'erp-contact',id:ref===A?'99001':'99002'},aliases:[{classId:'1294',classCode:'IC_TEST24',studentRef:ref,studentName:person(ref).name}]});return true;
    }
    return false;
  }});
  return {...server,database,service,reviewer,A,B,uid,setLesson6Complete(value){lesson6Complete=value;},
    async close(){await server.close();await old.close();apiServer.closeAllConnections();await new Promise(done=>apiServer.close(done));await database.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const fixture=await startThe24Fixture({port:Number(process.env.PORT||18624)});process.stdout.write(JSON.stringify({origin:fixture.origin,studentRef:fixture.A,assignment:fixture.uid(103)})+'\n');
}
