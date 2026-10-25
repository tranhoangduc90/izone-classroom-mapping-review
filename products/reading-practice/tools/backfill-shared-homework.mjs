import pg from 'pg';
import {queueSharedHomeworkBackfill} from '../src/shared-homework-backfill.js';

// Mặc định chỉ xem số lượng. --commit mới xếp hàng; worker đọc lại Docs sau ghi.
// --binding=<UUID> giới hạn ca đầu; --code=<mã đã đăng ký> chọn đúng bài mới, mặc định buổi 9.
// Lỗi hiện bằng mã lỗi, không in cấu hình bí mật.
const args=process.argv.slice(2);
if(args.some(a=>a!=='--commit'&&!/^--binding=[0-9a-f-]{36}$/i.test(a)&&!/^--code=[a-z0-9_-]{8,100}$/.test(a)))throw new Error('Invalid argument');
const pool=new pg.Pool({connectionString:process.env.READING_DATABASE_URL,max:1,statement_timeout:10000});
try{
 const role=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
 if(role.db!=='reading_practice_db'||role.role!=='reading_practice_app')throw new Error('Reading database required');
 const pageBase=process.env.READING_PAGE_BASE;if(!pageBase?.endsWith('/'))throw new Error('Reading page base required');
 console.log(JSON.stringify(await queueSharedHomeworkBackfill({pool,pageBase,commit:args.includes('--commit'),bindingId:args.find(a=>a.startsWith('--binding='))?.slice(10)||null,...(args.find(a=>a.startsWith('--code='))?{code:args.find(a=>a.startsWith('--code=')).slice(7)}:{})})));
}catch(e){console.error(JSON.stringify({outcome:'failure',code:e.code||e.name}));process.exitCode=1;}
finally{await pool.end();}
