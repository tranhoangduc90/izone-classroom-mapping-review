// Đọc theo tập ID/scope, dùng schema native của từng kho. Không cấp quyền, mở/nộp bài
// hoặc khôi phục Docs ở đây; adapter của vai trò phải kiểm quyền trước khi phát frame.
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid=()=>Object.assign(Error('SPEAKING_STATE_INPUT_INVALID'),{code:'SPEAKING_STATE_INPUT_INVALID',status:400});
const distinct=(values,key)=>[...new Map(values.map(value=>[key(value),value])).values()];
function inputs(value){
 if(!value||Object.keys(value).some(key=>!['classes','unitIds','sessions','contentIds'].includes(key)))throw invalid();
 const {classes=[],unitIds=[],sessions=[],contentIds=[]}=value;
 if(![classes,unitIds,sessions,contentIds].every(rows=>Array.isArray(rows)&&rows.length<=1000))throw invalid();
 if([...unitIds,...contentIds].some(id=>typeof id!=='string'||!uuid.test(id)))throw invalid();
 for(const row of classes)if(!row||Object.keys(row).some(key=>!['classId','code','courseId'].includes(key))
  ||typeof row.classId!=='string'||!/^\d{1,19}$/.test(row.classId)||BigInt(row.classId)>9223372036854775807n||typeof row.code!=='string'||row.code.length<3||row.code.length>100
  ||(row.courseId!==undefined&&(typeof row.courseId!=='string'||!/^\d+$/.test(row.courseId))))throw invalid();
 for(const row of sessions)if(!row||Object.keys(row).some(key=>!['hash','studentRef'].includes(key))
  ||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)||typeof row.studentRef!=='string'||!uuid.test(row.studentRef))throw invalid();
 return {classes:distinct(classes.map(row=>({...row,classId:String(BigInt(row.classId))})),row=>JSON.stringify([row.classId,row.code,row.courseId||null])),
  unitIds:[...new Set(unitIds.map(id=>id.toLowerCase()))],
  sessions:distinct(sessions.map(row=>({...row,studentRef:row.studentRef.toLowerCase()})),row=>row.hash+':'+row.studentRef),
  contentIds:[...new Set(contentIds.map(id=>id.toLowerCase()))]};
}

const watched=`watched AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(class_id bigint,code text,course_id text)),
 sessions AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(hash text,student_ref uuid))`;
const docsProjection=`CASE WHEN d.unit_id IS NULL THEN NULL ELSE jsonb_build_object('status',d.status,'error_code',d.error_code,
 'sequence',d.sequence::text,'applied_sequence',d.applied_sequence::text,'verified_at',d.verified_at) END`;

const independent=`WITH ${watched}, selected AS MATERIALIZED (
 SELECT u.id,u.profile_id,u.assignment_code,u.template,u.origin,u.context_key,u.status,u.document_id,u.submitted_at,u.created_at,
 p.kind AS profile_kind,p.identity_ref,p.student_ref,p.student_name,p.class_id,p.class_code,p.course_id,
 coalesce(p.linked_profile_id,p.id) AS doctor_profile_id,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('hash',s.hash,'studentRef',s.student_ref)),'[]'::jsonb)
  FROM sessions s WHERE s.hash=u.token_hash AND s.student_ref IN(p.identity_ref,p.student_ref)) AS matched_sessions
 FROM speaking_independent.work_unit u JOIN speaking_independent.profile p ON p.id=u.profile_id
 WHERE u.revoked_at IS NULL AND (u.id=ANY($2::uuid[])
  OR EXISTS(SELECT 1 FROM watched w WHERE w.class_id=p.class_id AND w.code=u.assignment_code)
  OR EXISTS(SELECT 1 FROM sessions s WHERE s.hash=u.token_hash AND s.student_ref IN(p.identity_ref,p.student_ref)))
 ), latest AS MATERIALIZED (
 SELECT DISTINCT ON(l.work_unit_id,l.kind,l.part) l.* FROM speaking_independent.link l
 JOIN selected u ON u.id=l.work_unit_id ORDER BY l.work_unit_id,l.kind,l.part,l.revision DESC
 ), links AS (
 SELECT work_unit_id,jsonb_agg(to_jsonb(l) ORDER BY kind,part) AS data,count(*)::int AS sent_links,
 count(*) FILTER(WHERE status='accepted')::int AS accepted_links,max(created_at) AS saved_at
 FROM latest l GROUP BY work_unit_id
 ), jobs AS (
 SELECT j.work_unit_id,
 jsonb_agg(jsonb_build_object('kind',j.kind,'status',j.status,'link_id',j.link_id,'attempts',j.attempts) ORDER BY j.created_at,j.id) AS data,
 jsonb_agg(jsonb_build_array(j.kind,j.status,j.link_id,j.attempts>=5) ORDER BY j.created_at,j.id)
  FILTER(WHERE j.kind<>'write_doc') AS content,
 jsonb_agg(jsonb_build_object('kind',j.kind,'status',j.status) ORDER BY j.created_at,j.id)
  FILTER(WHERE j.kind='write_doc') AS docs
 FROM speaking_independent.job j JOIN selected u ON u.id=j.work_unit_id GROUP BY j.work_unit_id
 ), recommendations AS (
 SELECT r.profile_id,jsonb_agg(to_jsonb(r) ORDER BY r.exercise_id) AS data
 FROM speaking_independent.doctor_recommendation r
 WHERE EXISTS(SELECT 1 FROM selected u WHERE u.doctor_profile_id=r.profile_id) GROUP BY r.profile_id
 )
 SELECT u.id AS unit_id,NULL::uuid AS grant_id,u.profile_id,u.assignment_code,u.class_id::text,u.class_code,u.course_id,
 u.profile_kind,u.identity_ref,u.student_ref,u.student_name,u.origin,u.context_key,u.status,u.document_id,u.submitted_at,
 u.matched_sessions,true AS local_grant_allowed,r.id AS receipt_id,r.created_at AS receipt_created_at,
 coalesce(l.sent_links,0) AS sent_links,coalesce(l.accepted_links,0) AS accepted_links,l.saved_at,
 md5(jsonb_build_array(u.id,u.status,u.submitted_at,u.template,u.document_id,u.student_name,r.id,r.created_at,
  coalesce(l.data,'[]'::jsonb),coalesce(j.content,'[]'::jsonb),coalesce(rec.data,'[]'::jsonb))::text) AS content_revision,
 ${docsProjection} AS docs_progress,coalesce(j.docs,'[]'::jsonb) AS docs_jobs,
 CASE WHEN u.id=ANY($4::uuid[]) THEN jsonb_build_object('template',u.template,'links',coalesce(l.data,'[]'::jsonb),
  'jobs',coalesce(j.data,'[]'::jsonb),'recommendations',coalesce(rec.data,'[]'::jsonb)) ELSE NULL END AS content
 FROM selected u LEFT JOIN links l ON l.work_unit_id=u.id LEFT JOIN jobs j ON j.work_unit_id=u.id
 LEFT JOIN recommendations rec ON rec.profile_id=u.doctor_profile_id
 LEFT JOIN speaking_independent.receipt r ON r.work_unit_id=u.id
 LEFT JOIN speaking_independent.doc_progress d ON d.unit_id=u.id ORDER BY u.id`;

const legacy=`WITH ${watched}, selected AS MATERIALIZED (
 SELECT s.id,g.id AS grant_id,g.document_id,g.student_ref,a.id AS assignment_id,a.class_id,a.course_id,a.course_work_id,
 a.assignment_code,a.title,a.required_practice_count,a.doctor_course_key,s.status,s.submitted_at,
 m.erp_student_name_snapshot AS student_name,c.erp_class_name_snapshot AS class_code,
 coalesce((d.document_id IS NOT NULL AND (a.delivery_mode<>'direct' OR d.student_ref=g.student_ref)
  AND (a.status='open' OR(a.status='closed' AND s.status='submitted'))
  AND m.status='approved' AND c.status='approved' AND m.classroom_user_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM mapping.erp_class_membership_snapshot e
   WHERE e.erp_course_class_id=a.class_id AND e.erp_student_contact_id=m.erp_student_contact_id
    AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN('dropped','on_hold'))),false) AS student_allowed,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('hash',x.hash,'studentRef',x.student_ref)),'[]'::jsonb)
  FROM sessions x WHERE x.hash=g.token_hash AND x.student_ref=g.student_ref) AS matched_sessions
 FROM speaking_homework.access_grant g JOIN speaking_homework.assignment a ON a.id=g.assignment_id
 JOIN speaking_homework.submission s ON s.access_grant_id=g.id
 JOIN mapping.student_mapping_review m ON m.public_id=g.student_ref AND m.erp_course_class_id=a.class_id
 LEFT JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=a.class_id
 LEFT JOIN speaking_homework.assignment_document d ON d.assignment_id=a.id AND d.document_id=g.document_id
 WHERE g.revoked_at IS NULL AND (s.id=ANY($2::uuid[])
  OR EXISTS(SELECT 1 FROM watched w WHERE w.class_id=a.class_id AND w.code=a.assignment_code AND w.course_id=a.course_id)
  OR EXISTS(SELECT 1 FROM sessions x WHERE x.hash=g.token_hash AND x.student_ref=g.student_ref))
 ), latest_main AS MATERIALIZED (
 SELECT DISTINCT ON(l.submission_id,l.part) l.* FROM speaking_homework.submission_link l
 JOIN selected u ON u.id=l.submission_id ORDER BY l.submission_id,l.part,l.revision DESC
 ), latest_practice AS MATERIALIZED (
 SELECT DISTINCT ON(p.access_grant_id,p.slot) p.* FROM speaking_homework.practice_link p
 JOIN selected u ON u.grant_id=p.access_grant_id ORDER BY p.access_grant_id,p.slot,p.revision DESC
 ), main_links AS (
 SELECT submission_id,jsonb_agg(to_jsonb(l) ORDER BY part) AS data,count(*)::int AS sent_links,
 count(*) FILTER(WHERE check_status='accepted')::int AS accepted_links,max(created_at) AS saved_at
 FROM latest_main l GROUP BY submission_id
 ), practice_links AS (
 SELECT p.access_grant_id,jsonb_agg(to_jsonb(p)||jsonb_build_object('check_job_status',c.status,'check_job_attempts',c.attempts,
  'analysis_status',CASE WHEN a.status='failed' AND a.attempts>=5 THEN 'review' ELSE a.status END) ORDER BY p.slot) AS data,
 jsonb_agg(jsonb_build_array(to_jsonb(p),c.status,c.attempts>=5,
  CASE WHEN a.status='failed' AND a.attempts>=5 THEN 'review' ELSE a.status END) ORDER BY p.slot) AS content,
 count(*)::int AS sent_links,count(*) FILTER(WHERE p.status='accepted')::int AS accepted_links,max(p.submitted_at) AS saved_at
 FROM latest_practice p LEFT JOIN speaking_homework.practice_check_job c ON c.practice_link_id=p.id
 LEFT JOIN speaking_homework.practice_analysis_job a ON a.practice_link_id=p.id GROUP BY p.access_grant_id
 ), jobs AS (
 SELECT u.id,jsonb_agg(jsonb_build_object('kind',o.kind,'status',CASE WHEN o.status='failed' AND o.attempts>=5 THEN 'review' ELSE o.status END)
  ORDER BY o.created_at,o.id) AS data,
 jsonb_agg(jsonb_build_array(o.kind,CASE WHEN o.status='failed' AND o.attempts>=5 THEN 'review' ELSE o.status END) ORDER BY o.created_at,o.id)
  FILTER(WHERE o.kind<>'write_doc') AS content,
 jsonb_agg(jsonb_build_object('kind',o.kind,'status',CASE WHEN o.status='failed' AND o.attempts>=5 THEN 'review' ELSE o.status END)
  ORDER BY o.created_at,o.id) FILTER(WHERE o.kind='write_doc') AS docs
 FROM selected u JOIN speaking_homework.receipt r ON r.submission_id=u.id
 JOIN speaking_homework.outbox o ON o.receipt_id=r.id GROUP BY u.id
 ), parts AS (
 SELECT p.assignment_id,jsonb_agg(jsonb_build_object('part_key',p.part_key,'display_title',p.display_title,'practice_url',p.practice_url,
  'min_questions',p.min_questions) ORDER BY p.position) AS data FROM speaking_homework.assignment_part p
 WHERE EXISTS(SELECT 1 FROM selected u WHERE u.assignment_id=p.assignment_id) GROUP BY p.assignment_id
 ), catalog AS (
 SELECT e.course_key,jsonb_agg(jsonb_build_object('exercise_id',e.id,'title',e.title,'exercise_url',e.exercise_url) ORDER BY e.title,e.id) AS data
 FROM speaking_homework.doctor_exercise e WHERE e.active AND EXISTS(SELECT 1 FROM selected u WHERE u.doctor_course_key=e.course_key)
 GROUP BY e.course_key
 ), recommendations AS (
 SELECT r.class_id,r.student_ref,e.course_key,jsonb_agg(jsonb_build_object('exercise_id',r.exercise_id,'title',e.title,'exercise_url',e.exercise_url,
  'recommendation_count',r.recommendation_count,'practice_count',r.practice_count,'waiting',r.waiting,
  'proposed_at',r.proposed_at,'last_practiced_at',r.last_practiced_at)
  ORDER BY r.waiting DESC,r.recommendation_count DESC,e.title,e.id) AS data
 FROM speaking_homework.doctor_recommendation r JOIN speaking_homework.doctor_exercise e ON e.id=r.exercise_id AND e.active
 WHERE EXISTS(SELECT 1 FROM selected u WHERE u.class_id=r.class_id AND u.student_ref=r.student_ref AND u.doctor_course_key=e.course_key)
 GROUP BY r.class_id,r.student_ref,e.course_key
 )
 SELECT u.id AS unit_id,u.grant_id,NULL::uuid AS profile_id,u.assignment_code,u.class_id::text,u.class_code,u.course_id,u.course_work_id,
 'member'::text AS profile_kind,u.student_ref AS identity_ref,u.student_ref,u.student_name,'legacy'::text AS origin,'legacy'::text AS context_key,
 u.status,u.document_id,u.submitted_at,u.student_allowed AS local_grant_allowed,u.matched_sessions,r.id AS receipt_id,r.created_at AS receipt_created_at,
 coalesce(m.sent_links,0)+coalesce(p.sent_links,0) AS sent_links,coalesce(m.accepted_links,0)+coalesce(p.accepted_links,0) AS accepted_links,
 greatest(m.saved_at,p.saved_at) AS saved_at,
 md5(jsonb_build_array(u.id,u.status,u.submitted_at,u.title,u.document_id,u.student_name,u.course_work_id,u.required_practice_count,u.doctor_course_key,r.id,r.created_at,
  coalesce(m.data,'[]'::jsonb),coalesce(p.content,'[]'::jsonb),coalesce(j.content,'[]'::jsonb),coalesce(parts.data,'[]'::jsonb),
  coalesce(rec.data,'[]'::jsonb),CASE WHEN u.required_practice_count>0 THEN coalesce(cat.data,'[]'::jsonb) ELSE '[]'::jsonb END)::text) AS content_revision,
 ${docsProjection} AS docs_progress,coalesce(j.docs,'[]'::jsonb) AS docs_jobs,
 CASE WHEN u.id=ANY($4::uuid[]) THEN jsonb_build_object('assignment',jsonb_build_object('id',u.assignment_id,'title',u.title,'classId',u.class_id,
  'courseWorkId',u.course_work_id,'documentId',u.document_id,'requiredPracticeCount',u.required_practice_count,'doctorEnabled',coalesce(u.doctor_course_key,'')<>''),
  'parts',coalesce(parts.data,'[]'::jsonb),'links',coalesce(m.data,'[]'::jsonb),'practiceLinks',coalesce(p.data,'[]'::jsonb),
  'jobs',coalesce(j.data,'[]'::jsonb),'recommendations',coalesce(rec.data,'[]'::jsonb),
  'catalog',CASE WHEN u.required_practice_count>0 THEN coalesce(cat.data,'[]'::jsonb) ELSE '[]'::jsonb END) ELSE NULL END AS content
 FROM selected u LEFT JOIN main_links m ON m.submission_id=u.id LEFT JOIN practice_links p ON p.access_grant_id=u.grant_id
 LEFT JOIN jobs j ON j.id=u.id LEFT JOIN parts ON parts.assignment_id=u.assignment_id
 LEFT JOIN catalog cat ON cat.course_key=u.doctor_course_key
 LEFT JOIN recommendations rec ON rec.class_id=u.class_id AND rec.student_ref=u.student_ref AND rec.course_key=u.doctor_course_key
 LEFT JOIN speaking_homework.receipt r ON r.submission_id=u.id
 LEFT JOIN speaking_homework.doc_progress d ON d.unit_id=u.grant_id ORDER BY u.id`;

export function createSpeakingObservationData({pool,schema}){
 if(!['speaking_independent','speaking_homework'].includes(schema))throw Error('SPEAKING_STATE_SCHEMA_INVALID');
 return {async read(value={}){
  const input=inputs(value);
  if(schema==='speaking_homework'&&input.classes.some(row=>!row.courseId))throw invalid();
  if(!input.classes.length&&!input.unitIds.length&&!input.sessions.length)return [];
  const classes=input.classes.map(row=>({class_id:row.classId,code:row.code,course_id:row.courseId||null}));
  const sessions=input.sessions.map(row=>({hash:row.hash,student_ref:row.studentRef}));
  return (await pool.query(schema==='speaking_independent'?independent:legacy,
   [JSON.stringify(classes),input.unitIds,JSON.stringify(sessions),input.contentIds])).rows.map(row=>({...row,schema}));
 }};
}
