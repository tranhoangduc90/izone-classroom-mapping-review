/** Reading/Listening adapter: summary metadata and selected-row fingerprints, never content payloads. */
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPracticeObservation({pool,context,schema,fail}){
 if(!['reading_practice','listening_practice'].includes(schema))throw Error('STATE_SCHEMA_INVALID');
 async function read({scopes,guards}){
  const pairs=[...new Map(scopes.map(scope=>[JSON.stringify([scope.classId,scope.code]),{class_id:scope.classId,code:scope.code}])).values()];
  const ids=[...new Set(scopes.map(scope=>scope.unitId).filter(Boolean))],hashes=[...new Set(guards.map(guard=>guard.hash))];
  const [sessions,metadata]=await Promise.all([
   pool.query(`SELECT token_hash,email,google_subject,expires_at,absolute_expires_at,remembered FROM ${schema}.teacher_session
    WHERE token_hash=ANY($1::text[]) AND expires_at>now() AND absolute_expires_at>now()`,[hashes]),
   pool.query(`WITH watched AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(class_id text,code text))
    SELECT b.id,b.student_ref,b.document_id,b.tab_id,b.owner_proof#>>'{homework,documentId}' AS homework_document,
    a.id AS assignment_id,a.class_id,a.class_code,a.status AS assignment_status,c.code,c.version,c.digest,
    w.updated_at AS saved_at,w.state#>>'{attempts,-1,id}' AS attempt_id,w.state#>>'{attempts,-1,status}' AS attempt_status,
    w.state#>>'{attempts,-1,completedAt}' AS completed_at,
    COALESCE(jsonb_typeof(w.state#>'{attempts,-1,draft,answers}'),'object')<>'object' AS invalid_answers,
    (SELECT count(*)::int FROM jsonb_each(CASE WHEN jsonb_typeof(w.state#>'{attempts,-1,draft,answers}')='object'
      THEN w.state#>'{attempts,-1,draft,answers}' ELSE '{}'::jsonb END) answer
      WHERE answer.value NOT IN ('""'::jsonb,'null'::jsonb,'[]'::jsonb)) AS answered,
    CASE WHEN b.id=ANY($2::uuid[]) THEN md5(jsonb_build_array(w.state,c.definition,c.answer_key)::text) ELSE NULL END AS unit_content_revision
    FROM ${schema}.binding b JOIN ${schema}.assignment a ON a.id=b.assignment_id
    JOIN ${schema}.content c ON c.id=a.content_id LEFT JOIN ${schema}.work w ON w.binding_id=b.id
    WHERE EXISTS(SELECT 1 FROM watched x WHERE x.class_id=a.class_id AND x.code=c.code) OR b.id=ANY($2::uuid[])
    ORDER BY c.version,b.id`,[JSON.stringify(pairs),ids])
  ]);
  const states=new Map();
  for(const scope of scopes){
   if(states.has(scope.key))continue;const rows=metadata.rows.filter(row=>row.class_id===scope.classId&&row.code===scope.code);
   const unit=scope.unitId?metadata.rows.find(row=>row.id===scope.unitId):null;
   states.set(scope.key,{rows,unit,unitError:scope.unitId&&!unit?{status:404,code:'RESULT_NOT_FOUND'}:unit&&(unit.class_id!==scope.classId||unit.code!==scope.code)?{status:403,code:'ACCESS_DENIED'}:null});
  }
  return{sessions:new Map(sessions.rows.map(row=>[row.token_hash,row])),states};
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
   const classRows=base.rows.map(({unit_content_revision,...row})=>row);
   return{kind:'practice-teacher-state-v1',classId:scope.classId,code:scope.code,unitId:scope.unitId,
    classRevision:digest([classRows,verified.roster]),unitRevision:base.unit?digest([base.unit,verified.roster.find(row=>row.studentRef===base.unit.student_ref)||null]):null};
  }}};
 }
 return{read,guard};
}
