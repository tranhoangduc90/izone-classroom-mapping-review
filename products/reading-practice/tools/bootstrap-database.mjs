import pg from 'pg';
import {readFile} from 'node:fs/promises';

// Chỉ vận hành sau duyệt: tạo role riêng bằng mật khẩu từ file riêng tư; không in URL/password.
// Reading có database/container riêng. Nguồn mapping chỉ thêm role/view chỉ đọc, không đổi bảng hiện hành.
const mode=process.argv[2];if(!['reading','owner-source'].includes(mode))throw new Error('Use reading or owner-source mode');
const pool=new pg.Pool({connectionString:process.env.READING_BOOTSTRAP_DATABASE_URL,max:1});
try{
 const expected=mode==='reading'?'reading_practice_db':'mapping_db';
 const role=(await pool.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(role.db!==expected||!role.rolsuper||mode==='reading'&&role.role!=='reading_practice_owner')throw new Error('Wrong database/owner role');
 const name=mode==='reading'?'reading_practice_app':'reading_owner_reader';
 const password=(await readFile(process.env.READING_NEW_ROLE_PASSWORD_FILE,'utf8')).trim();if(password.length<32)throw new Error('Password too short');
 if((await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount)throw new Error('Role exists; preserve its password and inspect grants manually');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${pg.escapeLiteral(password)}`);
  await client.query(`GRANT CONNECT ON DATABASE ${expected} TO ${name}`);
  if(mode==='owner-source')await client.query('ALTER ROLE reading_owner_reader SET default_transaction_read_only=on');
  const migration=mode==='reading'?'001-schema.sql':'002-owner-source.sql';
  await client.query(await readFile(new URL('../db/'+migration,import.meta.url),'utf8'));
  if(mode==='reading'){
   await client.query('REVOKE ALL ON SCHEMA reading_practice FROM PUBLIC');
   await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
   await client.query('GRANT USAGE ON SCHEMA reading_practice TO reading_practice_app');
   await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA reading_practice TO reading_practice_app');
  }
  await client.query('COMMIT');console.log(JSON.stringify({status:'prepared',database:expected,role:name}));
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}finally{await pool.end();}
