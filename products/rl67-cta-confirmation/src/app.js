import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {EntryError, products, sameSecret} from './service.js';

const uuid=z.uuid();
const product=z.enum(Object.keys(products));
const googleId=z.string().regex(/^\d{1,30}$/);
const prepare=z.object({
  product, assignmentCode:z.string().max(120).regex(/^67-(?:(?:reading|listening)-|practice-(?:reading|listening)_)[A-Za-z0-9_-]+$/),
  fallbackPath:z.string().min(1).max(500), documentId:z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  courseId:googleId,courseWorkId:googleId,submissionId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  googleUserId:googleId,classCode:z.string().regex(/^IC\d{3,8}$/),
}).strict();

export function createApp({service,pool,publisherKeys,enabled=()=>true,origin='https://tranhoangduc90.github.io'}) {
  const app=express();
  app.set('trust proxy',1);
  app.use(helmet());
  app.use(express.json({limit:'8kb'}));
  app.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    res.vary('Origin');
    if(req.get('Origin')===origin) {
      res.set('Access-Control-Allow-Origin',origin);
      res.set('Access-Control-Allow-Methods','POST,OPTIONS');
      res.set('Access-Control-Allow-Headers','content-type');
    }
    if(req.method==='OPTIONS') return res.sendStatus(204);
    next();
  });
  app.get('/health',async(_req,res)=>{
    await pool.query('SELECT 1');
    res.json({ok:true,product:'rl67-cta-confirmation'});
  });
  app.use('/v1',rateLimit({windowMs:60_000,limit:1200,standardHeaders:'draft-8',legacyHeaders:false,
    message:{ok:false,error:'RATE_LIMITED',message:'Vui lòng chờ một phút rồi tải lại.'}}));
  app.use('/v1/confirm',rateLimit({windowMs:60_000,limit:180,standardHeaders:'draft-8',legacyHeaders:false,
    message:{ok:false,error:'RATE_LIMITED',message:'Vui lòng chờ một phút rồi tải lại.'}}));
  const route=(path,shape,run,{internal=false,pausedAllowed=false}={})=>app.post(path,async(req,res)=>{
    const input=shape.parse(req.body);
    const key=internal?publisherKeys[input.product]:null;
    if(internal&&(!key||!sameSecret(req.get('Authorization'),'Bearer '+key))) {
      res.status(401).json({ok:false,error:'UNAUTHORIZED'});
      return;
    }
    if(!pausedAllowed&&!enabled()) {
      res.status(503).json({ok:false,error:'CONFIRMATION_PAUSED',message:'Màn xác nhận chưa mở. Hãy thử lại sau.'});
      return;
    }
    const data=await run(input);
    res.json({ok:true,...data});
  });
  route('/internal/prepare',prepare,service.prepare,{internal:true});
  route('/internal/activate',z.object({id:uuid,product}).strict(),service.activate,{internal:true});
  route('/v1/form',z.object({id:uuid}).strict(),({id})=>enabled()?service.form(id):service.fallback(id),{pausedAllowed:true});
  route('/v1/confirm',z.object({id:uuid,studentRef:uuid,token:z.string().regex(/^\d{13}\.[A-Za-z0-9_-]{43}$/)}).strict(),service.confirm);
  app.use((error,_req,res,_next)=>{
    if(error instanceof EntryError) return res.status(error.status).json({ok:false,error:error.code,message:error.message});
    if(error instanceof z.ZodError||error.type==='entity.parse.failed')
      return res.status(400).json({ok:false,error:'REQUEST_INVALID',message:'Link hoặc lựa chọn chưa hợp lệ.'});
    console.error(JSON.stringify({event:'rl67_confirmation_error',code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'INTERNAL_ERROR'}));
    return res.status(503).json({ok:false,error:'CONFIRMATION_UNAVAILABLE',message:'Chưa mở được màn xác nhận. Hãy thử lại sau.'});
  });
  return app;
}
