import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {issueR2Download,r2Eligible} from '../src/audio-r2.js';
const catalog=JSON.parse(readFileSync(new URL('../src/r2-audio-catalog.json',import.meta.url),'utf8'));
const asset=Object.values(catalog)[0],manifest={...asset,envelopeVersion:'MP3'};
const settings={enabled:true,assets:Object.keys(catalog),accountId:'e340869dcc6ff285504947407d148104',bucket:'izone-audio-r2-lab-20261023',accessKeyId:'fixture-access-key',secretAccessKey:'fixture-secret-only'};
test('explicit opt-in, configured asset and native eligibility are all required',()=>{
 for(const options of [{},{requested:'other'},{requested:'r2-direct-v1',eligible:false}])assert.equal(issueR2Download(manifest,{settings,...options}),undefined);
 for(const patch of [{enabled:false},{assets:[]}])assert.equal(issueR2Download(manifest,{requested:'r2-direct-v1',settings:{...settings,...patch}}),undefined);
 assert.equal(r2Eligible(asset.sha256,{settings}),true);assert.equal(r2Eligible('0'.repeat(64),{settings}),false);
});
test('all configured native assets receive object-bound GET signatures with bounded lifetime',()=>{for(const a of Object.values(catalog)){
 const d=issueR2Download({...a,envelopeVersion:'MP3'},{requested:'r2-direct-v1',settings,now:new Date('2026-11-07T00:00:00Z')});
 const u=new URL(d.url);assert.equal(u.pathname,'/'+settings.bucket+'/'+a.key);assert.equal(u.searchParams.get('X-Amz-Expires'),'600');assert.equal(u.searchParams.get('X-Amz-SignedHeaders'),'host');assert.match(u.searchParams.get('X-Amz-Signature'),/^[a-f0-9]{64}$/);assert.equal(d.sha256,a.sha256);assert.equal(d.fallback,'public-pages');
}});
test('signer rejects altered pin/url/size and does not leak signing secret in descriptor',()=>{
 for(const patch of [{url:'https://evil.example/file.mp3'},{byteLength:1},{envelopeVersion:'IZTT1'}])assert.throws(()=>issueR2Download({...manifest,...patch},{requested:'r2-direct-v1',settings}),/AUDIO_R2_MANIFEST_DENIED/);
 const d=issueR2Download(manifest,{requested:'r2-direct-v1',settings});assert.ok(!JSON.stringify(d).includes(settings.secretAccessKey));assert.equal(manifest.audioDownload,undefined);
});
