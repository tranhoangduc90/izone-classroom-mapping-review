import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createListeningService} from '../src/service.js';
import {CODE,secret,uuid,emptyDraft} from '../src/domain.js';

// Chỉ dùng database thử Listening riêng: nhận URL qua môi trường, kiểm 30 phiên và tranh chấp SQL.
// Không gọi Google, không tạo dữ liệu học viên, không chạy trong database bài làm thật.
const pool=new pg.Pool({connectionString:process.env.LISTENING_NATIVE_CHECK_DATABASE_URL,max:8});
try{
 const db=(await pool.query('SELECT current_database() AS db')).rows[0].db;
 if(!/^listening_practice_canary_[a-z0-9_]+$/.test(db))throw new Error('Native check requires a separate canary database');
 if((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='listening_practice'")).rowCount)throw new Error('Canary database already contains a run; preserve it');
 await pool.query(await readFile(new URL('../db/001-schema.sql',import.meta.url),'utf8'));
 const members=Array.from({length:30},()=>({studentRef:uuid(),name:'Học viên thử tải'}));
 let clock=Date.now();
 const context={student:async(c,id)=>c==='1124'?members.find(x=>x.studentRef===id):undefined,roster:async()=>members,teacher:async()=>false};
 const service=createListeningService({pool,context,clock:()=>clock,pageBase:'https://example.test/listening-practice/',verifyBinding:async i=>({fixtureOnly:true,studentRef:i.studentRef,documentId:i.documentId})});
 const key=Object.fromEntries(Array.from({length:10},(_,i)=>[i+21,['A']]));
 await service.seedContent({code:CODE,version:'native-fixture-v1',totalMs:579207,key,explanations:{entries:Object.fromEntries(Object.keys(key).map(n=>[n,{number:+n}]))},definition:{mcq:[21,22,23,24,25].map(n=>({n,text:'Fixture question',options:['A','B','C']})),flow:[26,27,28,29,30].map(n=>[n,'Fixture step',' .']),bank:'ABCDEFGH'.split('').map(n=>[n,'Fixture option']),audio:{durationMs:459207,sha256:'0'.repeat(64)}}});
 const users=[];
 for(const member of members){
  const entryToken=secret();await service.register({classId:'1124',classCode:'NATIVE CANARY',studentRef:member.studentRef,documentId:'native_'+uuid().replaceAll('-',''),tabId:'t.0',contentVersion:'native-fixture-v1',entryToken});
  await pool.query("UPDATE listening_practice.assignment SET status='open'");await pool.query('UPDATE listening_practice.binding SET cta_verified_at=now()');
  const logged=await service.login({entryToken,studentRef:member.studentRef,classCode:'NATIVE CANARY'});users.push({token:logged.token});
 }
 const beginAt=performance.now();
 await Promise.all(users.map(async u=>{const s=await service.begin({token:u.token,owner:'native-check',operationId:uuid()});u.id=s.attempts.at(-1).id;u.lease=s.lease;u.draft=emptyDraft();await service.activate({token:u.token,attemptId:u.id,lease:u.lease});}));
 const startMs=performance.now()-beginAt;clock+=5000;
 const pulseAt=performance.now();
 await Promise.all(users.map(async u=>{u.draft.sequence=1;u.draft.activeMs=5000;u.draft.answers={'21':'A'};const s=await service.pulse({token:u.token,attemptId:u.id,lease:u.lease,snapshot:u.draft});assert.equal(s.attempts.at(-1).usedMs,5000);}));
 const pulseMs=performance.now()-pulseAt;
 await Promise.all(users.map(async u=>{const input={token:u.token,attemptId:u.id,lease:u.lease,snapshot:u.draft};const results=await Promise.allSettled([service.submit({...input,operationId:uuid(),method:'manual'}),service.reset({...input,owner:'native-check',operationId:uuid()})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);}));
 const counts=(await pool.query("SELECT count(*)::int AS bindings,(SELECT count(*)::int FROM listening_practice.operation) AS operations FROM listening_practice.binding")).rows[0];
 assert.equal(counts.bindings,30);
 const mismatch=(await pool.query('SELECT count(*)::int AS n FROM listening_practice.doc_job j LEFT JOIN listening_practice.binding b ON b.id=j.binding_id WHERE b.id IS NULL')).rows[0].n;assert.equal(mismatch,0);
 console.log(JSON.stringify({status:'passed',database:db,concurrentSessions:30,startBatchMs:Math.round(startMs),pulseBatchMs:Math.round(pulseMs),submitResetRaces:30,counts,scope:'Native PostgreSQL; isolated fixture database; no Google or real learners'}));
}finally{await pool.end();}
