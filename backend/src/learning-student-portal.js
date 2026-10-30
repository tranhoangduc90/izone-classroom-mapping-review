// Cổng học viên tự chọn lớp/tên đã được giao phiếu. Mọi tuyến chỉ đọc, không tạo attempt hoặc cấp token làm bài thi.
import {z} from 'zod';
import {LearningError} from './learning-service.js';
const uuid=z.string().uuid();
const identity=[z.object({accessToken:z.string().regex(/^[A-Za-z0-9_-]{32,200}$/u)}),
  z.object({publicToken:uuid,studentRef:uuid,identityConfirmed:z.literal(true)})];
const writingSchema=z.union(identity.map(schema=>schema.extend({testSlug:z.string().regex(/^term-test-[1-9]\d*$/u),
  resultRef:z.string().regex(/^[0-9a-f]{64}$/u)}).strict()));
const contextSchema=z.object({classId:z.string().regex(/^[1-9]\d{0,18}$/u)}).strict();
const eligible=`assignment.status IN ('published','closed') AND assignment.course_code ~ '^[0-9]{2,3}$'
  AND EXISTS(SELECT 1 FROM learning.form_assignment_roster r WHERE r.assignment_id=assignment.id)`;
export const portalClassesSql=`SELECT assignment.erp_course_class_id::text AS class_id,
  (array_agg(assignment.class_name_snapshot ORDER BY assignment.session_number DESC,assignment.created_at DESC))[1] AS class_name
  FROM learning.form_assignment assignment WHERE ${eligible}
  GROUP BY assignment.erp_course_class_id ORDER BY class_name LIMIT 501;`;
export const portalContextSql=`SELECT DISTINCT ON(roster.student_ref)
  roster.student_ref::text,roster.student_name_snapshot AS name,roster.display_discriminator AS discriminator,
  assignment.public_token::text,assignment.class_name_snapshot AS class_name
  FROM learning.form_assignment assignment JOIN learning.form_assignment_roster roster ON roster.assignment_id=assignment.id
  WHERE assignment.erp_course_class_id=$1::bigint AND ${eligible}
  ORDER BY roster.student_ref,assignment.session_number DESC,assignment.created_at DESC,assignment.id DESC LIMIT 501;`;
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
function parse(schema,body){const result=schema.safeParse(body);if(!result.success)throw new LearningError('STUDENT_PORTAL_INPUT_INVALID','Thông tin gửi lên chưa hợp lệ.',400);return result.data;}
export function registerStudentPortalRoutes(router,{pool,service,testResultReader,limiter}){
  router.get('/student/portal-classes',limiter,route(async(_req,res)=>{
    const {rows}=await pool.query(portalClassesSql);
    if(rows.length>500)throw new LearningError('STUDENT_PORTAL_LIMIT','Danh sách lớp cần được kiểm tra.',503);
    res.set('Cache-Control','no-store');res.json({ok:true,classes:rows.map(row=>({classId:String(row.class_id),name:row.class_name}))});
  }));
  router.post('/student/portal-context',limiter,route(async(req,res)=>{
    const {classId}=parse(contextSchema,req.body),{rows}=await pool.query(portalContextSql,[classId]);
    if(!rows.length)throw new LearningError('STUDENT_PORTAL_CLASS_NOT_READY','Lớp chưa có phiếu học viên để mở.',404);
    if(rows.length>500)throw new LearningError('STUDENT_PORTAL_LIMIT','Danh sách học viên cần được kiểm tra.',503);
    res.set('Cache-Control','no-store');res.json({ok:true,class:{classId,name:rows[0].class_name},students:rows.map(row=>({
      studentRef:row.student_ref,name:row.name,discriminator:row.discriminator||null,publicToken:row.public_token
    })).sort((a,b)=>a.name.localeCompare(b.name,'vi')||a.studentRef.localeCompare(b.studentRef))});
  }));
  router.post('/student/writing-test-result',limiter,route(async(req,res)=>{
    const {testSlug,resultRef,...input}=parse(writingSchema,req.body);
    const journey=await service.getStudentCourseJourney(input);
    const candidates=[...(journey.externalTests||[]),...journey.sessions.map(s=>s.testResult).filter(Boolean)];
    const source=candidates.find(r=>r.testSlug===testSlug&&r.resultRef===resultRef&&r.writing?.status==='ready');
    if(!source||!testResultReader?.readWriting)throw new LearningError('WRITING_RESULT_NOT_READY','Kết quả Writing đã thay đổi hoặc chưa sẵn sàng. Quay lại Hành trình để làm mới.',409);
    const result=await testResultReader.readWriting({classId:journey.class.classId,studentRef:journey.student.studentRef,testSlug,resultRef});
    if(!result)throw new LearningError('WRITING_RESULT_NOT_READY','Chưa mở được bản kết quả này. Quay lại Hành trình để làm mới.',409);
    res.set('Cache-Control','no-store');res.json({ok:true,result:{...result,title:source.title,class:journey.class,student:journey.student,readOnly:true}});
  }));
}
