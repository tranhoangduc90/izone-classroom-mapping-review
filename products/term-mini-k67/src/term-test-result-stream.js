import {z} from 'zod';

const schema=z.object({attemptToken:z.string().uuid()});
// Chỉ đọc trạng thái của đúng lượt đã nộp; không tạo job chấm, ghi Portal hoặc trả bài/điểm.
export const resultStreamStatusSql=`SELECT COALESCE(final.status, 'waiting') AS status
FROM assessment.term_test_attempt AS attempt
LEFT JOIN assessment.term_test_writing_grading_final AS final ON final.attempt_id=attempt.id
WHERE attempt.id=$1::uuid AND attempt.listening_submitted_at IS NOT NULL
AND attempt.writing_submitted_at IS NOT NULL;`;

export function registerTermTestResultStream(app,{pool,limiter,
  pollIntervalMs=5000,heartbeatMs=15000,maxDurationMs=300000,maxConnections=64,maxPerAttempt=2}) {
  const owners=new Map();let active=0;
  app.post('/api/term-tests/result/stream',limiter,async(req,res,next)=>{
    const parsed=schema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({ok:false,error:'INVALID_RESULT_TOKEN',message:'Mã kết quả không hợp lệ.'});
    const token=parsed.data.attemptToken;
    if(active>=maxConnections||(owners.get(token)||0)>=maxPerAttempt)
      return res.status(429).json({ok:false,error:'RESULT_STREAM_BUSY',message:'Kênh cập nhật đang bận; kết quả vẫn được kiểm tra định kỳ.'});
    active++;owners.set(token,(owners.get(token)||0)+1);
    let closed=false,pollTimer,heartbeatTimer,closeTimer;
    const cleanup=()=>{
      if(closed)return;closed=true;
      clearTimeout(pollTimer);clearInterval(heartbeatTimer);clearTimeout(closeTimer);
      active--;const count=(owners.get(token)||1)-1;
      if(count)owners.set(token,count);else owners.delete(token);
    };
    res.once('close',cleanup);
    const end=()=>{cleanup();if(!res.destroyed)res.end();};
    const emit=(event,status)=>{if(!closed&&!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify({status})}\n\n`);};
    const status=async()=>{
      // Hạn truy vấn giữ một request chậm không chiếm pool vô hạn; không đọc JSON nhận xét.
      const result=await pool.query({text:resultStreamStatusSql,values:[token],query_timeout:4000});
      return result.rowCount===1?result.rows[0].status:null;
    };
    const sendState=value=>{
      if(value==='ready'||value==='review_required'){emit('ready',value);end();return true;}
      if(value===null){emit('close','unavailable');end();return true;}
      return false;
    };
    try {
      const initial=await status();
      if(closed||res.destroyed)return;
      if(initial===null){cleanup();return res.status(404).json({ok:false,error:'RESULT_NOT_FOUND',message:'Lượt Writing chưa được nộp hoặc không tồn tại.'});}
      res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.flushHeaders();
      if(sendState(initial))return;
      emit('waiting','waiting');
      heartbeatTimer=setInterval(()=>{if(!closed&&!res.destroyed)res.write(': keep-alive\n\n');},heartbeatMs);
      closeTimer=setTimeout(()=>{emit('close','reconnect');end();},maxDurationMs);
      const poll=async()=>{
        if(closed)return;
        try {const value=await status();if(closed||sendState(value))return;}
        catch {emit('close','temporarily_unavailable');end();return;}
        // Hẹn sau khi đọc xong để không có hai truy vấn của cùng stream chạy chồng.
        pollTimer=setTimeout(poll,pollIntervalMs);
      };
      pollTimer=setTimeout(poll,pollIntervalMs);
    }catch(error){cleanup();if(!res.destroyed)next(error);}
  });
}
