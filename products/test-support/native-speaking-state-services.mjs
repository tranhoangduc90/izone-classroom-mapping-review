// Đối chiếu view với toàn bộ source live đã ghim của cả hai kho, chỉ trên DB fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {fileURLToPath} from 'node:url';
const target=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL||'');
assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
assert.match(target.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(target.username,'fixture');assert.equal(target.pathname,'/postgres');
process.env.SPEAKING_STATE_INDEPENDENT_BASE=fileURLToPath(new URL('../../fixtures/speaking-independent-live/src/speaking-independent.js',import.meta.url));
process.env.SPEAKING_STATE_LEGACY_BASE=fileURLToPath(new URL('../../fixtures/speaking-legacy-live/src/speaking-homework.js',import.meta.url));
const call=globalThis.fetch;let externalAttempts=0;
globalThis.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url||input.href);
 if(!['127.0.0.1','localhost'].includes(url.hostname)){externalAttempts++;throw Error('EXTERNAL_FIXTURE_REQUEST_DENIED');}
 return call(input,options);
};
test.after(async()=>{
 const admin=new pg.Client({connectionString:target.href});await admin.connect();
 try{assert.equal(externalAttempts,0);assert.equal((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname LIKE 'speaking_state_fixture_%'")).rows[0].n,0);}
 finally{await admin.end();}
 console.log(JSON.stringify({event:'speaking_state_native_cleanup',fixtureDatabases:0,externalAttempts,closed:true,readerRole:'speaking_state_reader'}));
});
await import('../../backend/test/speaking-observation-data.test.js');
await import('../../backend/test/speaking-observation.test.js');
await import('../../backend/test/speaking-observation-http.test.js');
await import('../../backend/test/speaking-observation-docs.test.js');
await import('../../backend/test/speaking-teacher-capabilities.test.js');
await import('../../backend/test/speaking-observation-admission.test.js');
await import('../../backend/test/speaking-admission-queue.test.js');
await import('../../backend/test/speaking-admission-budgets.test.js');
await import('../../backend/test/speaking-observation-fairness.test.js');
