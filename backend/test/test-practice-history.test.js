import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {projectPracticeHistory} from '../src/test-practice-history.js';
const attempt=(id,no)=>({id,no,status:'submitted',answers:{14:'A'},notes:'Private history '+id,draft:{notes:'Private draft '+id},flags:[14],result:{score:1},completedAt:'2026-11-01T00:00:00Z'});
test('Projection keeps native/legacy objects complete and only exposes requested historical payloads',()=>{
 const value={attempts:[attempt('first',1),attempt('second',2),attempt('current',3)],events:[{docs:'verified'}],firstCompleted:1},before=structuredClone(value);
 assert.equal(projectPracticeHistory(value),value);const compact=projectPracticeHistory(value,{enabled:true});assert.equal(compact.attempts[0].answers,undefined);assert.equal(compact.attempts[0].answeredCount,1);assert.equal(compact.attempts.at(-1).notes,value.attempts.at(-1).notes);assert.deepEqual(value,before);
 const selected=projectPracticeHistory({...value,attempt:value.attempts[0]},{enabled:true});assert.equal(selected.attempt.detailsLoaded,true);assert.equal(selected.attempt.notes,value.attempts[0].notes);assert.equal(selected.attempts[1].result,undefined);assert.deepEqual(selected.events,value.events);
});
test('The same historical attempt gets a different cache revision after a same-ID content repair',()=>{
 const value={attempts:[attempt('old',1),attempt('latest',2)]},first=projectPracticeHistory(value,{enabled:true});value.attempts[0].notes='Repaired content without changing timestamp';
 const second=projectPracticeHistory(value,{enabled:true});assert.notEqual(first.attempts[0].detailRevision,second.attempts[0].detailRevision);assert.equal(first.attempts[1].detailRevision,second.attempts[1].detailRevision);
});
test('Standalone history projections exactly match the canonical dependency',async()=>{
 const canonical=await readFile(new URL('../src/test-practice-history.js',import.meta.url));for(const product of ['reading-practice','listening-practice'])assert.deepEqual(canonical,await readFile(new URL('../../products/'+product+'/src/test-practice-history.js',import.meta.url)));
});
