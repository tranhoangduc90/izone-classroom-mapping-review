import {ListeningError,hash,secret} from './domain.js';

const DAY=86400000;

// Nhận phiên từ cookie hoặc tab cũ; chỉ lưu hash trong SQL, gia hạn sau kiểm quyền và thu hồi khi đăng xuất.
export function createTeacherSessions({pool,cookiePath}){
 function tokens(req){
  const cookie=/(?:^|;\s*)listening_teacher=([\w-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
  const bearer=/^Bearer ([\w-]{43})$/.exec(req.headers.authorization||'')?.[1];
  return [...new Set([cookie,bearer].filter(Boolean))];
 }
 function writeCookie(req,res,value,row){
  const secure=req.secure;
  const options={httpOnly:true,secure,partitioned:secure,sameSite:secure?'none':'lax',path:cookiePath};
  if(row?.remembered)options.maxAge=Math.max(0,new Date(row.expires_at).getTime()-Date.now());
  if(!value)options.maxAge=0;
  res.cookie('listening_teacher',value,options);
 }
 async function create(req,res,identity,remember){
  const value=secret(),duration=remember?90*DAY:3600000,absolute=remember?365*DAY:3600000;
  const result=await pool.query(`INSERT INTO listening_practice.teacher_session
   (token_hash,email,google_subject,expires_at,absolute_expires_at,remembered)
   VALUES($1,$2,$3,now()+($4::double precision*interval '1 millisecond'),
    now()+($5::double precision*interval '1 millisecond'),$6) RETURNING expires_at,remembered`,
   [hash(value),identity.email.toLowerCase(),identity.sub,duration,absolute,remember]);
  writeCookie(req,res,value,result.rows[0]);
  return{email:identity.email,token:value};
 }
 async function read(req){
  for(const value of tokens(req)){
   const result=await pool.query(`SELECT email,google_subject,expires_at,absolute_expires_at,remembered
    FROM listening_practice.teacher_session WHERE token_hash=$1 AND expires_at>now() AND absolute_expires_at>now()`,[hash(value)]);
   if(result.rows[0])return{...result.rows[0],value};
  }
  throw new ListeningError('TEACHER_LOGIN_REQUIRED','Giảng viên cần đăng nhập Google.',401);
 }
 async function refresh(req,res,session){
  const result=await pool.query(`UPDATE listening_practice.teacher_session SET expires_at=
   CASE WHEN remembered THEN LEAST(absolute_expires_at,now()+interval '90 days') ELSE expires_at END
   WHERE token_hash=$1 AND expires_at>now() AND absolute_expires_at>now() RETURNING expires_at,remembered`,[hash(session.value)]);
  if(!result.rows[0])throw new ListeningError('TEACHER_LOGIN_REQUIRED','Giảng viên cần đăng nhập Google.',401);
  writeCookie(req,res,session.value,result.rows[0]);
 }
 async function logout(req,res){
  await pool.query('DELETE FROM listening_practice.teacher_session WHERE token_hash=ANY($1::text[])',[tokens(req).map(hash)]);
  writeCookie(req,res,'');
 }
 return{create,read,refresh,logout};
}
