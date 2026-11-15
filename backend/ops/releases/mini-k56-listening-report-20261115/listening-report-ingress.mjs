const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const miniAudioHash='93a3901c37fb37a8eb2ec989ef8d382810d4dc99e6b6506a8377fac68dc756ab';
const audibleWindows=[[0.75,14.5],[45.5,226.25],[230.5,236],[257,402.25],[406,410.5],[441.25,442.25]];
const maximumBase64=4*Math.ceil(400*1024/3);
const allowed=new Set(['attemptToken','examSessionToken','ownerId','generation','operationId','mode',
  'audioHash','positionSeconds','reportedAt','pngBase64','incidentId']);
const localTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
});
const field=(text,length)=>[...String(text||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim()].slice(0,length).join('');
function isUuid(value) { return typeof value==='string' && uuid.test(value); }
function failure(code,status){ return Object.assign(new Error(code),{status,code}); }
function utc(value) {
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  return Date.parse(value);
}

function parse(body) {
  if(!body || Object.getPrototypeOf(body)!==Object.prototype || Object.keys(body).some(key=>!allowed.has(key))
      || !['offline','online'].includes(body.mode) || !Number.isSafeInteger(body.generation) || body.generation<0
      || ![body.attemptToken,body.examSessionToken,body.ownerId,body.operationId].every(isUuid)
      || (body.incidentId!==undefined && !isUuid(body.incidentId))
      || body.audioHash!==miniAudioHash || !Number.isFinite(body.positionSeconds)
      || !audibleWindows.some(([from,to])=>body.positionSeconds>=from && body.positionSeconds<to)
      || !Number.isFinite(utc(body.reportedAt))) throw failure('LISTENING_REPORT_INVALID',400);
  let png=null;
  if(body.pngBase64!==undefined) {
    if(typeof body.pngBase64!=='string' || body.pngBase64.length>maximumBase64
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.pngBase64)) throw failure('LISTENING_REPORT_IMAGE_INVALID',400);
    png=Buffer.from(body.pngBase64,'base64');
    if(png.toString('base64')!==body.pngBase64) throw failure('LISTENING_REPORT_IMAGE_INVALID',400);
  }
  if(body.incidentId && !png) throw failure('LISTENING_REPORT_IMAGE_INVALID',400);
  return {body,png};
}

export function createMiniListeningReportIngress({resolveReport,queue}) {
  return async function submitReport(payload, capability) {
    const {body,png}=parse(payload);
    const verified=await resolveReport(body,capability);
    if(!verified) throw failure('LISTENING_REPORT_SCOPE_MISMATCH',403);
    const occurredAt=Number(verified.reportTimeMs),start=Number(verified.startedAtMs);
    const reported=utc(body.reportedAt);
    if(!Number.isFinite(occurredAt) || !Number.isFinite(start)
        || start>occurredAt || Math.abs(occurredAt-reported)>10000
        || occurredAt>Date.now()+10000 || occurredAt<Date.now()-86400000) throw failure('LISTENING_REPORT_TIME_MISMATCH',409);
    const who=field(verified.studentName,130);
    const group=field(verified.className,70);
    if(!who || !group) throw failure('LISTENING_REPORT_IDENTITY_MISSING',409);

    const scope={attemptId:body.attemptToken,generation:body.generation};
    const schedule=field(verified.scheduledSlot,130) || 'Bắt đầu Listening lúc '+localTime.format(start)+' (ca chưa đối soát lịch)';
    const caption=[
      'Báo sự cố Listening · Mini Test K56',
      'Học viên: '+who,
      'Lớp: '+group,
      'Ca: '+schedule,
      'Bấm báo: '+localTime.format(reported)+' (giờ Việt Nam)',
      'Audio: '+body.positionSeconds.toFixed(1)+' giây',
      'Xử lý: '+(body.mode==='offline'?'Đã ghi biên nhận gián đoạn.':'Đã ghi nhận dừng audio.'),
      'Ảnh dựng từ vùng thi lúc báo.',
    ].join('\n');
    try {
      if(body.incidentId) {
        if(!await queue.attachPhoto({scope,incidentId:body.incidentId,operationId:body.operationId,png})) {
          throw failure('LISTENING_REPORT_IMAGE_NOT_ATTACHED',409);
        }
        return {incidentId:body.incidentId,status:'photo_queued'};
      }
      return await queue.enqueue({scope,operationId:body.operationId,caption,png});
    } catch(error) {
      if(error instanceof TypeError) throw failure('LISTENING_REPORT_IMAGE_INVALID',400);
      throw error;
    }
  };
}

export function mountMiniListeningReportIngress(router,{limiter,resolveReport,queue,allowReporting,observe=()=>{}}) {
  const submit=createMiniListeningReportIngress({resolveReport,queue});
  router.post('/mini-test-k56/listening/report',limiter,async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!allowReporting())return res.status(503).json({ok:false,error:'LISTENING_REPORT_PAUSED'});
    try {
      const result=await submit(req.body,req.get('x-term2-permit'));
      try{observe({attemptId:req.body.attemptToken,operationId:req.body.operationId,
        generation:req.body.generation,mode:req.body.mode,phase:'enqueue',...result});}catch{}
      res.status(202).json({ok:true,...result});
    } catch(error) {
      if(!error.status) return next(error);
      res.status(error.status).json({ok:false,error:error.code});
    }
  });
}
