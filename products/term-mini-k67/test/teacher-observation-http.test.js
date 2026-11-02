import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
const input={class:'IC2304',test:'mini-test-lesson-5'},ref='11111111-1111-4111-8111-111111111111';
async function fixture(t){
 const f=await createMiniFixture({examOrder:true,completeSchema:true});
 t.after(async()=>{await f.app.locals.termTeacherObservation.close();await f.app.locals.termTestResultStream.close();await f.db.close();});
 const schema=await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(schema.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
 return f;
}
test('Teacher state HTTP: native middleware, strict scope, compact no-store response and no assessment mutation',async t=>{
 const f=await fixture(t),url='/api/term-tests/teacher/state';
 await request(f.app).get(url).query(input).expect(401);
 await request(f.app).get(url).set('x-review-token','fixture-only-key').query({...input,token:'wrong'}).expect(400);
 const before=(await f.db.query('SELECT jsonb_agg(to_jsonb(a)) AS value FROM assessment.term_test_attempt a')).rows;
 const response=await request(f.app).get(url).set('x-review-token','fixture-only-key').query(input).expect(200);
 assert.match(response.headers['cache-control'],/private, no-store/);assert.equal(response.body.state.className,input.class);
 assert.equal(response.body.state.kind,'term-teacher-state-v1');assert.equal(response.body.state.studentRef,null);
 assert.equal(JSON.stringify(response.body).includes('answers'),false);assert.equal(JSON.stringify(response.body).includes('legacy@'),false);
 const selected=await request(f.app).get(url).set('x-review-token','fixture-only-key').query({...input,student:ref}).expect(200);
 assert.equal(selected.body.state.studentRef,ref);
 await request(f.app).get(url).set('x-review-token','fixture-only-key').query({...input,student:'22222222-2222-4222-8222-222222222222'}).expect(404);
 assert.deepEqual((await f.db.query('SELECT jsonb_agg(to_jsonb(a)) AS value FROM assessment.term_test_attempt a')).rows,before);
 assert.equal(f.app.locals.termTeacherObservation.snapshot().connections,0);
});

test('Teacher state HTTP stream: real socket emits compact state, cancels cleanly, leaves no idle SQL observer',async t=>{
 const f=await fixture(t),server=await new Promise(resolve=>{const value=f.app.listen(0,'127.0.0.1',()=>resolve(value));});
 t.after(async()=>{await f.app.locals.termTeacherObservation.close();await new Promise(resolve=>server.close(resolve));});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/teacher/state/stream?${new URLSearchParams(input)}`,
  {headers:{'x-review-token':'fixture-only-key'},signal:AbortSignal.timeout(10000)});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const reader=response.body.getReader();let text='';
 while(!text.includes('event: state')){const part=await reader.read();assert.equal(part.done,false);text+=new TextDecoder().decode(part.value);}
 const payload=JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6));
 assert.equal(payload.className,input.class);assert.equal(payload.testSlug,input.test);assert.match(payload.contentRevision,/^[a-f0-9]{32}$/);
 await reader.cancel();
 const deadline=Date.now()+2000;while(f.app.locals.termTeacherObservation.snapshot().connections&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.app.locals.termTeacherObservation.snapshot().connections,0);
});
