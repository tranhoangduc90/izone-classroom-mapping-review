import express from 'express';
import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {hash} from './domain.js';

// Cầu chỉ đọc: tra chính xác UUID hoặc cặp course/Google user, không nối bằng tên hay thứ tự.
export function createOwnerSourceApp({pool,key}){
 const app=express();app.disable('x-powered-by');
 app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1 FROM listening_owner_api_v1.owner LIMIT 1');res.json({ready:true,product:'listening-owner-source-v1'});}catch{res.sendStatus(503);}});
 app.use('/v1',(req,res,next)=>{
  const value=req.headers['x-listening-owner-key'];
  if(typeof value!=='string'||Buffer.byteLength(value)!==Buffer.byteLength(key)||!timingSafeEqual(Buffer.from(value),Buffer.from(key)))return res.sendStatus(401);
  res.set('Cache-Control','no-store');next();
 });
 function route(path,schema,sql,params){app.get(path,async(req,res)=>{
  const parsed=schema.strict().safeParse(req.query);if(!parsed.success)return res.sendStatus(400);
  try{
   const rows=(await pool.query(sql,params(parsed.data))).rows;if(rows.length!==1)return res.sendStatus(403);
   const row=rows[0],value={apiVersion:1,classId:String(row.class_id),studentRef:row.student_ref,courseId:row.course_id,googleUserId:row.google_user_id};
   res.json({...value,capturedAt:new Date().toISOString(),sourceRevision:hash(JSON.stringify(value))});
  }catch{res.sendStatus(503);}
 });}
 route('/v1/owner',z.object({classId:z.string().regex(/^-?\d{1,19}$/),studentRef:z.uuid()}),
  'SELECT * FROM listening_owner_api_v1.owner WHERE class_id=$1 AND student_ref=$2',p=>[p.classId,p.studentRef]);
 route('/v1/owner-by-classroom',z.object({courseId:z.string().regex(/^\d{1,30}$/),googleUserId:z.string().regex(/^\d{1,30}$/)}),
  'SELECT * FROM listening_owner_api_v1.owner WHERE course_id=$1 AND google_user_id=$2',p=>[p.courseId,p.googleUserId]);
 return app;
}
