import pg from 'pg';
import {z} from 'zod';
import {createOwnerSourceApp} from './owner-source.js';

// Cầu chỉ đọc thuộc nguồn mapping. API Reading gọi HTTP và không giữ credential mapping_db.
const cfg=z.object({LISTENING_OWNER_DATABASE_URL:z.url(),LISTENING_OWNER_KEY:z.string().min(32),LISTENING_OWNER_PORT:z.coerce.number().int().min(1024).max(65535).default(8819)}).parse(process.env);
const pool=new pg.Pool({connectionString:cfg.LISTENING_OWNER_DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:5000});
const role=(await pool.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
if(role.db!=='mapping_db'||role.role!=='listening_owner_reader'||role.rolsuper)throw new Error('Owner source requires dedicated read-only role');
const app=createOwnerSourceApp({pool,key:cfg.LISTENING_OWNER_KEY});
const server=app.listen(cfg.LISTENING_OWNER_PORT,'0.0.0.0');process.on('SIGTERM',async()=>{server.close();await pool.end();});
