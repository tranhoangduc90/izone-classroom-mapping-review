// Chỉ chạy ca nguồn/quyền trên PostgreSQL riêng; không dùng runtime/DB/bài học viên thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {fileURLToPath} from 'node:url';
const task='test-services-optimization-20261101',target=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL||'');
assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,task);
assert.match(target.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(target.username,'fixture');assert.equal(target.pathname,'/postgres');
process.env.SPEAKING_SOURCE_BASE_FILE=fileURLToPath(new URL('../../backend/src/speaking-independent-source.baseline.js',import.meta.url));
process.env.PROGRESS_LOG_FIXTURE_URL=target.href;
const call=globalThis.fetch;let externalAttempts=0;
globalThis.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url||input.href);
 if(!['127.0.0.1','localhost'].includes(url.hostname)){externalAttempts++;throw Error('EXTERNAL_FIXTURE_REQUEST_DENIED');}
 return call(input,options);
};
test.after(async()=>{
 const admin=new pg.Client({connectionString:target.href});await admin.connect();
 try{assert.equal(externalAttempts,0);assert.equal((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname LIKE 'speaking_source_fixture_%' OR datname LIKE 'teacher_observation_fixture_%' OR datname LIKE 'pl_fixture_%'")).rows[0].n,0);}
 finally{await admin.end();}
 console.log(JSON.stringify({event:'speaking_source_native_cleanup',fixtureDatabases:0,externalAttempts,closed:true}));
});
await import('../../backend/test/speaking-source-batch.test.js');
await import('../../backend/test/speaking-source-csrf.test.js');
await import('../../backend/test/auth-observation.test.js');
await import('../../backend/test/auth-cookie-migration.test.js');
await import('../../backend/test/teacher-observation-contract.test.js');
await import('../../backend/test/speaking-teacher-observation.test.js');
await import('../../backend/test/learning-attendance-postgres.test.js');
