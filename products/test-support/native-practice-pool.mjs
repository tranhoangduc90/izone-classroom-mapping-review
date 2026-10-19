import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';

// Chỉ cluster local của task; mỗi ca tạo DB riêng và app role không có quyền DDL.
export async function nativePracticePool({pg,schema,dbDirectory}){
 assert.equal(process.env.PRACTICE_NATIVE_CONFIRM,'teacher-progress-local-only');
 assert.equal(process.env.PRACTICE_NATIVE_URL,'postgres://k67_fixture_admin@127.0.0.1:55468/postgres');
 assert.ok(['reading_practice','listening_practice'].includes(schema));
 const appRole=schema+'_fixture_app';
 const admin=new pg.Pool({connectionString:process.env.PRACTICE_NATIVE_URL,max:1});
 const database='teacher_practice_fixture_'+randomBytes(6).toString('hex');
 await admin.query(`CREATE DATABASE ${database}`);
 const ownerUrl=new URL(process.env.PRACTICE_NATIVE_URL);ownerUrl.pathname='/'+database;
 const owner=new pg.Pool({connectionString:ownerUrl.href,max:1});
 let app;
 try{
  await owner.query(await readFile(new URL('001-schema.sql',dbDirectory),'utf8'));
  await owner.query(await readFile(new URL('003-teacher-session.sql',dbDirectory),'utf8'));
  if(schema==='reading_practice')await owner.query(await readFile(new URL('004-shared-entry.sql',dbDirectory),'utf8'));
  await owner.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${appRole}') THEN CREATE ROLE ${appRole} LOGIN; END IF; END $$;
   REVOKE ALL ON DATABASE ${database} FROM PUBLIC;GRANT CONNECT ON DATABASE ${database} TO ${appRole};
   GRANT USAGE ON SCHEMA ${schema} TO ${appRole};
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${appRole};
   GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${appRole};`);
  const appUrl=new URL(ownerUrl);appUrl.username=appRole;
  app=new pg.Pool({connectionString:appUrl.href,max:8,connectionTimeoutMillis:5000});
  const identity=(await app.query('SELECT current_user AS name')).rows[0];assert.equal(identity.name,appRole);
  const nativeEnd=app.end.bind(app);
  app.fixtureEnvironment='local-HTTP-native-PostgreSQL-16-app-role-pool8';
  app.end=async()=>{await nativeEnd();await owner.end();await admin.query(`DROP DATABASE ${database}`);await admin.end();};
  return app;
 }catch(error){if(app)await app.end();else await owner.end();await admin.end();throw error;}
}
