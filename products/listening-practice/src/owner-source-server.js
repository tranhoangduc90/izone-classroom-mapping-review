import pg from 'pg';
import express from 'express';
import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {hash} from './domain.js';

// Cầu chỉ đọc thuộc nguồn mapping. API Reading gọi HTTP và không giữ credential mapping_db.
const cfg=z.object({LISTENING_OWNER_DATABASE_URL:z.url(),LISTENING_OWNER_KEY:z.string().min(32),LISTENING_OWNER_PORT:z.coerce.number().int().min(1024).max(65535).default(8819)}).parse(process.env);
const pool=new pg.Pool({connectionString:cfg.LISTENING_OWNER_DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:5000});
const role=(await pool.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
if(role.db!=='mapping_db'||role.role!=='listening_owner_reader'||role.rolsuper)throw new Error('Owner source requires dedicated read-only role');
const app=express();app.disable('x-powered-by');
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1 FROM listening_owner_api_v1.owner LIMIT 1');res.json({ready:true,product:'listening-owner-source-v1'});}catch{res.sendStatus(503);}});
app.get('/v1/owner',async(req,res)=>{
 const key=req.headers['x-listening-owner-key'];
 if(typeof key!=='string'||Buffer.byteLength(key)!==Buffer.byteLength(cfg.LISTENING_OWNER_KEY)||!timingSafeEqual(Buffer.from(key),Buffer.from(cfg.LISTENING_OWNER_KEY)))return res.sendStatus(401);
 const parsed=z.object({classId:z.string().regex(/^-?\d{1,19}$/),studentRef:z.uuid()}).strict().safeParse(req.query);if(!parsed.success)return res.sendStatus(400);
 try{const {classId,studentRef}=parsed.data;
  const rows=(await pool.query('SELECT * FROM listening_owner_api_v1.owner WHERE class_id=$1 AND student_ref=$2',[classId,studentRef])).rows;
  if(rows.length!==1)return res.sendStatus(403);
  const row=rows[0],value={apiVersion:1,classId,studentRef,courseId:row.course_id,googleUserId:row.google_user_id};
  res.set('Cache-Control','no-store').json({...value,capturedAt:new Date().toISOString(),sourceRevision:hash(JSON.stringify(value))});
 }catch{res.sendStatus(503);}
});
const server=app.listen(cfg.LISTENING_OWNER_PORT,'0.0.0.0');process.on('SIGTERM',async()=>{server.close();await pool.end();});
