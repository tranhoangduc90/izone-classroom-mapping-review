import {z} from 'zod';
import {createTestObservationHub} from './test-state-runtime.js';

const schema=z.object({attemptToken:z.string().uuid()});
// Chỉ đọc trạng thái của đúng lượt đã nộp; không tạo job chấm, ghi Portal hoặc trả bài/điểm.
export const resultStreamStatusSql=`SELECT COALESCE(final.status, 'waiting') AS status
FROM assessment.term_test_attempt AS attempt
LEFT JOIN assessment.term_test_writing_grading_final AS final ON final.attempt_id=attempt.id
WHERE attempt.id=$1::uuid AND attempt.listening_submitted_at IS NOT NULL
AND attempt.writing_submitted_at IS NOT NULL;`;

// Cùng điều kiện quyền đọc theo token; trả khóa tường minh để không ghép theo thứ tự.
export const resultStreamBatchStatusSql=`SELECT attempt.id::text AS attempt_token,
COALESCE(final.status, 'waiting') AS status
FROM assessment.term_test_attempt AS attempt
LEFT JOIN assessment.term_test_writing_grading_final AS final ON final.attempt_id=attempt.id
WHERE attempt.id=ANY($1::uuid[]) AND attempt.listening_submitted_at IS NOT NULL
AND attempt.writing_submitted_at IS NOT NULL;`;

export function registerTermTestResultStream(app,{pool,limiter,
  pollIntervalMs=5000,heartbeatMs=15000,maxDurationMs=300000,maxConnections=64,maxPerAttempt=2}) {
  const owners=new Map();let active=0;
  const hub=createTestObservationHub({interval:pollIntervalMs,maxConnections,read:async({scopes})=>{
    const tokens=[...new Set(scopes.map(scope=>scope.token))],allowed=new Set(tokens),seen=new Set();
    const states=new Map(tokens.map(token=>['result:'+token,{status:null}]));
    const result=await pool.query({text:resultStreamBatchStatusSql,values:[tokens],query_timeout:4000});
    for(const row of result.rows){
      if(!allowed.has(row.attempt_token)||seen.has(row.attempt_token)||typeof row.status!=='string')
        throw Object.assign(Error('RESULT_STATE_INVALID'),{code:'STATE_UNAVAILABLE',status:503});
      seen.add(row.attempt_token);states.set('result:'+row.attempt_token,{status:row.status});
    }
    // Native token là quyền đọc; hàng vắng là unavailable/404, không mượn phiên khác.
    return{sessions:new Map(tokens.map(token=>[token,{}])),states};
  }});
  app.post('/api/term-tests/result/stream',limiter,async(req,res,next)=>{
    const parsed=schema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({ok:false,error:'INVALID_RESULT_TOKEN',message:'Mã kết quả không hợp lệ.'});
    const token=parsed.data.attemptToken.toLowerCase();
    if(active>=maxConnections||(owners.get(token)||0)>=maxPerAttempt)
      return res.status(429).json({ok:false,error:'RESULT_STREAM_BUSY',message:'Kênh cập nhật đang bận; kết quả vẫn được kiểm tra định kỳ.'});
    active++;owners.set(token,(owners.get(token)||0)+1);
    let closed=false,started=false,subscription,heartbeatTimer,closeTimer,finishInitial;
    const initialDone=new Promise(resolve=>{finishInitial=resolve;});
    const cleanup=()=>{
      if(closed)return;closed=true;
      subscription?.close();clearInterval(heartbeatTimer);clearTimeout(closeTimer);finishInitial();
      active--;const count=(owners.get(token)||1)-1;
      if(count)owners.set(token,count);else owners.delete(token);
    };
    res.once('close',cleanup);
    const end=()=>{cleanup();if(!res.destroyed)res.end();};
    const emit=(event,status)=>{if(!closed&&!res.destroyed){
      if(res.writableLength>65536||!res.write(`event: ${event}\ndata: ${JSON.stringify({status})}\n\n`))end();
    }};
    const sendState=value=>{
      if(value==='ready'||value==='review_required'){emit('ready',value);end();return true;}
      if(value===null){emit('close','unavailable');end();return true;}
      return false;
    };
    const failed=error=>{if(closed)return;if(started){emit('close','temporarily_unavailable');end();}else{cleanup();if(!res.destroyed)next(error);}};
    try{
      subscription=hub.subscribe({scope:{key:'result:'+token,token},guard:{hash:token,key:token,verify:()=>true,state:state=>state},send:(event,value)=>{
        if(closed||res.destroyed)return cleanup();
        if(event==='closing'){
          if(started){emit('close','reconnect');end();}
          else{cleanup();res.status(503).json({ok:false,error:'RESULT_STREAM_BUSY',message:'Kênh cập nhật đang đóng; trang sẽ tự nối lại.'});}
          return;
        }
        if(event!=='state')return failed(Object.assign(Error('STATE_UNAVAILABLE'),value));
        try{
          if(!started){
            if(value.status===null){cleanup();res.status(404).json({ok:false,error:'RESULT_NOT_FOUND',message:'Lượt Writing chưa được nộp hoặc không tồn tại.'});return;}
            started=true;res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
            if(sendState(value.status))return;
            emit('waiting','waiting');
            if(closed)return;
            heartbeatTimer=setInterval(()=>{if(!closed&&!res.destroyed&&(res.writableLength>65536||!res.write(': keep-alive\n\n')))end();},heartbeatMs);
            closeTimer=setTimeout(()=>{emit('close','reconnect');end();},maxDurationMs);finishInitial();
          }else sendState(value.status);
        }catch(error){failed(error);}
      }});
      await initialDone;
    }catch(error){failed(error);}
  });
  return{close:()=>hub.close(),snapshot:()=>hub.snapshot()};
}
