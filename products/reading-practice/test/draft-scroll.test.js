import test from 'node:test';
import assert from 'node:assert/strict';
import {CODE,READING_ANNOTATION_LIMIT,checkpoint,emptyDraft,issueLease,validateSnapshot} from '../src/domain.js';

const fullCode='67-practice-reading_c21_t1_full_test';
const annotation={id:'fixture',kind:'note',rootKey:'fixture-passage',skill:'reading',start:0,end:7,quote:'fixture',questionRef:'1',note:'Keep this note'};

for(const code of [CODE,fullCode]){
 test(`${code}: recover Safari scroll bounce without losing answers or notes`,()=>{
  const a={usedMs:0,draft:emptyDraft(code)};
  const lease=issueLease(a,'browser',0);
  const question=a.draft.activeQuestion;
  const input={...a.draft,sequence:1,activeMs:4000,answers:{[question]:'fixture'},flags:[question],notes:'General note',
   annotations:Array.from({length:READING_ANNOTATION_LIMIT},(_,i)=>({...annotation,id:`fixture-${i}`})),
   scroll:{passage:-12.5,questions:{all:-8,'passage:one':-12.5,'questions:one':241.25,'active:one':question}}};
  checkpoint(a,input,lease,300000,{code,recovery:true});
  const scroll={passage:0,questions:{all:0,'passage:one':0,'questions:one':241.25,'active:one':question}};
  assert.deepEqual(a.draft,{...input,scroll});
  assert.equal(a.usedMs,4000);
  checkpoint(a,input,lease,301000,{code,recovery:true});
  assert.equal(a.usedMs,4000);
  assert.equal(input.scroll.passage,-12.5);
  assert.throws(()=>checkpoint(a,{...input,answers:{[question]:'changed'}},lease,301000,{code,recovery:true}),{code:'STALE_DRAFT'});
 });
}

test('Reading still rejects nonnumeric offsets, invalid answers and excess annotations',()=>{
 const input=emptyDraft(fullCode);
 for(const invalid of [null,'-1',Infinity]){
  assert.throws(()=>validateSnapshot({...input,scroll:{passage:0,questions:{all:invalid}}},fullCode),{code:'INVALID_DRAFT',draftField:'scroll'});
 }
 assert.throws(()=>validateSnapshot({...input,scroll:{passage:0,questions:{'active:one':-1}}},fullCode),{code:'INVALID_DRAFT',draftField:'scroll'});
 assert.throws(()=>validateSnapshot({...input,answers:{41:'fixture'}},fullCode),{code:'INVALID_DRAFT',draftField:'answers'});
 assert.throws(()=>validateSnapshot({...input,annotations:Array(READING_ANNOTATION_LIMIT+1).fill(annotation)},fullCode),{code:'ANNOTATION_LIMIT'});
});
