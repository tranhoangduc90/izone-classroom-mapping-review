import {createServer} from 'node:http';
import {fixture,code,hash} from './speaking-observation-fixture.mjs';
import {createApp} from '../src/app.js';
import {createIndependentApp,createIndependentSourceClient} from '../src/speaking-independent-server.js';
import {createSpeakingObservation} from '../src/speaking-observation.js';
export const secret='fixture-observation-worker-secret-at-least-32',origin='https://tranhoangduc90.github.io',cookie='observe_teacher='+'t'.repeat(43);
async function listen(app){const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,url:`http://127.0.0.1:${server.address().port}`};}

// Hai app HTTP thật, hai hub/kho và source/auth native trên dữ liệu tổng hợp.
// Owner chỉ seed/auth; metadata vẫn qua role reader SELECT-only của fixture.
export async function httpFixture({enabled=true,nativeOpen=false}={}){
 const f=await fixture();let parent,independent,observation;const authCalls=[];
 try{
  await f.db.exec(`CREATE TABLE mapping.reviewer_account(email text PRIMARY KEY,display_name text,role text,can_access_all_classes boolean,google_subject text,status text,last_login_at timestamptz,updated_at timestamptz);
   CREATE TABLE mapping.reviewer_session(token_hash bytea PRIMARY KEY,reviewer_email text,google_subject text,revoked_at timestamptz,idle_expires_at timestamptz,absolute_expires_at timestamptz,last_seen_at timestamptz);
   CREATE TABLE mapping.reviewer_class_access(reviewer_email text,erp_course_class_id bigint);
   CREATE TABLE mapping.reviewer_class_assignment(reviewer_email text,class_name text);
   CREATE TABLE speaking_homework.assignment_template(assignment_code text,page_path text,title text,parts jsonb,required_practice_count integer,doctor_course_key text,course_key text,active boolean);
   CREATE TABLE speaking_homework.class_scope(class_id bigint,class_code text,course_key text,active boolean);
   ALTER TABLE mapping.erp_class_membership_snapshot ADD COLUMN erp_student_name_snapshot text;
   INSERT INTO speaking_homework.class_scope VALUES(2304,'IC2304','67',true),(2305,'IC2305','67',true);
   INSERT INTO mapping.reviewer_account VALUES('teacher@fixture.test','Giảng viên giả','reviewer',false,'fixture-subject','active',NULL,NULL);
   INSERT INTO mapping.reviewer_class_access VALUES('teacher@fixture.test',2304);`);
  await f.db.query(`INSERT INTO mapping.reviewer_session VALUES($1,'teacher@fixture.test','fixture-subject',NULL,
   now()+interval '1 day',now()+interval '365 days','2026-01-01T00:00:00Z')`,[Buffer.from(hash('t'.repeat(43)),'hex')]);
  await f.db.query(`INSERT INTO speaking_homework.assignment_template VALUES($1,'lesson-4.html',$2,$3::jsonb,2,'67','67',true)`,[code,f.template.title,JSON.stringify(f.template.parts)]);
  if(f.nativeUrl)await f.db.exec('GRANT SELECT ON ALL TABLES IN SCHEMA mapping,speaking_homework TO speaking_state_reader,speaking_state_native');
  const authPool={async query(sql,params){authCalls.push(sql);const result=await f.db.query(sql,params);return{...result,rowCount:result.rowCount??result.rows.length};}};
  const config={authMode:'google',nodeEnv:'test',trustProxyHops:0,teacherSessionCookieName:'observe_teacher',allowedOrigins:new Set([origin]),
   speakingHomeworkEnabled:true,speakingHomeworkWorkerSecret:secret,speakingHomeworkAccessSecret:secret};
  const parentApp=createApp({config,pool:authPool,speakingHomeworkPool:nativeOpen?f.independent.pool:f.pool,speakingObservationEnabled:enabled,
   verifyGoogleToken:async()=>({email:'teacher@fixture.test',sub:'fixture-subject',email_verified:true})});
  parent=await listen(parentApp);
  const source=createIndependentSourceClient({base:parent.url+'/api/speaking-homework',secret});
  observation=enabled?createSpeakingObservation({schema:'speaking_independent',data:f.data('speaking_independent'),source,
   observeTeachers:actors=>source.observeTeachers(actors)}):null;
  independent=await listen(createIndependentApp({service:f.independent,observation,
   teacherAdmission:(input,headers)=>source.teacherAdmission([input.classId],headers)}));
  const close=async()=>{await observation?.close();await parentApp.locals.speakingObservation?.close();
   for(const item of [independent,parent])if(item){item.server.closeAllConnections();await new Promise(resolve=>item.server.close(resolve));}await f.close();};
  return{...f,parent:parent.url+'/api/speaking-homework',independent:independent.url+'/api/speaking-homework-independent',
   observation,parentObservation:parentApp.locals.speakingObservation,authCalls,close};
 }catch(error){await observation?.close();for(const item of [independent,parent])if(item){item.server.closeAllConnections();await new Promise(resolve=>item.server.close(resolve));}await f.close();throw error;}
}

export async function post(url,body){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{response,data:await response.json()};}
export async function stream(url,{body,headers={}}={}){
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);
 const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'content-type':'application/json',...headers}:headers,
  ...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
 if(!response.ok){clearTimeout(deadline);return{response,data:await response.json(),close:()=>controller.abort()};}
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 return{response,async event(){while(true){
  const end=buffer.indexOf('\n\n');if(end>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
   const event=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(event&&data)return{event,value:JSON.parse(data)};continue;}
  const result=await reader.read();if(result.done)throw Error('OBSERVATION_STREAM_CLOSED');buffer+=decoder.decode(result.value,{stream:true});
 }},close(){clearTimeout(deadline);controller.abort();}};
}
