import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {assertAudioOwner} from '../audio-owner.js';
import {createTelegramAlertSender} from './telegram-alerts.mjs';
import {term2ListeningReportMap as audio} from './listening-report-map-v1.mjs';
import {createTerm2K67ListeningReportQueue} from './listening-report-queue.mjs';

const uuid=z.uuid();
const hexProof=z.string().regex(/^[a-f0-9]{64}$/);
const core=z.object({examSessionToken:uuid,generation:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operationId:uuid,audioHash:z.literal(audio.sha256),positionSeconds:z.number().finite().min(0).max(audio.duration),
  reportedAt:z.iso.datetime(),pngBase64:z.string().max(550000).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional()});
const input=z.discriminatedUnion('mode',[
  core.extend({mode:z.literal('journey'),deviceProof:hexProof}).strict(),
  core.extend({mode:z.literal('online'),ownerId:uuid.optional(),ownerProof:hexProof.optional(),
    pageId:uuid.optional(),ownerEpoch:z.number().int().nonnegative().optional()}).strict()
]);
const formalTime=new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'short',timeStyle:'medium'});
const field=(text,max)=>Array.from(String(text||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim()).slice(0,max).join('');
const hash=proof=>createHash('sha256').update(proof).digest('hex');
const failure=(status,code)=>Object.assign(Error(code),{status,code});

function assertJourneyPermission(row,body,permit,secret) {
  if(!row.device_hash||!row.activated_at||row.audio_hash!==audio.sha256||row.device_hash!==hash(body.deviceProof)
    ||!hexProof.safeParse(permit).success)throw failure(403,'LISTENING_REPORT_SCOPE_MISMATCH');
  const signed=createHmac('sha256',secret).update(['term2-k67-cbt-journey-v1',row.id,row.generation,
    row.student_ref,row.device_hash,row.audio_hash].join(':')).digest();
  if(!timingSafeEqual(signed,Buffer.from(permit,'hex')))throw failure(403,'LISTENING_REPORT_SCOPE_MISMATCH');
  const receipt=row.listening_receipt;
  if(!receipt)throw failure(409,'LISTENING_REPORT_WAITING');
  if(receipt.operationId!==body.operationId||receipt.outcome!=='interrupted'||receipt.generation!==body.generation)
    throw failure(403,'LISTENING_REPORT_SCOPE_MISMATCH');
  return Number(receipt.capturedAt);
}

export function createReportHandler({query,secret,queue,observe=()=>{},clock=Date.now}) {
  return async function submit(payload,permit) {
    const parsed=input.safeParse(payload);
    if(!parsed.success || !audio.audibleWindows.some(([from,to])=>payload.positionSeconds>=from&&payload.positionSeconds<to))
      throw failure(400,'LISTENING_REPORT_INVALID');
    const body=parsed.data;
    const row=(await query(`SELECT s.id,s.generation,s.class_name_snapshot,s.student_name_snapshot,s.listening_started_at,
      s.audio_owner_protocol,s.audio_owner_id,s.audio_owner_proof_hash,s.audio_owner_epoch,
      j.device_hash,j.student_ref,j.activated_at,j.audio_hash,
      j.sections->'listening' AS listening_receipt,
      e.opened_at AS report_opened_at,e.reason AS report_reason,e.request_payload AS report_request
      FROM assessment.term_test_exam_session s
      LEFT JOIN assessment.term_k67_cbt_journey j ON j.session_id=s.id AND j.generation=s.generation
      LEFT JOIN assessment.term_test_audio_incident e ON e.exam_session_id=s.id AND e.incident_id=$3
      WHERE s.id=$1 AND s.test_slug='term-test-2' AND s.generation=$2 AND s.superseded_at IS NULL
        AND s.attempt_mode IN ('legacy','cbt')`,[body.examSessionToken,body.generation,body.operationId])).rows[0];
    if(!row)throw failure(403,'LISTENING_REPORT_SCOPE_MISMATCH');

    const reported=Date.parse(body.reportedAt),received=clock();
    let accepted;
    if(body.mode==='journey') {
      accepted=assertJourneyPermission(row,body,permit,secret);
    } else {
      try{assertAudioOwner(row,body);}catch{throw failure(403,'LISTENING_REPORT_SCOPE_MISMATCH');}
      if(!row.report_opened_at)throw failure(409,'LISTENING_REPORT_WAITING');
      if(row.report_reason!=='manual'||!Number.isFinite(row.report_request?.heardSeconds)
        ||Math.abs(row.report_request.heardSeconds-body.positionSeconds)>2)
        throw failure(403,'LISTENING_REPORT_SCOPE_MISMATCH');
      accepted=Date.parse(row.report_opened_at);
    }

    const knownStart=body.mode==='journey'?(row.listening_receipt?.startedAt??null):row.listening_started_at;
    const started=typeof knownStart==='number'?knownStart:Date.parse(knownStart||row.activated_at);
    const who=field(row.student_name_snapshot,130),group=field(row.class_name_snapshot,70);
    if(!who||!group||!Number.isFinite(started))throw failure(409,'LISTENING_REPORT_IDENTITY_MISSING');
    if(!Number.isFinite(accepted)||reported<started-10000||reported>accepted+10000||reported>received+10000
      ||reported<received-86400000||(body.mode==='journey'&&Math.abs(accepted-reported)>10000))
      throw failure(409,'LISTENING_REPORT_TIME_MISMATCH');
    const png=body.pngBase64?Buffer.from(body.pngBase64,'base64'):null;
    if(png&&png.toString('base64')!==body.pngBase64)throw failure(400,'LISTENING_REPORT_IMAGE_INVALID');
    const scope={attemptId:row.id,generation:body.generation};
    const caption=[
      'Báo sự cố Listening · Term Test 2 K67',
      'Học viên: '+who,
      'Lớp: '+group,
      'Ca: '+(knownStart?'Bắt đầu Listening lúc ':'Mở bài lúc ')+formalTime.format(started)+' (ca chưa đối soát lịch)',
      'Bấm báo: '+formalTime.format(reported)+' (giờ Việt Nam)',
      ...(received-reported>10000?['Máy chủ nhận: '+formalTime.format(received)+' (giờ Việt Nam)']:[]),
      'Audio: '+body.positionSeconds.toFixed(1)+' giây',
      'Xử lý: '+(body.mode==='journey'?'Đã ghi biên nhận gián đoạn.':'Đã ghi nhận giữ bài và mốc nghe.'),
      ...(png?['Ảnh dựng từ vùng thi lúc báo.']:['Chưa tạo được ảnh từ vùng thi.']),
    ].join('\n');
    try {
      const result=await queue.enqueue({scope,operationId:body.operationId,caption,png});
      try{observe({sessionId:row.id,generation:body.generation,operationId:body.operationId,mode:body.mode,
        phase:'enqueue',...result});}catch{}
      return result;
    } catch (error) {
      if(error instanceof TypeError)throw failure(400,'LISTENING_REPORT_IMAGE_INVALID');
      throw error;
    }
  };
}

const policyActive=filename=>{
  try{return Boolean(filename)&&JSON.parse(readFileSync(filename,'utf8')).enabled===true;}
  catch{return false;}
};

export function armTerm2K67Reports({app,query,secret,limiter,observe,env=process.env,sender}) {
  const credentialFile=env.TERM2_K67_LISTENING_REPORT_TELEGRAM_FILE,policy=env.TERM2_K67_LISTENING_REPORT_POLICY_FILE;
  const send=sender||(credentialFile&&policy?createTelegramAlertSender({credentialFile,preferIPv4:true}):null);
  if(!send?.photo)return;
  const active=()=>Boolean(sender)||policyActive(policy);
  const queue=createTerm2K67ListeningReportQueue({query,sendPhoto:send.photo,
    sendText:({id,text})=>send({id,text,nodeId:'term2-k67-listening',severity:'warning'})});
  const submit=createReportHandler({query,secret,queue,observe});
  let ready=false,busy=false,nextSweep=0;
  async function tick(){
    if(busy||!active())return;
    busy=true;
    try {
      if(!ready){
        await query('SELECT incident_id FROM assessment.term2_k67_listening_report LIMIT 0');
        await send.checkAuthorization();
        ready=true;
      }
      if(Date.now()>=nextSweep){await queue.expire();nextSweep=Date.now()+60000;}
      const item=await queue.runOne();
      if(item)observe({sessionId:item.attemptId,...item});
    }catch{/* A provider failure belongs only to the reporting queue. */}
    finally{busy=false;}
  }
  const interval=setInterval(tick,3000);
  interval.unref?.();
  void tick();
  app.post('/api/term-tests/term-test-2/listening/report',limiter,async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!ready||!active())return res.status(503).json({ok:false,error:'LISTENING_REPORT_PAUSED'});
    try{
      const result=await submit(req.body,req.get('x-term2-permit'));
      res.status(202).json({ok:true,...result});
    }catch(error){
      if(!error.status)return next(error);
      res.status(error.status).json({ok:false,error:error.code});
    }
  });
  return {enabled:()=>ready&&active(),close:()=>clearInterval(interval)};
}
