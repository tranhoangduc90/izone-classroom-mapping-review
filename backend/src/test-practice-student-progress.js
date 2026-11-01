import {openTestObservationStream} from './test-state-runtime.js';
export function withStudentStateCapabilities(value,enabled){
 return enabled&&value?.capabilities?{...value,capabilities:{...value.capabilities,studentStateStream:true,studentStateIntervalMs:30000}}:value;
}
export function mountPracticeStudentProgress(app,{observation,hub,token,z,wrap,fail}){
 if(!hub)return;
 const failure=error=>{const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503;fail(error.status?error.code:'STATE_UNAVAILABLE',status===401?'Phiên bài làm đã hết hiệu lực.':status===403?'Không còn quyền xem bài làm này.':'Chưa đọc được trạng thái kết quả. Hãy thử lại.',status);};
 for(const action of ['status','events'])app.get('/api/student-progress/'+action,wrap(async(req,res)=>{
  const input=z.object({attemptId:z.uuid()}).strict().parse(req.query);let bound;
  try{bound=await observation.studentGuard({...input,token:token(req)});}catch(error){failure(error);}
  if(res.destroyed)return;
  const {scope,guard}=bound;
  if(action==='events'){try{openTestObservationStream({response:res,hub,scope,guard});}catch(error){if(!res.destroyed)failure(error);}return;}
  const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
  try{res.set('Cache-Control','private, no-store');res.json(await hub.readOnce(scope,guard,{signal:controller.signal}));}
  catch(error){if(!controller.signal.aborted&&!res.destroyed)failure(error);}
  finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
 }));
}
