import test from 'node:test';
import assert from 'node:assert/strict';
import {buildQuestionAnalytics} from '../src/learning-question-analytics.js';

const objective={itemVersionId:'q1',position:1,prompt:'Chọn đáp án',interactionType:'single_choice',graderType:'exact_option',required:true,maxScore:1,
  options:[{id:'A',label:'Phương án A'},{id:'B',label:'Phương án B'}]};
const definition={formVersionId:'form',blocks:[{items:[objective,
  {...objective,itemVersionId:'optional',position:2,required:false},
  {...objective,itemVersionId:'hidden',position:3,interactionConfig:{visibleWhenItemVersionId:'q1',visibleWhenValue:'B',requiredWhenVisible:true}},
  {...objective,itemVersionId:'reflection',position:4,graderType:'none',interactionType:'long_text',maxScore:0,options:[]}]}]};
const student=(id,value,verdict)=>({studentRef:id,name:'Trùng tên',submissionId:'submission-'+id,gradingStatus:'complete',responses:{q1:value,reflection:'Ý kiến mở'},
  responseItems:[{itemVersionId:'q1',answerState:'answered'},{itemVersionId:'reflection',answerState:'answered'}],
  gradingItems:[{itemVersionId:'q1',verdict},{itemVersionId:'optional',verdict:'incorrect'}]});
test('A02/A03/A04/A05: đúng mẫu số, tùy chọn/ẩn/tự khai không bị tính sai',()=>{
  const analytics=buildQuestionAnalytics({assignmentId:'assignment',definition,students:[student('s1','A','correct'),student('s2','B','incorrect'),
    {...student('s3','B'),gradingStatus:'pending',gradingItems:[]},{studentRef:'s4',name:'Chưa nộp'}]});
  const q=analytics.items[0];
  assert.equal(q.counts.roster,4);assert.equal(q.counts.submitted,3);assert.equal(q.counts.graded,2);
  assert.equal(q.counts.pending,1);assert.equal(q.errorRate,0.5);
  assert.deepEqual(q.choices.map(c=>[c.optionId,c.count,c.incorrect]),[['B',2,1],['A',1,0]]);
  assert.equal(analytics.items[1].counts.incorrect,0);assert.equal(analytics.items[1].counts.ungraded,3);
  assert.equal(analytics.items[2].counts.hidden,1);assert.equal(analytics.items[2].counts.visible,2);
  assert.equal(analytics.items[3].counts.graded,0);assert.equal(analytics.items[3].counts.ungraded,3);
  assert.equal(q.students.filter(s=>s.verdict==='incorrect')[0].studentRef,'s2');
  assert.ok(!JSON.stringify(analytics).includes('Ý kiến mở'));
});
test('A01: đầu vào lặp học viên bị chặn thay vì đếm lượt',()=>{
  assert.throws(()=>buildQuestionAnalytics({assignmentId:'a',definition,students:[student('same','A','correct'),student('same','B','incorrect')]}),/ANALYTICS_DUPLICATE_STUDENT/);
});
