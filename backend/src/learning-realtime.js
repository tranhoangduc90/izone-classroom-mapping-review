import {authorizeLearningLiveAssignmentSql} from './learning-sql.js';
import {LearningError} from './learning-service.js';

const ZERO='00000000-0000-0000-0000-000000000000';
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Nhận revision bền vững từ PostgreSQL; trả đúng phần đổi, không tính lại analytics khi chỉ lưu nháp.
export function createLearningLiveUpdates({pool,service,revalidate,enabled=true,streamEnabled=true,classIds=null,
  heartbeatMs=15000,repairMs=10000,coalesceMs=600,maxStreams=300,maxStreamsPerAccount=4,logger=console}) {
  const streams=new Set(),dirty=new Set(),releases=new Set(),bindings=new Map();
  const rollout=classIds?new Set(classIds.map(String)):null;
  let listener=null,connecting=null,closed=false,flushTimer=null,repairTimer=null,repairing=null;
  async function authorize(assignmentId,reviewer,database=pool) {
    if(!enabled) throw new LearningError('LIVE_UPDATES_UNAVAILABLE','Cập nhật trực tiếp đang tạm dừng.',503);
    const access=await database.query(authorizeLearningLiveAssignmentSql,[assignmentId,reviewer.email,reviewer.canAccessAllClasses]);
    if(access.rowCount!==1) throw new LearningError('ASSIGNMENT_ACCESS_DENIED','Phiếu không thuộc phạm vi được cấp quyền.',404);
    if(rollout&&!rollout.has(String(access.rows[0].class_id)))throw new LearningError('LIVE_UPDATES_UNAVAILABLE','Lớp đang dùng nhịp cập nhật hiện hành.',503);
  }
  async function revisions(ids) {
    if(!ids.length)return new Map();
    const rows=await pool.query(`SELECT assignment.id::text AS assignment_id,COALESCE(live.revision,0)::text AS revision
      FROM learning.form_assignment AS assignment LEFT JOIN learning.assignment_live_revision AS live ON live.assignment_id=assignment.id
      WHERE assignment.id=ANY($1::uuid[])`,[ids]);
    return new Map(rows.rows.map(row=>[row.assignment_id,row.revision]));
  }
  async function read({assignmentId,reviewer,after='0',force=false}) {
    const database=await pool.connect();
    try{
    await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='8s'");
    await authorize(assignmentId,reviewer,database);
    const reader=service.readUsing(database);
    // Một statement giữ revision và danh sách đổi cùng snapshot; lần đọc kế tiếp bù mọi commit đến sau đó.
    const result=await database.query(`SELECT COALESCE(live.revision,0)::text AS revision,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',scope,'studentRef',student_ref::text))
        FROM learning.assignment_live_change WHERE assignment_id=$1::uuid AND revision>$2::bigint),'[]'::jsonb) AS changes
      FROM (VALUES(1)) AS singleton(n) LEFT JOIN learning.assignment_live_revision AS live ON live.assignment_id=$1::uuid`,[assignmentId,after]);
    const {revision,changes}=result.rows[0];
    const full=force||BigInt(after)>BigInt(revision);
    const scopes=new Set(full?['dashboard','drafts','analytics']:changes.map(change=>change.scope));
    const refs=changes.filter(change=>change.scope==='drafts').map(change=>change.studentRef);
    const allStudents=full||refs.includes(ZERO);
    const payload={assignmentId,revision,generatedAt:new Date().toISOString(),full,changes};
    const jobs=[];
    if(scopes.has('dashboard'))jobs.push(()=>reader.getTeacherDashboard({assignmentId,reviewer}).then(value=>{payload.dashboard=value;}));
    if(scopes.has('drafts'))jobs.push(()=>reader.getTeacherLiveDrafts({assignmentId,reviewer,studentRefs:allStudents?null:[...new Set(refs)]})
      .then(value=>{payload.live={...value,partial:!allStudents};}));
    if(scopes.has('analytics'))jobs.push(()=>reader.getQuestionAnalytics({assignmentId,reviewer}).then(value=>{payload.analytics=value;}));
    // Không đánh dấu revision mới nếu một vùng chưa đọc được; client giữ bản cũ và thử lại cùng mốc.
    for(const job of jobs)await job();
    await database.query('COMMIT');
    return payload;
    }catch(error){await database.query('ROLLBACK').catch(()=>{});throw error;}
    finally{database.release();}
  }
  function send(stream,event,data) {
    if(stream.res.destroyed||stream.res.writableEnded)return stream.close();
    if(stream.res.writableLength>65536)return stream.close();
    stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  async function flush(ids) {
    try {
      const current=await revisions(ids);
      for(const stream of streams) {
        if(!current.has(stream.assignmentId))continue;
        const revision=current.get(stream.assignmentId);
        if(revision!==stream.revision){stream.revision=revision;send(stream,'change',{assignmentId:stream.assignmentId,revision,notificationsReady:Boolean(listener)});}
      }
      return true;
    }catch {for(const stream of streams)if(ids.includes(stream.assignmentId))send(stream,'unavailable',{message:'Đang đọc bù dữ liệu.'});return false;}
  }
  function changed(id) {
    if(!UUID.test(String(id))||![...streams].some(stream=>stream.assignmentId===id))return;
    dirty.add(id);
    if(!flushTimer)flushTimer=setTimeout(()=>{flushTimer=null;const ids=[...dirty];dirty.clear();void flush(ids);},coalesceMs).unref();
  }
  function loseListener() {
    const prior=listener;listener=null;
    if(prior)releaseListener(prior,true);
    for(const stream of streams)send(stream,'unavailable',{message:'Đang kết nối lại nguồn cập nhật.'});
  }
  function releaseListener(client,destroy=false){
    const handlers=bindings.get(client);if(handlers){for(const [event,handler]of Object.entries(handlers))client.removeListener(event,handler);bindings.delete(client);}
    // Connection đã bỏ có thể còn phát lỗi socket cuối; không để lỗi đó trở thành uncaught và dừng API.
    const ignoreClosedError=()=>{};client.on('error',ignoreClosedError);
    if(destroy){client.release(true);return;}
    let discard=false;
    const pending=client.query('UNLISTEN learning_teacher_live').catch(()=>{discard=true;}).finally(()=>{
      client.release(discard);if(!discard)client.removeListener('error',ignoreClosedError);releases.delete(pending);
    });releases.add(pending);
  }
  async function connect() {
    if(listener||closed||!streams.size)return;
    if(connecting)return connecting;
    connecting=(async()=>{
      const client=await pool.connect();
      try{
        await client.query('LISTEN learning_teacher_live');
        if(closed||!streams.size){await client.query('UNLISTEN learning_teacher_live');client.release();return;}
        listener=client;
        const handlers={notification:message=>{if(message.channel!=='learning_teacher_live')return;try{changed(JSON.parse(message.payload).assignmentId);}catch{}},
          error:()=>{if(listener===client)loseListener();},end:()=>{if(listener===client)loseListener();}};
        bindings.set(client,handlers);for(const [event,handler]of Object.entries(handlers))client.on(event,handler);
      }catch(error){client.release(true);throw error;}
    })().finally(()=>{connecting=null;});
    return connecting;
  }
  async function subscribe(req,res,{assignmentId}) {
    if(!streamEnabled||!revalidate)throw new LearningError('LIVE_STREAM_UNAVAILABLE','Đang dùng cập nhật dự phòng.',503);
    await authorize(assignmentId,req.reviewer);
    if(streams.size>=maxStreams||[...streams].filter(stream=>stream.email===req.reviewer.email).length>=maxStreamsPerAccount)
      throw new LearningError('LIVE_STREAM_LIMIT','Có nhiều màn theo dõi đang mở; dùng cập nhật dự phòng.',429);
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();res.setTimeout(0);req.socket.setKeepAlive(true);
    const stream={res,req,assignmentId,email:req.reviewer.email,revision:null,checking:false,closed:false};
    stream.close=()=>{
      if(stream.closed)return;stream.closed=true;clearInterval(stream.heartbeat);streams.delete(stream);res.end();
      if(!streams.size){clearInterval(repairTimer);repairTimer=null;if(listener){const client=listener;listener=null;releaseListener(client);}}
    };
    streams.add(stream);res.on('close',stream.close);
    // Đăng ký trước khi đọc revision để không lọt commit trong khoảng snapshot–subscribe.
    try{await connect();await flush([assignmentId]);}
    catch{send(stream,'unavailable',{message:'Đang dùng cập nhật dự phòng.'});}
    if(stream.closed)return;
    stream.heartbeat=setInterval(async()=>{
      if(stream.checking||stream.closed)return;stream.checking=true;
      try{
        const reviewer=await revalidate(req);
        if(stream.closed)return;
        if(!reviewer||reviewer.email!==stream.email){send(stream,'access',{status:401});stream.close();return;}
        await authorize(assignmentId,reviewer);
        const current=await flush([assignmentId]);
        if(current&&!stream.closed)send(stream,'heartbeat',{assignmentId,revision:stream.revision,notificationsReady:Boolean(listener),serverTime:new Date().toISOString()});
      }catch(error){if(error.httpStatus===404){send(stream,'access',{status:403});stream.close();}else send(stream,'unavailable',{message:'Chưa xác minh được kết nối.'});}
      finally{stream.checking=false;}
    },heartbeatMs).unref();
    if(!repairTimer)repairTimer=setInterval(()=>{
      if(repairing)return;
      repairing=Promise.all([connect().catch(()=>{}),flush([...new Set([...streams].map(item=>item.assignmentId))])])
        .finally(()=>{repairing=null;});
    },repairMs).unref();
  }
  async function close() {
    closed=true;clearTimeout(flushTimer);clearInterval(repairTimer);
    for(const stream of [...streams])stream.close();
    await connecting?.catch(()=>{});
    await repairing;
    await Promise.all([...releases]);
  }
  return {read,subscribe,close,stats:()=>({streams:streams.size,listeners:listener?1:0})};
}
