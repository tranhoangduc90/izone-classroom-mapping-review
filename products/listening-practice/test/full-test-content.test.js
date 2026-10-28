import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeAuthored,registerAuthoredLesson} from '../src/authored-content.js';

// Hai ô có hai điểm; kỳ vọng lấy từ quy tắc đề, không từ kết quả hàm chấm.
const pair={id:'two',kind:'mcq',start:21,end:22,answerMode:'unordered-pair',questions:[{n:21},{n:22}]};
const key={21:['B','D'],22:['B','D']};
test('chọn hai: không xét thứ tự, mỗi đáp án đúng chỉ được tính một lần',()=>{
 for(const [answers,expected] of [[{21:'D',22:'B'},2],[{21:'B',22:'C'},1],[{21:'B',22:'B'},1],[{21:'',22:'D'},1],[{21:'A',22:'C'},0],[{},0]]){
  const result=gradeAuthored(answers,key,{groups:[pair]});
  assert.equal(result.score,expected,JSON.stringify(answers));assert.equal(result.rows.length,2);
 }
});
test('chọn hai: không nhận chuỗi ghép trong một ô hoặc giá trị không có trong key',()=>{
 assert.equal(gradeAuthored({21:'B|D',22:''},key,{groups:[pair]}).score,0);
});
test('chấm bài cũ giữ tổ hợp một câu và giới hạn từ',()=>{
 const definition={groups:[{kind:'mcq',questions:[{n:1,multiple:true}]},{kind:'completion',maxWords:1,questions:[{n:2}]}]};
 assert.equal(gradeAuthored({1:'D|B',2:'roof'},{1:['B|D'],2:['roof']},definition).score,2);
 assert.equal(gradeAuthored({1:'D',2:'green roof'},{1:['B|D'],2:['roof']},definition).score,0);
});
function lesson(parts){return{code:'67-practice-listening_full-structure-fixture',title:'Library full listening',lesson:78,totalMs:720000,audioMs:600000,reviewMs:120000,paragraphs:['P1','P2','P3','P4'],groups:[1,2,3,4].map((n)=>({id:'part'+n,kind:'completion',label:'Notes',start:(n-1)*10+1,end:n*10})),parts};}
const parts=[1,2,3,4].map(n=>({id:'part'+n,title:'Part '+n,start:(n-1)*10+1,end:n*10,startMs:(n-1)*150000,endMs:n*150000}));
test('full test: bốn part phủ đúng 40 câu và một timeline audio',()=>{
 const value=registerAuthoredLesson(lesson(parts));assert.equal(value.questionIds.length,40);assert.equal(value.totalMs,value.audioMs+120000);
});
test('full test: từ chối part chồng câu hoặc mốc audio ngoài file',()=>{
 const overlap=structuredClone(parts);overlap[1].start=10;
 assert.throws(()=>registerAuthoredLesson({...lesson(overlap),code:'67-practice-listening_full-overlap-fixture'}),/part|phần|câu/i);
 const outside=structuredClone(parts);outside[3].endMs=600001;
 assert.throws(()=>registerAuthoredLesson({...lesson(outside),code:'67-practice-listening_full-outside-fixture'}),/audio|mốc|part/i);
});
