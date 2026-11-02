import {MemoryStore,rateLimit,ipKeyGenerator} from 'express-rate-limit';

const property='speakingFailedAttemptLimit';

// Giữ ngân sách180 lần thử sai/IP và headers native. Chỉ giải phóng khoản tính
// stream sau khi route đã kiểm quyền, đọc snapshot và thực sự gửi headers200.
// Hàng chờ handshake hữu hạn tránh200 người cùng mạng bị coi là180 lỗi đang chờ.
export function createSpeakingAdmission({message,concurrency=16,maxQueuedPerIp=512,maxQueued=1024,queueWaitMs=15000}={}){
 if(![concurrency,maxQueuedPerIp,maxQueued,queueWaitMs].every(value=>Number.isInteger(value)&&value>0))throw Error('SPEAKING_ADMISSION_OPTIONS_INVALID');
 const store=new MemoryStore(),states=new Map();let queued=0;
 const limiter=rateLimit({windowMs:60000,limit:180,store,requestPropertyName:property,standardHeaders:'draft-8',legacyHeaders:false,message});
 const busy=res=>res.status(503).set('Retry-After','1').json({ok:false,error:'OBSERVATION_BUSY',message:'Đang có nhiều lượt kết nối. Bài đã lưu vẫn được giữ; hãy thử lại.'});
 function removeEmpty(state){if(!state.active&&!state.queue.length&&states.get(state.key)===state)states.delete(state.key);}
 async function dispatch(state){
  if(state.dispatching||!state.queue.length)return;state.dispatching=true;
  try{
   const current=await store.get(state.key);
   let available=Math.max(0,180-(current?.totalHits||0)-state.reserved);
   // Có request đang xác minh: đợi kết quả trước khi dùng hết ngân sách còn lại.
   // Đã đủ180 lỗi và không còn request đang chạy: cho limiter native trả429.
   if(!available&&!state.active)available=1;
   while(state.active<concurrency&&state.queue.length&&available-->0){const entry=state.queue.shift();queued--;entry.start();}
  }catch{for(const entry of [...state.queue])entry.reject();}
  finally{state.dispatching=false;removeEmpty(state);}
 }
 function middleware(req,res,next){
  let released=false,entry=null;
  function releaseSuccessfulCharge(){
   const info=req[property];if(released||!info)return;released=true;
   // Không trừ lỗi của cửa sổ mới khi một stream cũ kết thúc sau60giây.
   if(info.resetTime&&Date.now()>=info.resetTime.getTime())return;
   void store.decrement(info.key).catch(()=>{});
  }
  function finishSlot(){entry?.finish();}
  res.once('finish',()=>{if(res.statusCode<400)releaseSuccessfulCharge();finishSlot();});
  res.once('close',finishSlot);
  req.speakingObservationAdmitted=()=>{
   if(!res.headersSent||res.statusCode>=400)return;
   releaseSuccessfulCharge();finishSlot();
  };
  const run=()=>limiter(req,res,error=>{entry.charged();if(error)return next(error);if(!res.destroyed&&!res.writableEnded)next();});
  const key=ipKeyGenerator(req.ip);let state=states.get(key);
  if(!state){state={key,active:0,reserved:0,queue:[],dispatching:false};states.set(key,state);}
  let started=false,finished=false,reserved=false,deadline;
  entry={start(){if(finished)return;started=true;reserved=true;clearTimeout(deadline);state.active++;state.reserved++;run();},
   charged(){if(reserved){reserved=false;state.reserved--;}},reject(){entry.finish();if(!res.destroyed&&!res.writableEnded)busy(res);},finish(){
   if(finished)return;finished=true;clearTimeout(deadline);
   entry.charged();if(started)state.active--;else{const index=state.queue.indexOf(entry);if(index>=0){state.queue.splice(index,1);queued--;}}
   void dispatch(state);removeEmpty(state);
  }};
  if(state.queue.length>=maxQueuedPerIp||queued>=maxQueued){finished=true;removeEmpty(state);return busy(res);}
  state.queue.push(entry);queued++;
  deadline=setTimeout(()=>{entry.finish();if(!res.destroyed&&!res.writableEnded)busy(res);},queueWaitMs);deadline.unref?.();
  void dispatch(state);
 }
 middleware.snapshot=()=>({ips:states.size,queued,active:[...states.values()].reduce((sum,state)=>sum+state.active,0)});
 return middleware;
}
