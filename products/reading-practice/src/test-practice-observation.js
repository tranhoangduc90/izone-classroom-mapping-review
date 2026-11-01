/** Reading/Listening adapter: summary metadata and selected-row fingerprints, never content payloads. */
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPracticeObservation({pool,context,schema,fail}){
 if(!['reading_practice','listening_practice'].includes(schema))throw Error('STATE_SCHEMA_INVALID');
 async function read({scopes,guards}){
  const teachers=scopes.filter(scope=>scope.kind!=='student'),students=scopes.filter(scope=>scope.kind==='student');
  const pairs=[...new Map(teachers.map(scope=>[JSON.stringify([scope.classId,scope.code]),{class_id:scope.classId,code:scope.code}])).values()];
  const ids=[...new Set(scopes.map(scope=>scope.unitId).filter(Boolean))],teacherIds=[...new Set(teachers.map(scope=>scope.unitId).filter(Boolean))],studentIds=[...new Set(students.map(scope=>scope.unitId))];
  const hashes=[...new Set(guards.filter(guard=>guard.kind!=='student').map(guard=>guard.hash))],studentHashes=[...new Set(guards.filter(guard=>guard.kind==='student').map(guard=>guard.sessionHash))];
  const watchedStudents=[...new Map(students.map(scope=>[JSON.stringify([scope.unitId,scope.attemptId]),{binding_id:scope.unitId,attempt_id:scope.attemptId}])).values()];
  const [sessions,metadata]=await Promise.all([
   pool.query(`SELECT token_hash AS observation_hash,token_hash,email,google_subject,expires_at,absolute_expires_at,remembered,NULL::uuid AS binding_id FROM ${schema}.teacher_session
    WHERE token_hash=ANY($1::text[]) AND expires_at>now() AND absolute_expires_at>now()
    UNION ALL SELECT 'student:'||token_hash,token_hash,NULL::text,NULL::text,expires_at,NULL::timestamptz,NULL::boolean,binding_id
    FROM ${schema}.student_session WHERE token_hash=ANY($2::text[]) AND expires_at>now()`,[hashes,studentHashes]),
   pool.query(`WITH watched AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(class_id text,code text)),
    student_watched AS (SELECT * FROM jsonb_to_recordset($5::jsonb) AS x(binding_id uuid,attempt_id uuid))
    SELECT b.id,b.student_ref,b.document_id,b.tab_id,b.owner_proof#>>'{homework,documentId}' AS homework_document,
    b.owner_proof#>>'{homework,tabId}' AS homework_tab,b.owner_proof->>'mode' AS owner_mode,
    a.id AS assignment_id,a.class_id,a.class_code,a.status AS assignment_status,c.code,c.version,c.digest,
    w.updated_at AS saved_at,w.state#>>'{attempts,-1,id}' AS attempt_id,w.state#>>'{attempts,-1,status}' AS attempt_status,
    w.state#>>'{attempts,-1,completedAt}' AS completed_at,
    COALESCE(jsonb_typeof(w.state#>'{attempts,-1,draft,answers}'),'object')<>'object' AS invalid_answers,
    (SELECT count(*)::int FROM jsonb_each(CASE WHEN jsonb_typeof(w.state#>'{attempts,-1,draft,answers}')='object'
      THEN w.state#>'{attempts,-1,draft,answers}' ELSE '{}'::jsonb END) answer
      WHERE answer.value NOT IN ('""'::jsonb,'null'::jsonb,'[]'::jsonb)) AS answered,
    CASE WHEN b.id=ANY($3::uuid[]) THEN md5(jsonb_build_array(w.state,c.definition,c.answer_key)::text) ELSE NULL END AS unit_content_revision,
    CASE WHEN b.id=ANY($4::uuid[]) THEN jsonb_build_object(
      'valid',jsonb_typeof(w.state->'attempts')='array' AND jsonb_typeof(w.state->'events')='array',
      'events',w.state->'events','firstCompleted',w.state->'firstCompleted',
      'attempts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a->>'id','no',a->'no','status',a->>'status',
        'valid',jsonb_typeof(a#>'{draft,answers}')='object',
        'resultRevision',md5(jsonb_build_array(a,c.definition,c.answer_key,c.explanations)::text))),'[]'::jsonb)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.state->'attempts')='array' THEN w.state->'attempts' ELSE '[]'::jsonb END) a
        WHERE EXISTS(SELECT 1 FROM student_watched s WHERE s.binding_id=b.id AND s.attempt_id::text=a->>'id')),
      'docStates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('sequence',j.sequence,'status',j.status)),'[]'::jsonb)
        FROM ${schema}.doc_job j WHERE j.binding_id=b.id)) ELSE NULL END AS student_state
    FROM ${schema}.binding b JOIN ${schema}.assignment a ON a.id=b.assignment_id
    JOIN ${schema}.content c ON c.id=a.content_id LEFT JOIN ${schema}.work w ON w.binding_id=b.id
    WHERE EXISTS(SELECT 1 FROM watched x WHERE x.class_id=a.class_id AND x.code=c.code) OR b.id=ANY($2::uuid[])
    ORDER BY c.version,b.id`,[JSON.stringify(pairs),ids,teacherIds,studentIds,JSON.stringify(watchedStudents)])
  ]);
  const states=new Map();
  for(const scope of scopes){
   if(states.has(scope.key))continue;const rows=metadata.rows.filter(row=>row.class_id===scope.classId&&row.code===scope.code);
   const unit=scope.unitId?metadata.rows.find(row=>row.id===scope.unitId):null;
   states.set(scope.key,{rows,unit,unitError:scope.unitId&&!unit?{status:404,code:'RESULT_NOT_FOUND'}:unit&&(unit.class_id!==scope.classId||unit.code!==scope.code)?{status:403,code:'ACCESS_DENIED'}:null});
  }
  return{sessions:new Map(sessions.rows.map(row=>[row.observation_hash,row])),states};
 }
 async function guard(input,identity){
  const scope={classId:input.classId,code:input.code,unitId:input.unitId||null};scope.key=JSON.stringify([scope.classId,scope.code,scope.unitId]);
  if(!identity.value)fail('TEACHER_LOGIN_REQUIRED','Giảng viên cần đăng nhập Google.',401);
  async function verify(session){
   if(session.email!==identity.email||session.google_subject!==identity.google_subject)fail('TEACHER_LOGIN_REQUIRED','Phiên giảng viên đã đổi.',401);
   if(!await context.teacher(scope.classId,session.email,session.google_subject))fail('ACCESS_DENIED','Tài khoản này chưa có quyền lớp.',403);
   return{roster:await context.roster(scope.classId)};
  }
  await verify(identity);
  if(scope.unitId){
   const unit=(await pool.query(`SELECT a.class_id,c.code FROM ${schema}.binding b JOIN ${schema}.assignment a ON a.id=b.assignment_id
    JOIN ${schema}.content c ON c.id=a.content_id WHERE b.id=$1`,[scope.unitId])).rows[0];
   if(!unit)fail('RESULT_NOT_FOUND','Không tìm thấy bài được giao.',404);
   if(unit.class_id!==scope.classId||unit.code!==scope.code)fail('ACCESS_DENIED','Bài không thuộc lớp và mã đang xem.',403);
  }
  const hash=createHash('sha256').update(identity.value).digest('hex');
  return{scope,guard:{hash,key:hash+':'+scope.classId,verify,assertCurrent(session){
   if(session.email!==identity.email||session.google_subject!==identity.google_subject)fail('TEACHER_LOGIN_REQUIRED','Phiên giảng viên đã đổi.',401);
  },state(base,verified){
   if(base.unitError)fail(base.unitError.code,'Bài vừa xem không còn thuộc phạm vi được truy cập.',base.unitError.status);
   if(base.rows.some(row=>row.invalid_answers))fail('STATE_DATA_INVALID','Chưa đọc được trạng thái bài trong phạm vi này.',503);
   // Hash full content only for selected units, inside SQL. Other watchers must not alter the class signature.
   const teacherRow=({student_state,homework_tab,owner_mode,...row})=>row;
   const classRows=base.rows.map(teacherRow).map(({unit_content_revision,...row})=>row);
   return{kind:'practice-teacher-state-v1',classId:scope.classId,code:scope.code,unitId:scope.unitId,
    classRevision:digest([classRows,verified.roster]),unitRevision:base.unit?digest([teacherRow(base.unit),verified.roster.find(row=>row.studentRef===base.unit.student_ref)||null]):null};
  }}};
 }
 async function studentGuard({token,attemptId}){
  if(typeof token!=='string'||!/^[-\w]{43}$/.test(token))fail('UNAUTHORIZED','Phiên bài làm không còn hợp lệ.',401);
  const sessionHash=createHash('sha256').update(token).digest('hex');
  const row=(await pool.query(`SELECT s.binding_id,b.student_ref,a.id AS assignment_id,a.class_id,a.class_code,c.code,
    jsonb_typeof(w.state->'attempts') AS attempts_type,
    EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.state->'attempts')='array' THEN w.state->'attempts' ELSE '[]'::jsonb END) x
      WHERE x->>'id'=$2 AND x->>'status'='submitted') AS result_exists
    FROM ${schema}.student_session s JOIN ${schema}.binding b ON b.id=s.binding_id
    JOIN ${schema}.assignment a ON a.id=b.assignment_id JOIN ${schema}.content c ON c.id=a.content_id
    LEFT JOIN ${schema}.work w ON w.binding_id=b.id WHERE s.token_hash=$1 AND s.expires_at>now()`,[sessionHash,attemptId])).rows[0];
  if(!row)fail('UNAUTHORIZED','Phiên bài làm không còn hợp lệ.',401);
  const scope={kind:'student',classId:row.class_id,code:row.code,unitId:row.binding_id,attemptId};scope.key=JSON.stringify(['student',scope.unitId,attemptId]);
  const assertCurrent=session=>{if(session.binding_id!==scope.unitId)fail('UNAUTHORIZED','Phiên bài làm đã đổi.',401);};
  const verify=async session=>{assertCurrent(session);const member=await context.student(scope.classId,row.student_ref);if(!member)fail('STUDENT_NOT_ELIGIBLE','Hồ sơ học viên chưa có quyền mở bài này.',403);return{member};};
  await verify({binding_id:scope.unitId});
  if(row.attempts_type&&row.attempts_type!=='array')fail('STATE_DATA_INVALID','Chưa đọc được trạng thái kết quả.',503);
  if(!row.result_exists)fail('RESULT_NOT_AVAILABLE','Chỉ theo dõi kết quả đã nộp của đúng bài.',404);
  return{scope,guard:{kind:'student',sessionHash,hash:'student:'+sessionHash,key:'student:'+sessionHash+':'+scope.unitId,verify,assertCurrent,
   state(base,verified){
    if(base.unitError)fail(base.unitError.code,'Kết quả không còn thuộc phạm vi được truy cập.',base.unitError.status);
    const unit=base.unit;
    if(!unit||unit.student_ref!==row.student_ref||unit.assignment_id!==row.assignment_id)fail('ACCESS_DENIED','Bài làm không còn thuộc người học này.',403);
    const data=unit.student_state,attempt=data?.attempts?.find(value=>value.id===attemptId);
    if(!data?.valid||!Array.isArray(data.events)||data.events.some(event=>!event||!Number.isInteger(event.sequence)))fail('STATE_DATA_INVALID','Chưa đọc được trạng thái kết quả.',503);
    if(!attempt||attempt.status!=='submitted')fail('RESULT_NOT_AVAILABLE','Kết quả đã nộp hiện không còn sẵn sàng.',404);
    if(!attempt.valid)fail('STATE_DATA_INVALID','Chưa đọc được trạng thái kết quả.',503);
    const jobs=new Map(data.docStates.map(job=>[String(job.sequence),job.status])),syncs=schema==='listening_practice'||Boolean(unit.document_id||unit.owner_mode==='shared');
    const documentId=unit.document_id||(schema==='listening_practice'?unit.homework_document:null),tab=schema==='reading_practice'?unit.tab_id:unit.tab_id||unit.homework_tab;
    return{kind:'practice-student-state-v1',bindingId:scope.unitId,studentRef:row.student_ref,assignmentId:row.assignment_id,code:scope.code,
     attemptId,attemptNo:attempt.no,resultRevision:attempt.resultRevision,latestAttemptId:unit.attempt_id,latestStatus:unit.attempt_status,
     firstCompleted:data.firstCompleted,events:data.events.filter(event=>event.attempt===attempt.no).map(event=>({...event,docs:syncs?jobs.get(String(event.sequence))||'pending':'not_applicable'})),
     identity:{bindingId:scope.unitId,studentRef:row.student_ref,assignmentId:row.assignment_id,name:verified.member.name,classCode:unit.class_code,
      entryMode:unit.document_id?'homework':'shared',documentId:documentId||null,documentUrl:documentId?`https://docs.google.com/document/d/${documentId}/edit?tab=${encodeURIComponent(tab)}`:null}};
   }}};
 }
 return{read,guard,studentGuard};
}
