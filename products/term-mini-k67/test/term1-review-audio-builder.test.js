import test from 'node:test';
import assert from 'node:assert/strict';
import {addTerm1ReviewAudio,evidenceHash} from '../tools/add-term1-review-audio.mjs';
import {publicAudioCatalog} from '../src/public-audio-catalog.js';

function fixture(){
  const entries=Object.fromEntries(Array.from({length:40},(_,i)=>{
    const n=i+1,evidence=[[{text:'Fixture evidence '+n,foreground:'#ff0000'}]];
    return[n,{number:n,section:Math.floor(i/10),answers:['fixture'],evidence,
      blocks:[{row:n,analysis:[[{text:'Fixture explanation'}]],evidence}],source:{documentId:'fixture',row:n}}];
  }));
  const source={schemaVersion:1,testSlug:'term-test-1',definitionVersion:1,contentSha256:'content-fixture',definitionSha256:'definition-fixture',
    skills:{listening:{entries},reading:{entries:structuredClone(entries)}}};
  const catalog=publicAudioCatalog['term-test-1'];
  const map={schemaVersion:1,sourceBundleSha256:'bundle-fixture',contentSha256:source.contentSha256,definitionSha256:source.definitionSha256,
    audio:{sha256:catalog.sha256,asset:new URL(catalog.url).pathname.split('/').at(-1),durationMs:1734000},questions:{}};
  for(const [n,entry] of Object.entries(entries)){
    const replay=[{id:'fixture-'+n,startMs:Number(n)*1000,endMs:Number(n)*1000+500,label:'dẫn chứng'}];
    map.questions[n]={evidenceSha256:evidenceHash(entry.evidence),replay,blocks:[{evidenceSha256:evidenceHash(entry.blocks[0].evidence),replay}]};
  }
  return{source,map,build:()=>addTerm1ReviewAudio(source,map,'bundle-fixture')};
}

test('adds all 40 replay entries without changing source, Reading, keys, colors or explanation blocks',()=>{
  const f=fixture(),before=structuredClone(f.source),result=f.build();
  assert.deepEqual(f.source,before);assert.deepEqual(result.skills.reading,before.skills.reading);
  assert.equal(Object.values(result.skills.listening.entries).filter(e=>e.replay.length).length,40);
  delete result.reviewAudio;
  for(const entry of Object.values(result.skills.listening.entries)){delete entry.replay;entry.blocks.forEach(b=>delete b.replay);}
  assert.deepEqual(result,before);
});

for(const [name,change] of [
  ['bundle',f=>f.map.sourceBundleSha256='other'],['content',f=>f.map.contentSha256='other'],
  ['definition',f=>f.map.definitionSha256='other'],['question list',f=>delete f.map.questions[40]],
  ['evidence text',f=>f.source.skills.listening.entries[1].evidence[0][0].text='Other question'],
  ['block identity',f=>f.map.questions[1].blocks[0].evidenceSha256='other'],
  ['block count',f=>f.map.questions[1].blocks=[]],['audio hash',f=>f.map.audio.sha256='f'.repeat(64)],
  ['audio asset',f=>f.map.audio.asset='term-test-2.mp3'],['duration',f=>f.map.audio.durationMs=0],
  ['negative start',f=>f.map.questions[1].replay[0].startMs=-1],
  ['clip outside audio',f=>f.map.questions[1].replay[0].endMs=1800000],
  ['empty primary replay',f=>f.map.questions[1].replay=[]]
])test('rejects stale or invalid '+name,()=>{const f=fixture();change(f);assert.throws(f.build);});
