// Add reviewed replay intervals to an exact existing private bundle. Preserve all
// questions, answers, explanations, colors and source identity; stale input fails.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {publicAudioCatalog} from '../src/public-audio-catalog.js';

const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const evidenceHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const digest=raw=>createHash('sha256').update(raw).digest('hex');

export function addTerm1ReviewAudio(source,map,sourceSha256){
  assert.equal(source.testSlug,'term-test-1','Wrong test bundle');
  assert.equal(source.schemaVersion,1);
  assert.equal(map.schemaVersion,1);
  assert.equal(map.sourceBundleSha256,sourceSha256,'Stale source bundle');
  assert.equal(map.contentSha256,source.contentSha256,'Stale content');
  assert.equal(map.definitionSha256,source.definitionSha256,'Stale answer definition');
  assert.ok(!source.reviewAudio,'Source already contains replay');
  const catalog=publicAudioCatalog['term-test-1'],audio=map.audio;
  assert.equal(audio?.sha256,catalog.sha256,'Wrong audio hash');
  assert.equal(audio.asset,path.basename(new URL(catalog.url).pathname),'Wrong audio asset');
  assert.ok(Number.isInteger(audio.durationMs)&&audio.durationMs>0&&audio.durationMs<=7200000,'Invalid audio duration');
  const entries=source.skills?.listening?.entries;
  assert.equal(Object.keys(entries||{}).length,40,'Incomplete Listening');
  assert.equal(Object.keys(source.skills?.reading?.entries||{}).length,40,'Incomplete Reading');
  assert.deepEqual(Object.keys(map.questions||{}).sort(),Object.keys(entries).sort(),'Replay questions differ');
  const clips=(items,required)=>{
    assert.ok(Array.isArray(items)&&items.length<=64&&(!required||items.length),'Missing replay clips');
    for(const clip of items){
      assert.ok(clip&&typeof clip.id==='string'&&clip.id.length>0&&clip.id.length<=160,'Invalid clip identity');
      assert.ok(Number.isInteger(clip.startMs)&&Number.isInteger(clip.endMs)&&clip.startMs>=0
        &&clip.endMs>clip.startMs&&clip.endMs<=audio.durationMs,'Invalid clip bounds');
      assert.ok(clip.label===undefined||(typeof clip.label==='string'&&clip.label.length<=120),'Invalid clip label');
    }
    return structuredClone(items);
  };
  const result=structuredClone(source);
  result.reviewAudio=structuredClone(audio);
  for(const [number,entry] of Object.entries(result.skills.listening.entries)){
    assert.equal(entry.number,Number(number),'Question identity differs');
    const item=map.questions[number];
    assert.equal(item.evidenceSha256,evidenceHash(entry.evidence),'Primary evidence differs: '+number);
    assert.equal(item.blocks?.length,entry.blocks.length,'Block count differs: '+number);
    entry.replay=clips(item.replay,true);
    entry.blocks.forEach((block,index)=>{
      assert.equal(item.blocks[index].evidenceSha256,evidenceHash(block.evidence),'Block evidence differs: '+number+'/'+index);
      block.replay=clips(item.blocks[index].replay,false);
    });
  }
  assert.deepEqual(result.skills.reading,source.skills.reading);
  return result;
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [bundleFile,mapFile,outputFile]=process.argv.slice(2);
  assert.ok(bundleFile&&mapFile&&outputFile,'Need private source bundle, reviewed replay map and output file');
  assert.notEqual(path.resolve(outputFile),path.resolve(bundleFile),'Keep source snapshot intact');
  const raw=await fs.readFile(bundleFile),source=JSON.parse(raw),map=JSON.parse(await fs.readFile(mapFile,'utf8'));
  const result=addTerm1ReviewAudio(source,map,digest(raw));
  await fs.mkdir(path.dirname(outputFile),{recursive:true});
  await fs.writeFile(outputFile,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({testSlug:result.testSlug,listening:40,reading:40,outputSha256:digest(await fs.readFile(outputFile))}));
}
