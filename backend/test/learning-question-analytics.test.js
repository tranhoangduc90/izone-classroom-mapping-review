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

test('A06: điền từ có đáp án tính đúng/sai, câu Reading chỉ đối chiếu vẫn không chấm',()=>{
  // Dữ liệu giả có một câu đúng, một sai, một để trống; không đưa đáp án vào thống kê.
  const fill={itemVersionId:'fill',position:1,prompt:'Điền từ còn thiếu',interactionType:'short_text',
    graderType:'accepted_text',required:true,maxScore:1,options:[]};
  const reference={...fill,itemVersionId:'reference',position:2,graderType:'none',maxScore:0};
  const rows=['correct','incorrect','incorrect'].map((verdict,index)=>({studentRef:'fake-'+index,
    name:'Học viên thử '+index,submissionId:'submission-'+index,gradingStatus:'complete',
    responses:{fill:index===2?'':'Nội dung thử',reference:'Ý kiến thử'},
    responseItems:[{itemVersionId:'fill',answerState:index===2?'blank':'answered'},
      {itemVersionId:'reference',answerState:'answered'}],
    gradingItems:[{itemVersionId:'fill',verdict},{itemVersionId:'reference',verdict:'ungraded'}]}));
  const result=buildQuestionAnalytics({assignmentId:'fake',definition:{formVersionId:'fake-form',blocks:[{items:[fill,reference]}]},students:rows});
  const scored=result.items[0],ungraded=result.items[1];
  assert.equal(scored.objective,true);
  assert.equal(scored.counts.graded,3);assert.equal(scored.counts.correct,1);
  assert.equal(scored.counts.incorrect,2);assert.equal(scored.counts.unanswered,1);
  assert.equal(scored.errorRate,2/3);
  assert.deepEqual(scored.students.map(row=>row.verdict),['correct','incorrect','incorrect']);
  assert.equal(ungraded.objective,false);assert.equal(ungraded.counts.graded,0);
  assert.equal(ungraded.counts.incorrect,0);assert.equal(ungraded.counts.ungraded,3);
  assert.equal(ungraded.errorRate,null);
});
