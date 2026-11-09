import assert from 'node:assert/strict';
import test from 'node:test';
import {AUDIO_MS,CODE,checkpoint,emptyDraft,recoverCheckpoint,issueLease} from '../src/domain.js';

function measuredAttempt(){
 const a={id:'fixture-attempt',no:1,code:CODE,phase:'listening',usedMs:0,draft:emptyDraft()};
 const lease=issueLease(a,'test-tab',0);
 Object.assign(a,{status:'running',usedMs:7040});
 Object.assign(a.lease,{startedAt:0,lastSeen:8477,baselineMs:0,acceptedActiveMs:7040,activated:true,awaitingPlayback:false});
 a.draft={...emptyDraft(),sequence:24,audioPosition:8.034844,activeMs:8035};
 const snapshot={...a.draft,sequence:30,audioPosition:12.032179,activeMs:12032,
  answers:{21:'B'},flags:[21],notes:'keep this draft'};
 return {a,lease,snapshot,clock:12374};
}

test('IC2200: lưu hợp lệ khi các request đến nhanh chậm khác nhau, giữ lượt và nháp',()=>{
 const {a,lease,snapshot,clock}=measuredAttempt(),id=a.id;
 checkpoint(a,snapshot,lease,clock);
 assert.equal(a.usedMs,12032);
 assert.equal(a.id,id);
 assert.equal(a.no,1);
 assert.deepEqual(a.draft,snapshot);
 const next={...snapshot,sequence:31,audioPosition:16.032179,activeMs:16032};
 checkpoint(a,next,lease,clock+3950);
 assert.equal(a.draft.audioPosition,next.audioPosition);
 assert.equal(a.status,'running');
});

test('đồng bộ vẫn chặn tua, active giả, lease hết hạn và không mượn giờ từ lease trước',()=>{
 const {a,lease,snapshot,clock}=measuredAttempt();
 for(const bad of [
  {...snapshot,activeMs:8035},
  {...snapshot,audioPosition:20,activeMs:20000},
  {...snapshot,audioPosition:AUDIO_MS/1000,activeMs:AUDIO_MS,phase:'review'},
 ]){
  assert.throws(()=>checkpoint(structuredClone(a),bad,lease,clock),{code:'AUDIO_POSITION_INVALID'});
 }
 assert.throws(()=>checkpoint(structuredClone(a),snapshot,lease,a.lease.lastSeen+7001),{code:'LEASE_EXPIRED'});
 assert.throws(()=>checkpoint(structuredClone(a),snapshot,{...lease,token:'invalid'},clock),{code:'LEASE_LOST'});
 const newer=structuredClone(a);
 const proof=issueLease(newer,'test-tab',100000);
 Object.assign(newer.lease,{activated:true});
 const forged={...snapshot,sequence:31,audioPosition:15,activeMs:7000};
 assert.throws(()=>checkpoint(newer,forged,proof,101000),{code:'AUDIO_POSITION_INVALID'});
});

test('bản sao lượt đang dừng vẫn phục hồi với cùng ID, mốc audio và nội dung nháp',()=>{
 const {a,lease,snapshot}=measuredAttempt(),id=a.id;
 assert.equal(recoverCheckpoint(a,snapshot,lease,140000),true);
 const proof=issueLease(a,'test-tab',140000);
 assert.equal(a.id,id);
 assert.equal(a.draft.audioPosition,snapshot.audioPosition);
 assert.deepEqual(a.draft.answers,snapshot.answers);
 assert.equal(a.draft.notes,snapshot.notes);
 assert.notEqual(proof.id,lease.id);
 assert.equal(a.usedMs,12032);
});
