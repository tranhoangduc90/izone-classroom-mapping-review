import {openTestObservationStream} from './test-state-runtime.js';
import {SpeakingHomeworkError} from './speaking-homework.js';

// Chỉ gắn khi runtime bật observation. Cookie theo lối native; token HV chỉ ở
// POST body. Snapshot đầu kiểm quyền trước headers; heartbeat không truy vấn DB.
export function mountSpeakingObservationRoutes(router,{observation,z,authenticate,teacherAdmission}){
 if(!observation)return;
 const identity=z.object({accessToken:z.string().regex(/^[A-Za-z0-9_-]{32,200}$/),studentRef:z.string().uuid(),unitId:z.string().uuid().optional()}).strict();
 const scope=z.object({classId:z.string().regex(/^(\d{1,19}|unlinked)$/),classCode:z.string().regex(/^[A-Za-z0-9_-]{2,32}$/).optional(),
  code:z.string().min(3).max(100),unitId:z.string().uuid().optional(),courseId:z.string().regex(/^\d+$/).optional()}).strict();
 const headers=req=>({cookie:req.get('cookie')||'',authorization:req.get('authorization')||'',origin:req.get('origin')||''});
 const nativeError=error=>{
  if(error instanceof SpeakingHomeworkError)return error;
  if(error instanceof z.ZodError)return new SpeakingHomeworkError('INVALID_INPUT','Dữ liệu theo dõi chưa hợp lệ.',400);
  const status=error.status||error.httpStatus||503;
  return new SpeakingHomeworkError(error.code||'STATE_UNAVAILABLE','Chưa đọc được trạng thái mới. Bài đã lưu vẫn được giữ.',[400,401,403,404,409,423,503].includes(status)?status:503);
 };
 async function respond(req,res,pair,{events=false,field='state'}={}){
  const controller=new AbortController(),abort=()=>controller.abort();
  req.once('aborted',abort);res.once('close',abort);
  try{
   const value=await observation.hub.readOnce(pair.scope,pair.guard,{signal:controller.signal});
   if(controller.signal.aborted||res.destroyed)return;
   if(events){openTestObservationStream({response:res,hub:observation.hub,...pair});req.speakingObservationAdmitted?.();}
   else{res.set('Cache-Control','private, no-store');res.json({ok:true,[field]:value});}
  }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
 }
 for(const path of ['status','view','events'])router.post('/observation/student/'+path,async(req,res,next)=>{
  try{const input=identity.parse(req.body);await respond(req,res,observation.student(input,{view:path==='view'}),{events:path==='events',field:path==='view'?'view':'state'});}
  catch(error){if(!res.headersSent)next(nativeError(error));else res.end();}
 });
 for(const path of ['state','events'])router.get('/teacher/progress/'+path,...(authenticate?[authenticate]:[]),async(req,res,next)=>{
  try{
   const input=scope.parse(req.query),native=teacherAdmission?await teacherAdmission(input,headers(req)):{authSource:req.authSource,reviewer:req.reviewer};
   if(native.allowed&&!native.allowed.has(input.classId))throw new SpeakingHomeworkError('TEACHER_ACCESS_DENIED','Tài khoản chưa có quyền xem lớp.',403);
   await respond(req,res,observation.teacher(input,{...native,cookie:req.get('cookie')||''}),{events:path==='events'});
  }catch(error){if(!res.headersSent)next(nativeError(error));else res.end();}
 });
 router.get('/observation/capabilities',(_req,res)=>{
  res.set('Cache-Control','private, no-store');res.json({ok:true,capabilities:{studentStateStream:true,studentCombinedView:true,teacherStateStream:true}});
 });
}
