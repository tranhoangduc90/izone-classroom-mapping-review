// Dữ liệu giả kiểm ranh giới HTTP, quyền lớp, lineage và chấm thử không ghi DB.
import test from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';import express from 'express';
import {mountDesignDemo} from '../src/design-demo.js';
const scope='?class=IC2200&test=term-test-2',prefix='/api/term-tests/teacher/design-demo';
const def={questions:[{number:1,type:'gapfill',accepted:['colour']}]};
function fixture(changes={}){
 const row={class_count:1,authorized_class_count:1,test_slug:'term-test-2',test_title:'Synthetic',definition_version:1,listening_definition:def,reading_definition:def,listening_band_adjustment:0,attempts:[],snapshot:null,...changes};
 const queries=[];const app=express();app.use(express.json());
 mountDesignDemo(app,{pool:{query:async(sql,args)=>{queries.push({sql,args});return {rows:[row]};}},auth:{login:(_req,res)=>res.json({ok:true}),logout:(_req,res)=>res.json({ok:true}),authenticate:(req,res,next)=>{if(req.get('authorization')!=='fixture')return res.status(401).json({ok:false});req.reviewer={email:'fixture@example.test'};next();},readAuthorization:()=>({source:'demo_google',googleSubject:'test-only'})},requireContext:(_req,_res,next)=>next(),limiter:(_req,_res,next)=>next(),assets:{getContent:async()=>({baseTestSlug:'term-test-2'}),getTiming:()=>({}),streamDemoAudio:async(_slug,_req,res)=>res.type('audio/mpeg').send('synthetic')}});
 return {api:request(app),queries,row};
}
test('demo: mở đề, bài chấm và audio không cần cookie/đăng nhập',async()=>{
 const f=fixture({snapshot:{definitionVersion:1}});
 for(const p of ['/attempts','/content','/snapshot','/audio']){
  const r=await f.api.get(prefix+p+scope);assert.equal(r.status,200);assert.match(r.headers['cache-control'],/no-store/);
 }
 assert.equal(f.queries.length,4);assert.deepEqual(f.queries[0].args,['IC2200','term-test-2',null]);
 assert.equal((await f.api.get(prefix+'/session')).status,404);
});
test('demo: chỉ scope IC2200/Term Test 2 được đọc',async()=>{
 const f=fixture({authorized_class_count:0});for(const p of ['/attempts','/content','/snapshot','/audio'])assert.equal((await f.api.get(prefix+p+scope)).status,403);
 assert.equal((await f.api.get(prefix+'/content?class=OTHER&test=term-test-2')).status,400);
});
test('demo: snapshot giữ điểm 0 và rubric nguyên văn, không trả token',async()=>{
 const snapshot={id:'11111111-1111-4111-8111-111111111111',definitionVersion:1,task1:'Original\ntext',grading:{ready:true,writingScore:0,tasks:[{taskNumber:1,report:'<p>Exact report</p>'},{taskNumber:2,taskScore:0}]}};
 const f=fixture({snapshot});const r=await f.api.get(prefix+'/snapshot'+scope+'&attempt='+snapshot.id);assert.equal(r.status,200);assert.deepEqual(r.body.snapshot,snapshot);assert.equal(f.queries[0].args[2],snapshot.id);assert.doesNotMatch(JSON.stringify(r.body),/tokenHash|attemptToken|examSessionToken/);
});
test('demo: khác phiên bản/thiếu run cùng lineage không hiển thị bài chấm',async()=>{
 for(const snapshot of [{definitionVersion:2},{definitionVersion:1,grading:{ready:true,tasks:[{}]}}]){const f=fixture({snapshot});assert.equal((await f.api.get(prefix+'/snapshot'+scope)).status,409);}
});
test('demo: chấm L/R dùng scorer thật, phân biệt bỏ trống; không mutation',async()=>{
 const f=fixture();const r=await f.api.post(prefix+'/grade'+scope).send({definitionVersion:1,listening:{1:'color'},reading:{}});
 assert.equal(r.status,200);assert.equal(r.body.result.listening.correct,1);assert.equal(r.body.result.reading.answered,0);assert.equal(r.body.trial,true);assert.equal(f.queries.length,1);assert.doesNotMatch(f.queries[0].sql,/\b(?:INSERT|UPDATE|DELETE)\b/i);
});
test('demo: đáp án/phiên bản không hợp lệ không chấm',async()=>{
 const f=fixture();for(const body of [{definitionVersion:2,listening:{},reading:{}},{definitionVersion:1,listening:{41:'x'},reading:{}}])assert.equal((await f.api.post(prefix+'/grade'+scope).send(body)).status,400);
});
