import {createHash} from 'node:crypto';
import {z} from 'zod';
import {teacherCanReadClass} from './sql.js';

// Giảng viên đọc báo cáo tự khai và bản luyện đã lưu, không chạy kiểm âm thanh,
// không cấp token/audio, không mở hoặc chấm bài thi thật.
export function createReadinessTeacher({pool,classes}){
 const scopes=[...classes].map(c=>c.toUpperCase());
 const permission=teacherCanReadClass('$2','$3','c.erp_course_class_id');
 const scope=`WITH allowed AS(SELECT c.erp_course_class_id,c.erp_class_name_snapshot FROM mapping.classroom_course_mapping c
  WHERE c.erp_course_class_id::text=$1 AND upper(c.erp_class_name_snapshot)=ANY($4::text[]) AND ${permission})`;
 const fail=()=>{throw Object.assign(new Error('Tài khoản chưa có quyền xem lớp hoặc hồ sơ này.'),{status:403,code:'ACCESS_DENIED'});};
 async function listClasses(email,authorization){
  const {rows}=await pool.query(`SELECT c.erp_course_class_id::text AS "classId",c.erp_class_name_snapshot AS "classCode"
   FROM mapping.classroom_course_mapping c WHERE upper(c.erp_class_name_snapshot)=ANY($1::text[])
   AND ${teacherCanReadClass('$2','$3','c.erp_course_class_id')} ORDER BY c.erp_class_name_snapshot`,[scopes,email,authorization]);
  if(!rows.length)fail();return {classes:rows};
 }
 async function students({classId},email,authorization){
  const {rows:[value]}=await pool.query(`${scope}, roster AS(
   SELECT s.* FROM mapping.student_mapping_review s JOIN allowed c ON c.erp_course_class_id=s.erp_course_class_id
   WHERE s.status='approved' OR EXISTS(SELECT 1 FROM assessment.k67_readiness_session r WHERE r.class_id=s.erp_course_class_id AND r.student_ref=s.public_id)
  ) SELECT (SELECT count(*) FROM allowed) AS allowed_count,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('studentRef',s.public_id,'name',s.erp_student_name_snapshot,'active',s.status='approved',
    'sessions',COALESCE((SELECT jsonb_agg(jsonb_build_object('createdAt',r.created_at,'submittedAt',r.submitted_at,
      'readingSubmittedAt',r.reading_submitted_at,'writingSubmittedAt',r.writing_submitted_at,
      'sameComputer',r.same_computer,'sameHeadphones',r.same_headphones,'heardConfirmed',r.heard_confirmed,
      'listeningSaved',r.draft_revision>0,'readingSaved',r.reading_revision>0,'writingSaved',r.writing_revision>0,
      'webChecksSaved',r.check_revision>0) ORDER BY r.created_at)
     FROM assessment.k67_readiness_session r WHERE r.class_id=s.erp_course_class_id AND r.student_ref=s.public_id),'[]'::jsonb))
    ORDER BY s.erp_student_name_snapshot) FROM roster s),'[]'::jsonb) AS students`,[classId,email,authorization,scopes]);
  if(Number(value.allowed_count)!==1)fail();return {students:value.students};
 }
 async function detail({classId,studentRef},email,authorization){
  const {rows:[value]}=await pool.query(`${scope}, student AS(
   SELECT s.*,c.erp_class_name_snapshot AS class_code FROM mapping.student_mapping_review s
   JOIN allowed c ON c.erp_course_class_id=s.erp_course_class_id WHERE s.public_id=$5::uuid
  ) SELECT (SELECT count(*) FROM allowed) AS allowed_count,
   (SELECT jsonb_build_object('studentRef',s.public_id,'name',s.erp_student_name_snapshot,'classCode',s.class_code,'active',s.status='approved') FROM student s) AS student,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('internalId',r.id,'createdAt',r.created_at,'expired',r.expires_at<now(),
     'sameComputer',r.same_computer,'sameHeadphones',r.same_headphones,'cacheState',r.cache_state,
     'heardSeconds',r.heard_seconds,'heardConfirmed',r.heard_confirmed,'submittedAt',r.submitted_at,'listeningAnswers',r.answers,
     'readingAnswers',r.reading_draft,'readingSubmittedAt',r.reading_submitted_at,
     'writingText',COALESCE(r.writing_draft->>'text',''),'writingSubmittedAt',r.writing_submitted_at,
     'webChecks',r.check_report,'webChecksAt',r.check_updated_at) ORDER BY r.created_at,r.id)
    FROM assessment.k67_readiness_session r JOIN student s ON s.erp_course_class_id=r.class_id AND s.public_id=r.student_ref),'[]'::jsonb) AS sessions`,[classId,email,authorization,scopes,studentRef]);
  if(Number(value.allowed_count)!==1||!value.student)fail();
  return {student:value.student,sessions:value.sessions.map(({internalId,...row})=>({...row,viewId:createHash('sha256').update('readiness-teacher:'+internalId).digest('hex')}))};
 }
 return {classes:listClasses,students,detail};
}

export function mountReadinessTeacher(app,{pool,config,authenticate,requireContext,limiter,auth}){
 if(!config.readinessEnabled)return;
 const service=createReadinessTeacher({pool,classes:config.readinessClasses||new Set()});
 const classId=z.string().regex(/^[1-9]\d{0,17}$/),query=z.object({classId}).strict();
 for(const [path,schema,method] of [['classes',z.object({}).strict(),'classes'],['students',query,'students'],['students/:studentRef',query.extend({studentRef:z.uuid()}).strict(),'detail']])
  app.get('/api/k67-readiness/v1/teacher/'+path,limiter,authenticate,requireContext,async(req,res,next)=>{
   res.set('Cache-Control','private, no-store');
   const parsed=schema.safeParse({...req.query,...req.params});if(!parsed.success)return res.status(400).json({ok:false,error:'INVALID_QUERY',message:'Yêu cầu xem bài làm quen không hợp lệ.'});
   try{const args=[req.reviewer.email,auth.readAuthorization(req)];res.json({ok:true,...await service[method](...(method==='classes'?args:[parsed.data,...args]))});}
   catch(e){if(e.status)return res.status(e.status).json({ok:false,error:e.code,message:e.message});next(e);}
  });
}
