// Kiểm hành vi công bố: demo riêng xem ngay; lớp thật vẫn chờ, bài chưa chấm không lộ điểm.
import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
const source=process.env.DEMO_RELEASE_SOURCE?pathToFileURL(process.env.DEMO_RELEASE_SOURCE):new URL('./k56-student-writing-release.mjs',import.meta.url);
const {studentWritingGrading:release}=await import(source.href);
const now=Date.parse('2026-10-20T08:00:00Z');
const grading={ready:true,status:'ready',readyAt:'2026-10-20T07:59:00Z',writingScore:6,tasks:[{taskNumber:2,feedback:'Đã chấm'}]};
function profile(name,isolated,fn){const old={profile:process.env.DEPLOYMENT_PROFILE,isolated:process.env.DEMO_ISOLATED_MODE};try{
  if(name===undefined)delete process.env.DEPLOYMENT_PROFILE;else process.env.DEPLOYMENT_PROFILE=name;
  if(isolated===undefined)delete process.env.DEMO_ISOLATED_MODE;else process.env.DEMO_ISOLATED_MODE=isolated;
  fn();
}finally{for(const [key,value] of [['DEPLOYMENT_PROFILE',old.profile],['DEMO_ISOLATED_MODE',old.isolated]])if(value===undefined)delete process.env[key];else process.env[key]=value;}}
test('Demo K56 riêng xem đủ điểm và nhận xét ngay khi AI sẵn sàng',()=>profile('k56-demo','true',()=>{
  for(const slug of ['term-test-1-k56','term-test-2-k56','mini-test-k56'])assert.equal(release(slug,grading,now),grading);
}));
test('Lớp thật và cấu hình thiếu/không đúng vẫn chờ đủ hai giờ, không lộ điểm',()=>{
  for(const [name,isolated] of [['k56-ic2264','false'],['k56-demo','false'],['k56-ic2264','true'],[undefined,undefined]])profile(name,isolated,()=>{
    const result=release('term-test-1-k56',grading,now);assert.equal(result.status,'awaiting_release');assert.equal(result.writingScore,undefined);assert.deepEqual(result.tasks,[]);
    assert.equal(release('term-test-1-k56',grading,now+7200000),grading);
    assert.equal(release('term-test-1-k56',{...grading,readyAt:null},now).status,'review_required');
  });
});
test('Không đổi trạng thái chưa chấm và bài ngoài K56',()=>profile('k56-demo','true',()=>{
  const waiting={status:'processing',ready:false,tasks:[]};assert.equal(release('term-test-1-k56',waiting,now),waiting);assert.equal(release('term-test-1',grading,now),grading);assert.equal(release('term-test-1-k56',null,now),null);
}));
