import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';

// PostgreSQL nhúng chỉ dùng kiểm thử/local. Mutex mô phỏng một kết nối; production dùng pool pg.
export async function localPool(path){
 const db=new PGlite(path);await db.waitReady;
 let chain=Promise.resolve();
 async function lock(){let unlock;const next=new Promise(resolve=>unlock=resolve),before=chain;chain=next;await before;return unlock;}
 const pool={
  async query(sql,args){const unlock=await lock();try{return await db.query(sql,args);}finally{unlock();}},
  async connect(){const unlock=await lock();return{query:(sql,args)=>db.query(sql,args),release:unlock};},
  async end(){await chain;await db.close();}
 };
 if(!(await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='reading_practice'")).rows.length)
  await db.exec(await readFile(new URL('../db/001-schema.sql',import.meta.url),'utf8'));
 else if(!(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='reading_practice' AND table_name='binding' AND column_name='owner_proof'")).rows.length)
  await db.exec(`ALTER TABLE reading_practice.binding ADD COLUMN owner_proof jsonb NOT NULL DEFAULT '{"fixtureOnly":true}'`);
 await db.exec(await readFile(new URL('../db/003-teacher-session.sql',import.meta.url),'utf8'));
 return pool;
}
