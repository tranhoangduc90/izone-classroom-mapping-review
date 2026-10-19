import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

// Nhận driver pg, tạo DB mới chỉ trên cluster loopback đã xác nhận; không dùng DB có sẵn.
export async function isolatedSchemaDatabase({pg}){
 assert.equal(process.env.TEACHER_NATIVE_SQL_CONFIRM,'teacher-progress-local-only');
 assert.equal(process.env.TEACHER_NATIVE_SQL_URL,'postgres://k67_fixture_admin@127.0.0.1:55468/postgres');
 const admin=new pg.Pool({connectionString:process.env.TEACHER_NATIVE_SQL_URL,max:1});
 const name='teacher_scope_fixture_'+randomBytes(6).toString('hex');
 await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.TEACHER_NATIVE_SQL_URL);url.pathname='/'+name;
 const pool=new pg.Pool({connectionString:url.href,max:8});
 return{query:(...args)=>pool.query(...args),exec:sql=>pool.query(sql),
  close:async()=>{await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}};
}
