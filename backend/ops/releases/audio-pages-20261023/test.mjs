import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localPool} from '../../../../products/listening-practice/tools/local-pool.mjs';
import {selectK56PublicAudio} from './k56-public-audio.mjs';

// SQL boundary: metadata must not replace a pinned version or touch answers,
// identity, generation, clock, or mode. Uses a private in-memory PostgreSQL.
test('K56 public audio pinning and legacy compatibility', async t => {
  const pool = await localPool();t.after(()=>pool.end());
  await pool.query('CREATE SCHEMA assessment');
  await pool.query(`CREATE TABLE assessment.term_test_exam_session(id uuid PRIMARY KEY,
    generation int DEFAULT 0,listening_started_at timestamptz,listening_submitted_at timestamptz,superseded_at timestamptz)`);
  await pool.query(`CREATE TABLE assessment.term_test_attempt(id uuid PRIMARY KEY,test_slug text,
    exam_session_id uuid,generation int DEFAULT 0,mini_definition_snapshot jsonb,
    listening_submitted_at timestamptz,superseded_at timestamptz,attempt_mode text DEFAULT 'cbt',
    exam_mode text DEFAULT 'lis_first',reading_submitted_at timestamptz,answers jsonb DEFAULT '{"1":"student draft"}')`);
  async function seed(patch={}) {
    const attempt={attempt_token:randomUUID(),test_slug:'term-test-1-k56',generation:0},session=randomUUID();
    await pool.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)',[session]);
    await pool.query(`INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,mini_definition_snapshot)
      VALUES($1,$2,$3,$4)`,[attempt.attempt_token,attempt.test_slug,session,{version:1,content:{title:'pinned fixture'}}]);
    for(const [key,value]of Object.entries(patch)) {
      assert.ok(['listening_started_at','listening_submitted_at','superseded_at','attempt_mode','exam_mode','generation','mini_definition_snapshot'].includes(key));
      if(key==='listening_started_at')await pool.query('UPDATE assessment.term_test_exam_session SET listening_started_at=$2 WHERE id=$1',[session,value]);
      else await pool.query(`UPDATE assessment.term_test_attempt SET ${key}=$2 WHERE id=$1`,[attempt.attempt_token,value]);
    }
    return {attempt,session,read:async()=>(await pool.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attempt.attempt_token])).rows[0]};
  }
  await t.test('new session pins once, concurrent callers agree, no answer or clock changes',async()=>{
    const f=await seed(),before=await f.read();
    const [one,two]=await Promise.all([selectK56PublicAudio(pool,f.attempt),selectK56PublicAudio(pool,f.attempt)]);
    assert.deepEqual(one,two);assert.equal(one.sha256,'c7766f97758ec5ecdd3b69dfd3f762567a50bdbb0fd38930a2b609879e8439fc');
    const after=await f.read();const snapshot=after.mini_definition_snapshot;
    assert.deepEqual(snapshot.content,{title:'pinned fixture'});assert.deepEqual(snapshot.publicAudioManifest,one);
    delete after.mini_definition_snapshot.publicAudioManifest;assert.deepEqual(after,before);
  });
  await t.test('already started legacy remains encrypted and unmodified',async()=>{
    const f=await seed({listening_started_at:'2026-10-23T00:00:00Z'}),before=await f.read();
    assert.equal(await selectK56PublicAudio(pool,f.attempt),undefined);assert.deepEqual(await f.read(),before);
  });
  await t.test('pinned public version survives start and a changed current catalog',async()=>{
    const old={envelopeVersion:'MP3',assetVersion:'sha256-fixture-old-version',url:'https://example.test/old.mp3'};
    const f=await seed({listening_started_at:'2026-10-23T00:00:00Z',mini_definition_snapshot:{publicAudioManifest:old}});
    assert.deepEqual(await selectK56PublicAudio(pool,f.attempt),old);
  });
  for(const [label,patch]of Object.entries({submitted:{listening_submitted_at:'2026-10-23T00:00:00Z'},
    reset:{superseded_at:'2026-10-23T00:00:00Z'},paper:{attempt_mode:'answer_sheet'},
    readingFirst:{exam_mode:'read_first'},wrongGeneration:{generation:1}})) {
    await t.test(label+' does not pin or modify an attempt',async()=>{
      const f=await seed(patch),before=await f.read();
      assert.equal(await selectK56PublicAudio(pool,f.attempt),undefined);assert.deepEqual(await f.read(),before);
    });
  }
});
