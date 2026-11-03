import {createHash} from 'node:crypto';
import {z} from 'zod';
import {buildTeacherClassAccessPredicate} from './teacher-class-access-sql.js';
import {createTestObservationHub,openTestObservationStream} from './test-state-runtime.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,code)=>{throw Object.assign(Error(code),{status,code});};


// Chứng cứ do middleware K56 đã xác thực, không nhận từ query/body của trình duyệt.
// Bearer giữ hợp đồng native queryTeacherSessionScope: tài khoản hiện hành sau
// khi middleware đã kiểm Google; cookie phải khớp subject, thời hạn và thu hồi.
export function k56TeacherAuthorization(req){
 const canAccessAllClasses=Boolean(req.reviewer?.canAccessAllClasses);
 if(req.authSource==='legacy'&&req.reviewer?.email==='legacy@mapping.local')return{source:'legacy',canAccessAllClasses};
 if(req.authSource==='session'&&typeof req.teacherSessionToken==='string'&&/^[A-Za-z0-9_-]{43}$/.test(req.teacherSessionToken))
  return{source:'session',tokenHash:createHash('sha256').update(req.teacherSessionToken).digest('hex'),canAccessAllClasses};
 if(req.authSource==='google_bearer')return{source:'google_bearer',canAccessAllClasses};
 return{source:'none',canAccessAllClasses:false};
}
function teacherIdentitySql(email,proof){
 return `((${proof}->>'source'='legacy' AND ${email}='legacy@mapping.local') OR EXISTS(
  SELECT 1 FROM mapping.reviewer_account current_account WHERE current_account.email=${email} AND current_account.status='active'
   AND (${proof}->>'source'='google_bearer' OR (${proof}->>'source'='session' AND EXISTS(
    SELECT 1 FROM mapping.reviewer_session current_session WHERE current_session.token_hash=decode(${proof}->>'tokenHash','hex')
     AND current_session.reviewer_email=current_account.email AND current_session.google_subject=current_account.google_subject
     AND current_session.revoked_at IS NULL AND current_session.idle_expires_at>now() AND current_session.absolute_expires_at>now())))))`;
}
function teacherCanReadClass(email,proof,classId){
 const assigned=buildTeacherClassAccessPredicate({reviewerEmailSql:email,classIdSql:classId});
 return `(${teacherIdentitySql(email,proof)} AND (
  (${proof}->>'source'='legacy' AND ${email}='legacy@mapping.local') OR EXISTS(
   SELECT 1 FROM mapping.reviewer_account current_account WHERE current_account.email=${email} AND current_account.status='active'
    AND (((current_account.role='admin' OR current_account.can_access_all_classes)
      AND coalesce((${proof}->>'canAccessAllClasses')::boolean,false)) OR ${assigned}))))`;
}

// Đọc phiên/quyền và dấu thay đổi trong cùng snapshot. Không trả đáp án, bài viết,
// token hoặc ID nội bộ. Các lớp trùng được gom trước khi đọc metadata nghiệp vụ.
// xmin/ctid chỉ là dấu thay đổi nội bộ, không dùng làm định danh hoặc quyền truy cập.
const rowVersion=alias=>`jsonb_build_array(${alias}.tableoid::text,${alias}.ctid::text,${alias}.xmin::text)::text`;
const sources=[
 ['definition','assessment.test_definition','d',"d.slug=s.test_slug",rowVersion('d')],
 ['class','mapping.classroom_course_mapping','c','c.erp_course_class_id=s.class_id',rowVersion('c')],
 ['review','mapping.student_mapping_review','r',"r.erp_course_class_id=s.class_id AND r.status<>'superseded'",rowVersion('r')],
 ['roster','assessment.term_test_roster','r','r.erp_course_class_id=s.class_id AND r.test_slug=s.test_slug',rowVersion('r')],
 ['temporary','assessment.term_test_temporary_student','t','t.erp_course_class_id=s.class_id AND t.test_slug=s.test_slug AND t.active',rowVersion('t')],
 ['attempt','assessment.term_test_attempt','a','a.erp_course_class_id=s.class_id AND a.test_slug=s.test_slug',
  `CASE WHEN s.student_ref IS NULL THEN jsonb_build_array(a.id,a.definition_version,a.created_at,a.completed_at,a.combined_result,
    a.writing_submitted_at,a.superseded_at)::text ELSE ${rowVersion('a')} END`],
 ['legacy','assessment.mini_test_result','m','m.erp_course_class_id=s.class_id AND m.test_slug=s.test_slug',rowVersion('m')],
 ['run','assessment.term_test_writing_grading_run','g',`EXISTS(SELECT 1 FROM assessment.term_test_attempt a
    WHERE a.id=g.attempt_id AND a.erp_course_class_id=s.class_id AND a.test_slug=s.test_slug)`,rowVersion('g')],
 ['final','assessment.term_test_writing_grading_final','g',`EXISTS(SELECT 1 FROM assessment.term_test_attempt a
    WHERE a.id=g.attempt_id AND a.erp_course_class_id=s.class_id AND a.test_slug=s.test_slug)`,rowVersion('g')]
];

export const k56TeacherObservationBatchSql=`WITH watched AS MATERIALIZED (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS w(key text,scope_key text,class_name text,test_slug text,student_ref uuid,email text,auth_proof jsonb)
), authorized AS MATERIALIZED (
 SELECT w.*,
  true AS context_fresh,
  ${teacherIdentitySql('w.email','w.auth_proof')} AS login_valid,
  (SELECT count(*)::int FROM mapping.classroom_course_mapping c
   WHERE upper(trim(c.erp_class_name_snapshot))=w.class_name) AS class_count,
  (SELECT count(*)::int FROM mapping.classroom_course_mapping c
   WHERE upper(trim(c.erp_class_name_snapshot))=w.class_name AND ${teacherCanReadClass('w.email','w.auth_proof','c.erp_course_class_id')}) AS allowed_count,
  (SELECT c.erp_course_class_id FROM mapping.classroom_course_mapping c
   WHERE upper(trim(c.erp_class_name_snapshot))=w.class_name LIMIT 1) AS class_id,
  (SELECT d.version FROM assessment.test_definition d WHERE d.slug=w.test_slug AND d.is_active) AS definition_version
 FROM watched w
), scopes AS MATERIALIZED (
 SELECT DISTINCT scope_key,class_id,test_slug,student_ref FROM authorized
 WHERE context_fresh AND login_valid AND class_count=1 AND allowed_count=1 AND definition_version IS NOT NULL
), identities AS MATERIALIZED (
 SELECT s.scope_key,r.erp_student_contact_id FROM scopes s JOIN assessment.term_test_roster r
  ON r.erp_course_class_id=s.class_id AND r.test_slug=s.test_slug AND r.student_ref=s.student_ref
 UNION SELECT s.scope_key,r.erp_student_contact_id FROM scopes s JOIN mapping.student_mapping_review r
  ON r.erp_course_class_id=s.class_id AND r.public_id=s.student_ref AND r.status<>'superseded'
 UNION SELECT s.scope_key,-r.temporary_student_id FROM scopes s JOIN assessment.term_test_temporary_student r
  ON r.erp_course_class_id=s.class_id AND r.test_slug=s.test_slug AND r.student_ref=s.student_ref AND r.active
), fingerprints AS (
 ${sources.map(([name,table,alias,condition,version])=>`SELECT s.scope_key,'${name}' AS source,${version} AS version
 FROM scopes s JOIN ${table} ${alias} ON ${condition}
 WHERE ${['definition','class'].includes(name)?'true':'s.student_ref IS NULL'}`).join('\n UNION ALL\n ')}
 UNION ALL SELECT s.scope_key,'identity',jsonb_build_array(i.erp_student_contact_id)::text
 FROM scopes s JOIN identities i ON i.scope_key=s.scope_key WHERE s.student_ref IS NOT NULL
 UNION ALL SELECT s.scope_key,'selected-attempt',${rowVersion('a')}
 FROM scopes s JOIN identities i ON i.scope_key=s.scope_key JOIN assessment.term_test_attempt a
  ON a.erp_course_class_id=s.class_id AND a.test_slug=s.test_slug AND a.erp_student_contact_id=i.erp_student_contact_id
 WHERE s.student_ref IS NOT NULL
 UNION ALL SELECT s.scope_key,'selected-session',${rowVersion('e')}
 FROM scopes s JOIN identities i ON i.scope_key=s.scope_key JOIN assessment.term_test_exam_session e
  ON e.erp_course_class_id=s.class_id AND e.test_slug=s.test_slug AND e.erp_student_contact_id=i.erp_student_contact_id
 WHERE s.student_ref IS NOT NULL
 UNION ALL SELECT s.scope_key,'selected-identity',${rowVersion('r')}
 FROM scopes s JOIN mapping.student_mapping_review r ON r.erp_course_class_id=s.class_id AND r.public_id=s.student_ref
 WHERE s.student_ref IS NOT NULL AND r.status<>'superseded'
 UNION ALL SELECT s.scope_key,'selected-roster',${rowVersion('r')}
 FROM scopes s JOIN assessment.term_test_roster r
  ON r.erp_course_class_id=s.class_id AND r.test_slug=s.test_slug AND r.student_ref=s.student_ref WHERE s.student_ref IS NOT NULL
 UNION ALL SELECT s.scope_key,'selected-temporary',${rowVersion('r')}
 FROM scopes s JOIN assessment.term_test_temporary_student r
  ON r.erp_course_class_id=s.class_id AND r.test_slug=s.test_slug AND r.student_ref=s.student_ref
 WHERE s.student_ref IS NOT NULL AND r.active
), revisions AS (
 SELECT scope_key,md5(jsonb_agg(jsonb_build_array(source,version) ORDER BY source,version)::text) AS revision
 FROM fingerprints GROUP BY scope_key
)
SELECT a.key,a.scope_key,a.context_fresh,a.login_valid,a.class_count,a.allowed_count,a.definition_version,
 (SELECT count(*)::int FROM identities i WHERE i.scope_key=a.scope_key) AS identity_count,
 md5(jsonb_build_array(
  (SELECT jsonb_build_array(account.role,account.can_access_all_classes) FROM mapping.reviewer_account account WHERE account.email=a.email),
  ${buildTeacherClassAccessPredicate({reviewerEmailSql:'a.email',classIdSql:'a.class_id'})}
 )::text) AS access_revision,
 coalesce(r.revision,md5('[]')) AS revision
FROM authorized a LEFT JOIN revisions r ON r.scope_key=a.scope_key;`;

export function createK56TeacherObservation({pool,interval=30000,maxConnections=256,setTimer,clearTimer}){
 async function read({guards}){
  const wanted=new Map(guards.map(guard=>[guard.hash,guard.watched]));
  // Truy vấn metadata nhỏ không cần biên dịch JIT; giữ lựa chọn này trong đúng
  // giao dịch chỉ đọc, không đổi cấu hình pool hoặc các truy vấn lưu bài.
  const client=await pool.connect();let result,discard=false;
  try{
   await client.query('BEGIN READ ONLY');
   await client.query('SET LOCAL jit=off');
   await client.query("SET LOCAL statement_timeout='4s'");
   result=await client.query({text:k56TeacherObservationBatchSql,values:[JSON.stringify([...wanted.values()])],query_timeout:5000});
   await client.query('COMMIT');
  }catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}
  finally{client.release(discard);}
  if(!Array.isArray(result.rows)||result.rows.length!==wanted.size)fail(503,'STATE_DATA_INVALID');
  const sessions=new Map(),states=new Map();
  for(const row of result.rows){
   const input=wanted.get(row.key);
   if(!input||sessions.has(row.key)||row.scope_key!==input.scope_key
    ||typeof row.context_fresh!=='boolean'||typeof row.login_valid!=='boolean'
    ||![row.class_count,row.allowed_count,row.identity_count].every(Number.isInteger)
    ||!(/^[a-f0-9]{32}$/.test(row.revision))||!(/^[a-f0-9]{32}$/.test(row.access_revision)))fail(503,'STATE_DATA_INVALID');
   sessions.set(row.key,row);
   const value={revision:row.revision,definitionVersion:row.definition_version};
   // Phiên không được phép không được quyết định revision của lớp đang có người khác xem.
   if(row.context_fresh&&row.login_valid&&row.class_count===1&&row.allowed_count===1&&row.definition_version!==null){
    if(states.has(row.scope_key)&&JSON.stringify(states.get(row.scope_key))!==JSON.stringify(value))fail(503,'STATE_DATA_INVALID');
    states.set(row.scope_key,value);
   }
  }
  return{sessions,states};
 }
 const hub=createTestObservationHub({read,interval,maxConnections,setTimer,clearTimer});
 function guard(input,email,authorization){
  if(!/^[A-Z0-9._-]{2,32}$/.test(input.class)||!['term-test-1-k56','term-test-2-k56','mini-test-k56'].includes(input.test)
   ||(input.student!==undefined&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.student)))fail(400,'INVALID_QUERY');
  const student=input.student?.toLowerCase()||null,scope={className:input.class,testSlug:input.test,studentRef:student};
  scope.key=JSON.stringify([scope.className,scope.testSlug,student]);
  const hash=digest([email,authorization,scope.key]);
  return{scope,guard:{hash,key:hash,watched:{key:hash,scope_key:scope.key,class_name:scope.className,test_slug:scope.testSlug,student_ref:student,email,auth_proof:authorization},
   async verify(row){
    if(!row.context_fresh)fail(503,'CONTEXT_UNAVAILABLE');
    if(!row.login_valid)fail(401,'TEACHER_LOGIN_REQUIRED');
    if(row.definition_version===null)fail(404,'TEST_NOT_FOUND');
    if(row.class_count!==1)fail(404,'CLASS_NOT_FOUND');
    if(row.allowed_count!==1)fail(403,'ACCESS_DENIED');
    if(student&&row.identity_count!==1)fail(404,'STUDENT_NOT_FOUND');
    return{accessRevision:row.access_revision};
   },state(value,verified){return{kind:'term-teacher-state-v1',className:scope.className,testSlug:scope.testSlug,studentRef:student,
    definitionVersion:value.definitionVersion,contentRevision:value.revision,accessRevision:verified.accessRevision};}}};
 }
 return{hub,guard};
}

export function mountK56TeacherObservation(app,{pool,authenticate,limiter}){
 const observation=createK56TeacherObservation({pool});
 const schema=z.object({class:z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  test:z.enum(['term-test-1-k56','term-test-2-k56','mini-test-k56']),student:z.uuid().optional()}).strict();
 for(const stream of [false,true])app.get('/api/term-tests/teacher/state'+(stream?'/stream':''),limiter,authenticate,async(req,res,next)=>{
  res.set('Cache-Control','private, no-store');const parsed=schema.safeParse(req.query);
  if(!parsed.success)return res.status(400).json({ok:false,error:'INVALID_QUERY'});
  const controller=new AbortController(),abort=()=>controller.abort();req.on('aborted',abort);res.on('close',abort);
  try{
   const watched=observation.guard(parsed.data,req.reviewer.email,k56TeacherAuthorization(req));
   if(stream)return openTestObservationStream({response:res,hub:observation.hub,...watched});
   const state=await observation.hub.readOnce(watched.scope,watched.guard,{signal:controller.signal});
   if(!res.destroyed)return res.json({ok:true,state});
  }catch(error){
   if(res.destroyed)return;
   if(error.status)return res.status(error.status).json({ok:false,error:error.code||'STATE_UNAVAILABLE'});
   next(error);
  }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
 });
 return{close:()=>observation.hub.close(),snapshot:()=>observation.hub.snapshot()};
}
