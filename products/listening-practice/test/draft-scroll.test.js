import test from 'node:test';
import assert from 'node:assert/strict';
import {checkpoint,emptyDraft,issueLease,recoverCheckpoint} from '../src/domain.js';

const code='67-practice-listening_c21_t1_full_test';

function attempt(){
 const a={id:'fixture-full-listening',no:1,code,phase:'listening',usedMs:1146000,draft:{
  ...emptyDraft(code),sequence:1390,activeQuestion:30,audioPosition:1146,
  answers:Object.fromEntries(Array.from({length:27},(_,i)=>[i+1,'fixture'])),
  flags:[27],notes:'Keep this note',annotations:[{id:'fixture',kind:'highlight',rootKey:'listening-part3-left',
   skill:'reading',start:0,end:7,quote:'fixture',questionRef:'27'}],
  scroll:{passage:492,questions:{all:241,'part3-left':492,'part3-right':241}},
 }};
 const lease=issueLease(a,'original-tab',0);
 Object.assign(a.lease,{activated:true,awaitingPlayback:false});
 a.status='running';
 return {a,lease};
}

test('full Listening saves and resumes a draft with Safari scroll bounce',()=>{
 const {a,lease}=attempt();
 const snapshot={...a.draft,sequence:1391,audioPosition:1150,activeMs:4000,
  scroll:{passage:-12.5,questions:{all:-8,'part3-left':-12.5,'part3-right':241,'part2-left':7.25}}};
 const scroll={passage:0,questions:{all:0,'part3-left':0,'part3-right':241,'part2-left':7.25}};
 const resumed=structuredClone(a);
 checkpoint(a,snapshot,lease,4000);
 assert.deepEqual(a.draft,{...snapshot,scroll});
 assert.equal(recoverCheckpoint(resumed,snapshot,lease,300000),true);
 const newLease=issueLease(resumed,'resumed-tab',300000);
 assert.deepEqual(resumed.draft,{...snapshot,activeMs:0,scroll});
 assert.notEqual(newLease.id,lease.id);
 assert.equal(resumed.id,a.id);
 assert.equal(resumed.no,1);
 assert.equal(resumed.usedMs,1150000);
 assert.equal(snapshot.scroll.passage,-12.5);
});

test('draft validation keeps rejecting unrelated malformed data and logs the field only',t=>{
 const {a,lease}=attempt();
 const warn=t.mock.method(console,'warn',()=>{});
 const malformed={...a.draft,sequence:1391,answers:{41:'private answer'},
  scroll:{passage:'private value',questions:{all:-5}}};
 assert.throws(()=>recoverCheckpoint(a,malformed,lease,300000),{code:'INVALID_DRAFT'});
 assert.equal(a.draft.sequence,1390);
 assert.equal(warn.mock.callCount(),1);
 assert.deepEqual(JSON.parse(warn.mock.calls[0].arguments[0]),{
  event:'listening_draft_rejected',code:'INVALID_DRAFT',attemptId:a.id,fields:['answers','scroll'],
 });
});
