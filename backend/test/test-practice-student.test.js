import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {withStudentStateCapabilities} from '../src/test-practice-student-progress.js';
import {request,closeNativeHttp} from '../../products/test-support/native-http.mjs';
test('Student state capability is opt-in and never mutates native or legacy DTOs',()=>{
 const value={capabilities:{compactPulseAck:true},identity:{bindingId:'fixture'}};assert.equal(withStudentStateCapabilities(value,false),value);const enabled=withStudentStateCapabilities(value,true);assert.equal(enabled.capabilities.studentStateStream,true);assert.equal(enabled.capabilities.studentStateIntervalMs,30000);assert.deepEqual(value,{capabilities:{compactPulseAck:true},identity:{bindingId:'fixture'}});const error={error:{code:'UNAUTHORIZED'}};assert.equal(withStudentStateCapabilities(error,true),error);
});
test('Standalone student observers are byte-identical pinned modules',async()=>{
 const source=await readFile(new URL('../src/test-practice-student-progress.js',import.meta.url));for(const product of ['reading-practice','listening-practice'])assert.deepEqual(source,await readFile(new URL('../../products/'+product+'/src/test-practice-student-progress.js',import.meta.url)));
});
test('Native HTTP fixture accepts a disabled HTML route but still rejects malformed JSON',async()=>{
 const app=(req,res)=>{if(req.url==='/invalid-json'){res.setHeader('Content-Type','application/json');res.end('{');}else{res.statusCode=404;res.setHeader('Content-Type','text/html');res.end('<!DOCTYPE html><p>Not found</p>');}};
 try{const missing=await request(app).get('/missing');assert.equal(missing.status,404);assert.deepEqual(missing.body,{});assert.match(missing.text,/Not found/);await assert.rejects(async()=>await request(app).get('/invalid-json'),SyntaxError);}finally{await closeNativeHttp();}
});
