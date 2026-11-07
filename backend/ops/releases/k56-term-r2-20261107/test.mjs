import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rmdir,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

process.env.TERM2_FIXTURE_IMPORT_ONLY='1';
const {fixture}=await import('../term1-offline-20261107/test.mjs');
const runtime=process.env.TERM2_RUNTIME_ROOT;
const {publicAudioCatalog}=await import(pathToFileURL(runtime+'/src/k56-public-audio.mjs'));
const slug='term-test-'+(process.env.K56_TEST_PRODUCT||'2')+'-k56';
const asset=publicAudioCatalog[slug];

test('Term R2 descriptor only after native prep and exact run ownership',async()=>{
 const configDir=await mkdtemp(join(tmpdir(),'k56-r2-'));
 process.env.AUDIO_R2_DIRECT_ENABLED='true';
 process.env.AUDIO_R2_DIRECT_CONFIG_FILE=join(configDir,'config.json');
 const settings={enabled:true,assets:[asset.sha256],accountId:'0'.repeat(32),bucket:'fixture-audio',accessKeyId:'fixture-key',secretAccessKey:'fixture-secret'};
 const setConfig=async value=>writeFile(process.env.AUDIO_R2_DIRECT_CONFIG_FILE,JSON.stringify(value));
 await setConfig(settings);
 try{
  for(const mode of ['lis_first','read_first']){
   const f=await fixture(mode);
   try{
    const input={...f.scope,classCode:'FIXTURE',studentRef:randomUUID(),mode};
    const prepare=(overrides={})=>f.request('/offline/prepare',{...input,...overrides});
    const optIn={audioTransport:'r2-direct-v1'};
    assert.equal((await prepare()).audioDownload,undefined);
    const granted=await prepare(optIn);
    assert.equal(granted.status,200);
    assert.equal(granted.examMode,mode);
    assert.equal(granted.audioDownload.sha256,asset.sha256);
    assert.equal(granted.audioDownload.byteLength,asset.byteLength);
    assert.equal(granted.audioDownload.validForSeconds,600);
    assert.match(new URL(granted.audioDownload.url).pathname,new RegExp(asset.sha256+'\\.mp3$'));
    assert.equal((await prepare({...optIn,generation:1})).status,403);
    assert.equal((await prepare({...optIn,examSessionToken:randomUUID()})).status,403);
    const wrongOwner=await prepare({...optIn,ownerId:randomUUID()});
    assert.equal(wrongOwner.error,'OFFLINE_OWNER_CONFLICT');
    assert.equal(wrongOwner.audioDownload,undefined);
    await setConfig({...settings,enabled:false});
    const disabled=await prepare(optIn);
    assert.equal(disabled.status,200);
    assert.equal(disabled.audioDownload,undefined);
    await setConfig({...settings,secretAccessKey:''});
    const unavailable=await prepare(optIn);
    assert.equal(unavailable.status,200);
    assert.equal(unavailable.audioDownload,undefined);
    await setConfig(settings);
    await f.db.query('UPDATE assessment.term_test_attempt SET reading_started_at=now() WHERE id=$1',[f.a]);
    assert.equal((await prepare(optIn)).audioDownload,undefined);
   }finally{await f.close();}
  }
 }finally{await unlink(process.env.AUDIO_R2_DIRECT_CONFIG_FILE);await rmdir(configDir);}
});
