// Đọc điểm Mini Test khóa 56 từ meta đăng ký lớp, nối bằng mã ERP, không nối tên.
// Giữ snapshot có ngày đọc khi ERP tạm lỗi; không đổi điểm trống thành 0 hoặc suy ngày thi.
import {createHash} from 'node:crypto';
import {stableStringify} from './learning-domain.js';
const sha=value=>createHash('sha256').update(stableStringify(value)).digest('hex');
const uuid=/^[0-9a-f-]{36}$/iu;
export function parsePortalMiniRows(rows,capturedAt){
 if(!Array.isArray(rows)||rows.length>500||!Number.isFinite(Date.parse(capturedAt)))throw Error('PORTAL_MINI_RESPONSE_INVALID');
 const seen=new Set();return rows.map(row=>{
  const studentId=String(row.student_contact_id);
  if(!/^\d{1,18}$/u.test(studentId)||seen.has(studentId))throw Error('PORTAL_MINI_IDENTITY_AMBIGUOUS');seen.add(studentId);
  let value=row.mini_test;if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw Error('PORTAL_MINI_RESULT_INVALID');}}
  if(value==null)return {studentId,result:null};
  if(typeof value!=='object'||Array.isArray(value))throw Error('PORTAL_MINI_RESULT_INVALID');
  const section=(name,total)=>{if(value[name]===null||value[name]===undefined||value[name]==='')return null;
   const correct=Number(value[name]);if(!Number.isInteger(correct)||correct<0||correct>total)throw Error('PORTAL_MINI_SCORE_INVALID');return {correct,total,band:null};};
  const listening=section('listening_grade',10),reading=section('reading_grade',13);
  return {studentId,result:!listening&&!reading?null:{testSlug:'mini-test-erp-56',title:'Mini Test',completedAt:null,
    listening,reading,writing:null,source:'erp_56_mini_test',observedAt:capturedAt,examDateKnown:false}};
 });
}
export function createLearningPortalTestReader({pool,fetchImpl=fetch,now=()=>Date.now(),
 url=process.env.LEARNING_ERP_SCHEDULE_METABASE_URL,username=process.env.LEARNING_ERP_SCHEDULE_METABASE_USERNAME,
 password=process.env.LEARNING_ERP_SCHEDULE_METABASE_PASSWORD,enabledClasses=['1294']}={}){
 if(!pool||!url||!username||!password)return null;
 const base=new URL(url);if(base.protocol!=='https:')throw Error('PORTAL_TEST_HTTPS_REQUIRED');
 const cache=new Map(),pending=new Map(),allowed=new Set(enabledClasses.map(String));
 async function post(path,body,token,signal){const r=await fetchImpl(new URL(path,base),{method:'POST',headers:{'content-type':'application/json',...(token?{'x-metabase-session':token}:{})},body:JSON.stringify(body),signal});if(!r.ok)throw Error('PORTAL_TEST_UPSTREAM_FAILED');return r.json();}
 async function read(classId){
  const cached=cache.get(classId);if(cached&&now()-cached.checkedAt<300000)return cached;
  if(pending.has(classId))return pending.get(classId);
  const run=(async()=>{
   const prior=(await pool.query('SELECT payload,captured_at,source_hash FROM learning.external_class_test_snapshot WHERE class_id=$1::bigint',[classId])).rows[0];
   let snapshot=prior?{rows:prior.payload,capturedAt:new Date(prior.captured_at).toISOString()}:null;
   if(prior&&sha(prior.payload)!==prior.source_hash)throw Error('PORTAL_TEST_SNAPSHOT_INVALID');
   if(snapshot&&now()-Date.parse(snapshot.capturedAt)<300000){const value={...snapshot,coverage:'snapshot',checkedAt:now()};cache.set(classId,value);return value;}
   try{
    const signal=AbortSignal.timeout(3000),session=await post('/api/session',{username,password},null,signal);
    if(!session.id)throw Error('PORTAL_TEST_LOGIN_FAILED');
    const sql=`SELECT r.id AS registration_id,oi.customer_id AS student_contact_id,
      JSON_EXTRACT(r.meta,'$."56_mini_test"') AS mini_test
      FROM class_registrations r JOIN order_items oi ON oi.id=r.order_item_id
      JOIN course_classes cl ON cl.id=r.course_class_id JOIN courses co ON co.id=cl.course_id
      WHERE r.course_class_id=${classId} AND r.status='on_going' AND co.short_name='56'
      ORDER BY oi.customer_id,r.id LIMIT 501`;
    const response=await post('/api/dataset',{database:2,type:'native',native:{query:sql}},session.id,signal);
    const names=response.data?.cols?.map(c=>c.name);if(JSON.stringify(names)!==JSON.stringify(['registration_id','student_contact_id','mini_test'])||!Array.isArray(response.data?.rows))throw Error('PORTAL_TEST_COLUMNS_CHANGED');
    const rows=response.data.rows.map(values=>Object.fromEntries(names.map((name,i)=>[name,values[i]]))),capturedAt=new Date(now()).toISOString();
    parsePortalMiniRows(rows,capturedAt);
    await pool.query(`INSERT INTO learning.external_class_test_snapshot(class_id,source,payload,source_hash,captured_at)
      VALUES($1::bigint,'erp_56_mini_test',$2::jsonb,$3,$4::timestamptz) ON CONFLICT(class_id) DO UPDATE SET payload=EXCLUDED.payload,source_hash=EXCLUDED.source_hash,captured_at=EXCLUDED.captured_at`,[classId,JSON.stringify(rows),sha(rows),capturedAt]);
    snapshot={rows,capturedAt};const value={...snapshot,coverage:'connected',checkedAt:now()};cache.set(classId,value);return value;
   }catch(error){if(!snapshot)throw error;const value={...snapshot,coverage:'stale_snapshot',checkedAt:now()};cache.set(classId,value);return value;}
  })().finally(()=>pending.delete(classId));pending.set(classId,run);return run;
 }
 return async({classId,studentRefs})=>{
  classId=String(classId);if(!/^\d{1,18}$/u.test(classId)||!Array.isArray(studentRefs)||studentRefs.length>500||new Set(studentRefs).size!==studentRefs.length||studentRefs.some(ref=>!uuid.test(ref)))throw Error('PORTAL_TEST_INPUT_INVALID');
  if(!allowed.has(classId))return {coverage:'not_connected',results:[]};
  const snapshot=await read(classId),rows=parsePortalMiniRows(snapshot.rows,snapshot.capturedAt),source=new Map(rows.map(r=>[r.studentId,r.result]));
  const identities=(await pool.query(`SELECT public_id::text AS student_ref,erp_student_contact_id::text AS student_id FROM mapping.student_mapping_review
    WHERE erp_course_class_id=$1::bigint AND public_id=ANY($2::uuid[]) AND status<>'superseded'`,[classId,studentRefs])).rows;
  const seen=new Set(),contacts=new Set(),results=[];
  for(const id of identities){if(seen.has(id.student_ref)||contacts.has(id.student_id))throw Error('PORTAL_TEST_IDENTITY_AMBIGUOUS');seen.add(id.student_ref);contacts.add(id.student_id);
   const result=source.get(id.student_id);if(result)results.push({studentRef:id.student_ref,result:{...result,sourceCoverage:snapshot.coverage}});}
  return {coverage:snapshot.coverage,results,capturedAt:snapshot.capturedAt};
 };
}
