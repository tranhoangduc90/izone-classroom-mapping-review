import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ASSETS} from './catalog.mjs';
import {withCloudflareAudio} from '../audio-pages-20261023/cloudflare-audio.mjs';

test('only the twelve exact public MP3 versions opt in; old pins and flags remain compatible',()=>{
 for(const asset of Object.values(ASSETS)){
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
test('runtime helpers and client/Worker protocol and public catalog stay in parity',async()=>{
 const root=new URL('../../../../',import.meta.url);
 const sources=await Promise.all([
  new URL('../audio-pages-20261023/cloudflare-audio.mjs',import.meta.url),
  new URL('products/term-mini-k67/src/cloudflare-audio.mjs',root),
  new URL('products/listening-practice/src/cloudflare-audio.mjs',root)
 ].map(p=>readFile(p,'utf8')));
 assert.equal(sources[0],sources[1]);assert.equal(sources[0],sources[2]);
});
