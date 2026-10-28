import test from 'node:test';
import assert from 'node:assert/strict';
import {ASSETS} from './catalog.mjs';
import {withCloudflareAudio} from '../audio-pages-20261023/cloudflare-audio.mjs';
import {withCloudflareAudio as listeningAudio} from '../../../../products/listening-practice/src/cloudflare-audio.mjs';
import {withCloudflareAudio as termAudio} from '../../../../products/term-mini-k67/src/cloudflare-audio.mjs';

test('common exact public MP3 versions opt in; old pins and flags remain compatible',()=>{
 for(const asset of Object.values(ASSETS).filter(a=>!a.id.startsWith('homework-')&&a.id!=='listening-15-c21-t1-full')){
  const m={...asset,envelopeVersion:'MP3'},before=structuredClone(m);
  assert.equal(withCloudflareAudio(m,false),m);
  const value=withCloudflareAudio(m,true);assert.deepEqual(value.cloudflare,{version:1,policy:'public-mp3-v1',chunkSize:524288});
  assert.deepEqual(m,before);
  for(const patch of [{sha256:'0'.repeat(64)},{url:asset.url+'?changed=1'},{byteLength:1},{envelopeVersion:'IZTT1'}]){
   const old={...m,...patch};assert.equal(withCloudflareAudio(old,true),old);
  }
 }
 const asset=Object.values(ASSETS)[0],m={...asset,envelopeVersion:'MP3'};
 const prior=process.env.AUDIO_CLOUDFLARE_ASSETS;
 try{
  process.env.AUDIO_CLOUDFLARE_ASSETS='';assert.equal(withCloudflareAudio(m,true),m);
  process.env.AUDIO_CLOUDFLARE_ASSETS=asset.sha256;assert.equal(withCloudflareAudio(m,true).cloudflare.version,1);
 }finally{if(prior===undefined)delete process.env.AUDIO_CLOUDFLARE_ASSETS;else process.env.AUDIO_CLOUDFLARE_ASSETS=prior;}
});
test('all common assets keep adapter behavior; full Listening is scoped to its native runtime',()=>{
 for(const asset of Object.values(ASSETS)){
  const manifest={...asset,envelopeVersion:'MP3'};
  assert.deepEqual(withCloudflareAudio(manifest,true),termAudio(manifest,true));
  if(asset.id==='listening-15-c21-t1-full'){
   assert.equal(withCloudflareAudio(manifest,true),manifest);
   assert.deepEqual(listeningAudio(manifest,true).cloudflare,{version:1,policy:'public-mp3-v1',chunkSize:524288});
  }else assert.deepEqual(listeningAudio(manifest,true),termAudio(manifest,true));
 }
});
