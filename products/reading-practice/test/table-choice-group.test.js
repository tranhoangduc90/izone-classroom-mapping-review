// Đề giả độc lập: bảng hai ô và nhóm hai điểm, không chứa key Cambridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthoredLesson,validateAuthoredContent,gradeAuthored} from '../src/authored-content.js';
function fixture(){
 const groups=[{id:'table',kind:'completion',label:'Table',start:1,end:2,instruction:'ONE WORD ONLY',maxWords:1,table:{headers:['Item','Finding'],rows:[['Room','{{1}}'],['Garden','{{2}}']]},questions:[{n:1,text:'Room material'},{n:2,text:'Garden material'}]},
 {id:'pair',kind:'mcq',label:'Choose two',start:3,end:4,instruction:'Choose TWO letters.',chooseCount:2,options:[{value:'A',text:'Red'},{value:'B',text:'Blue'},{value:'C',text:'Green'},{value:'D',text:'White'}],questions:[{n:3,text:'Which colours occur?'},{n:4,text:'Which colours occur?'}]}];
 const lesson={code:'67-practice-reading_table_pair_fixture',lesson:80,title:'Synthetic materials',totalMs:1200000,paragraphs:['A'],groups:groups.map(({id,kind,label,start,end})=>({id,kind,label,start,end}))};
 registerAuthoredLesson(lesson);
 const key={1:['wood'],2:['grass'],3:['B','D'],4:['B','D']},p=text=>({runs:[{text}]});
 return {code:lesson.code,version:'fixture-v1',totalMs:lesson.totalMs,definition:{authored:true,lesson,passage:{A:'Wood, grass, blue and white.'},groups},key,explanations:{entries:Object.fromEntries([1,2,3,4].map(n=>[n,{number:n,kind:n<=2?'completion':'mcq',answer:key[n],prompt:p('Question '+n),reason:[p('The source states these materials and colours.')],evidenceGroups:[{paragraph:'A',paragraphs:[p('Wood')],marks:[{start:0,end:4,background:'#fff2cc'}]}]}]))}};
}
test('chọn hai giữ hai điểm, không lệ thuộc thứ tự và không cộng trùng',()=>{
 const b=fixture();validateAuthoredContent(b);
 for(const [answers,score,states] of [
  [{3:'B',4:'D'},2,['correct','correct']],[{3:'D',4:'B'},2,['correct','correct']],
  [{3:'B',4:'A'},1,['correct','incorrect']],[{3:'B'},1,['correct','blank']],
  [{3:'A',4:'C'},0,['incorrect','incorrect']],[{},0,['blank','blank']],
  [{3:'B',4:'b'},1,['correct','incorrect']],[{3:'B|D'},0,['incorrect','blank']],
  [{3:'Z',4:'D'},1,['incorrect','correct']]
 ]){
  const result=gradeAuthored(answers,b.key,b.definition);assert.equal(result.score,score);assert.deepEqual(result.rows.slice(2).map(r=>r.state),states);
 }
 assert.equal(gradeAuthored({1:' WOOD ',2:'grass',3:'D',4:'B'},b.key,b.definition).score,4);
 assert.equal(gradeAuthored({1:'wood extra',2:'grass'},b.key,b.definition).score,1);
});
test('bundle từ chối bảng mất ô, lặp ô và nhóm chọn hai sai hợp đồng',()=>{
 const b=fixture();
 for(const mutate of [
  b=>b.definition.groups[0].table.rows.pop(),
  b=>b.definition.groups[0].table.rows[1][1]='{{1}}',
  b=>b.definition.groups[0].table.rows[0].push('extra'),
  b=>b.definition.groups[1].chooseCount=1,
  b=>b.key[4]=['D','B'],
  b=>b.definition.groups[1].questions[0].multiple=true,
 ]){const bad=structuredClone(b);mutate(bad);assert.throws(()=>validateAuthoredContent(bad));}
});
