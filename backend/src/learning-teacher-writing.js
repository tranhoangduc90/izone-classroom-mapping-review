// Phiên giảng viên chỉ đọc kết quả đúng lớp/người/bản đang được cấp quyền.
import {z} from 'zod';
import {LearningError} from './learning-service.js';
const schema=z.object({classId:z.string().regex(/^[1-9]\d{0,18}$/u),studentRef:z.string().uuid(),testSlug:z.string().regex(/^term-test-[1-9]\d*$/u),resultRef:z.string().regex(/^[0-9a-f]{64}$/u)}).strict();
export function registerTeacherWritingResultRoutes(router,{authenticate,service,testResultReader}){
 router.post('/teacher/writing-test-result',authenticate,(req,res,next)=>Promise.resolve().then(async()=>{
  const parsed=schema.safeParse(req.body);if(!parsed.success)throw new LearningError('INVALID_WRITING_RESULT','Thông tin kết quả chưa hợp lệ.',400);
  const input=parsed.data,overview=await service.getCourseOverview({classId:input.classId,reviewer:req.reviewer}),student=overview.students.find(s=>s.studentRef===input.studentRef);
  const sources=student?[...(student.externalTests||[]),...(student.cells||[]).map(c=>c.testResult).filter(Boolean)]:[];
  const source=sources.find(r=>r.testSlug===input.testSlug&&r.resultRef===input.resultRef&&r.writing?.status==='ready');
  if(!source||!testResultReader?.readWriting)throw new LearningError('WRITING_RESULT_NOT_READY','Không tìm thấy kết quả Writing được phép xem. Mở lại Hành trình lớp.',409);
  const result=await testResultReader.readWriting(input);if(!result)throw new LearningError('WRITING_RESULT_NOT_READY','Kết quả Writing đã đổi. Mở lại Hành trình lớp.',409);
  res.set('Cache-Control','no-store');res.json({ok:true,result:{...result,title:source.title,class:{classId:overview.classId,name:overview.className},student:{studentRef:student.studentRef,name:student.name},readOnly:true}});
 }).catch(next));
}
