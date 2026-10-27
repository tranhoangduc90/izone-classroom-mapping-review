import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const source=process.env.K56_RUNTIME_SOURCE;
if(!source)throw Error('K56_RUNTIME_SOURCE must point to a captured isolated runtime src directory');
const {checkpointK56ListeningAudio}=await import(pathToFileURL(source+'/k56-listening-audio-recovery.js'));
// The storage stub supplies the row already locked by the real function. It does
// not implement ownership checks. This regression tests that function's decision,
// not PostgreSQL locking or an actual media device.
function fixture(slug){
 const now=new Date(),id=randomUUID(),owner=randomUUID(),writes=[];
 const row={id,test_slug:slug,generation:0,server_now:now,listening_started_at:new Date(+now-60000),listening_deadline_at:new Date(+now+600000),
  listening_audio_checkpoint_seconds:20,listening_audio_checkpoint_at:now,listening_recovery_seconds:0,listening_audio_owner_id:owner,
  listening_audio_interruption_id:null,listening_audio_legacy_recovery_id:null,audio_state_revision:1,student_name_snapshot:'Fictional',attempt_id:null};
 const db={release(){},async query(sql,args){
  if(/^\s*(?:UPDATE|INSERT)\b/.test(sql)){writes.push({sql,args});return {rows:[row],rowCount:1};}
  if(/SELECT \*, now\(\)/.test(sql))return {rows:[structuredClone(row)],rowCount:1};
  return {rows:[],rowCount:0};
 }};
 return {row,writes,pool:{connect:async()=>db},input:{token:id,slug,heardSeconds:20,state:'resume',recoveryId:randomUUID(),audioStateRevision:1,generation:0,audioOwnerId:randomUUID(),listeningDurationSeconds:120}};
}
for(const slug of ['term-test-1-k56','term-test-2-k56','mini-test-k56'])test(`${slug}: another device cannot claim a playing owner through resume`,async()=>{
 const f=fixture(slug);await assert.rejects(checkpointK56ListeningAudio(f.pool,f.input),e=>e.code==='AUDIO_OWNER_CONFLICT');assert.equal(f.writes.length,0);
});
test('same owner reload remains compatible with controller v2',async()=>{
 const f=fixture('term-test-1-k56');f.input.audioOwnerId=f.row.listening_audio_owner_id;
 assert.equal((await checkpointK56ListeningAudio(f.pool,f.input)).audio_recovery_version,2);assert.ok(f.writes.length>0);
});
test('a held incident does not silently transfer to another device without teacher release',async()=>{
 const f=fixture('term-test-1-k56');f.row.listening_audio_interruption_id=randomUUID();
 f.row.listening_audio_interrupted_at=f.row.server_now;f.row.listening_audio_interrupted_seconds=20;
 await assert.rejects(checkpointK56ListeningAudio(f.pool,f.input),e=>e.code==='AUDIO_OWNER_CONFLICT');assert.equal(f.writes.length,0);
});
test('teacher-cleared owner adopts the acknowledged stop id without resetting its checkpoint',async()=>{
 const f=fixture('term-test-1-k56');f.row.listening_audio_owner_id=null;f.row.listening_audio_interruption_id=randomUUID();
 f.row.listening_audio_interrupted_at=f.row.server_now;f.row.listening_audio_interrupted_seconds=20;
 const result=await checkpointK56ListeningAudio(f.pool,f.input);
 assert.equal(result.audio_recovery_version,2);
 const receipt=f.writes.find(x=>x.sql.includes('INSERT INTO assessment.term_test_audio_recovery_receipt'));
 assert.equal(receipt.args[1],f.row.listening_audio_interruption_id);assert.equal(receipt.args[2],0);
});
