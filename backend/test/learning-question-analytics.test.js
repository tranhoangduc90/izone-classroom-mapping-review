import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildQuestionAnalytics} from '../src/learning-question-analytics.js';

test('R09: phiếu lịch sử không khai báo options vẫn thống kê được, key chỉ được truyền vào nhánh giáo viên',()=>{
  const item={itemVersionId:'legacy',position:1,prompt:'Câu mở',interactionType:'long_text',graderType:'none',maxScore:0};
  const result=buildQuestionAnalytics({assignmentId:'a',definition:{formVersionId:'v',blocks:[{items:[item]}]},students:[]});
  assert.deepEqual(result.items[0].options,[]);assert.equal(result.items[0].correctAnswer,null);
  const question={...item,interactionType:'single_choice',graderType:'exact_option',maxScore:1,options:[{id:'A',label:'Đáp án nguồn'}]};
  const teacher=buildQuestionAnalytics({assignmentId:'a',definition:{formVersionId:'v',blocks:[{items:[question]}]},
    gradingKey:{items:{legacy:{expectedOptionId:'A'}}},students:[]});
  assert.deepEqual(teacher.items[0].correctAnswer,['Đáp án nguồn']);
  assert.deepEqual(teacher.items[0].correctOptionIds,['A']);
});

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

test('Phần đã nộp hiện trước khi có verdict, chấm đúng phiên bản và dùng final đúng một lần',()=>{
  const formVersionId=randomUUID(),blockId=randomUUID(),otherBlockId=randomUUID(),itemVersionId=randomUUID();
  const setupItem={...objective,itemFamilyId:randomUUID(),itemVersionId,pedagogicalTypeCode:'multiple_choice',
    layoutType:'plain_prompt',helpText:'',groupId:null,skillCodes:['reading'],releasePolicy:'inherit'};
  const nextItem={...setupItem,itemFamilyId:randomUUID(),itemVersionId:randomUUID(),position:2};
  const definition={schemaVersion:'FormDefinitionV1',formVersionId,title:'Phiếu kiểm phần',kind:'quiz',
    answerReleasePolicy:'teacher_release',blocks:[
      {blockId,checkpoint:1,title:'Phần một',items:[setupItem]},
      {blockId:otherBlockId,checkpoint:2,title:'Phần hai',items:[nextItem]}
    ]};
  const gradingKey={schemaVersion:'FormGradingKeyV1',formVersionId,graderVersion:1,
    items:{[itemVersionId]:{graderType:'exact_option',expectedOptionId:'A'},
      [nextItem.itemVersionId]:{graderType:'exact_option',expectedOptionId:'A'}}};
  const response={ [itemVersionId]:'A' };
  const row={studentRef:'s1',name:'Học viên mẫu',submissionId:null,
    checkpoints:[{blockId,checkpointSubmissionId:randomUUID(),responses:response}]};
  const build=(students,key=null)=>buildQuestionAnalytics({assignmentId:'demo',definition,gradingKey:key,
    includeCheckpoints:true,summaryOnly:true,students});
  const before=build([row]);
  assert.deepEqual(before.parts.map(part=>part.submittedCount),[1,0]);
  assert.equal(before.items[0].counts.answered,1);
  assert.equal(before.items[0].counts.pending,1);
  assert.equal(before.items[0].counts.incorrect,0);
  assert.equal(before.items[1].counts.submitted,0);
  const graded=build([row],gradingKey);
  assert.equal(graded.items[0].counts.correct,1);
  assert.equal(graded.items[0].counts.pending,0);
  assert.notEqual(graded.items[0].responseVersion,before.items[0].responseVersion);
  const mismatched=build([row],{...gradingKey,formVersionId:randomUUID()});
  assert.equal(mismatched.items[0].counts.answered,1);
  assert.equal(mismatched.items[0].counts.pending,1);
  const after=build([{...row,submissionId:'final',responses:{[itemVersionId]:'B'},
    responseItems:[{itemVersionId,answerState:'answered'}],gradingItems:[{itemVersionId,verdict:'incorrect'}]}],gradingKey);
  assert.equal(after.submittedCount,1);
  assert.equal(after.items[0].counts.answered,1);
  assert.equal(after.items[0].counts.correct,0);
  assert.equal(after.items[0].counts.incorrect,1);
});

test('Nháp đổi lựa chọn, điều kiện hiển thị và bản nộp trống không tính trùng',()=>{
  const second={...objective,itemVersionId:'q2',position:3,
    interactionConfig:{visibleWhenItemVersionId:'q1',visibleWhenValue:'B'}};
  const multi={...objective,itemVersionId:'multi',position:2,interactionType:'multi_choice_group',
    graderType:'exact_option_set'};
  const definition={formVersionId:'form',blocks:[{blockId:'first',items:[objective,multi]},
    {blockId:'second',items:[second]}]};
  const draftResponses={q1:'B',q2:'A',multi:['A','B','A']};
  const row={studentRef:'fake',name:'Ca kiểm',draftResponses};
  const build=(student,options={})=>buildQuestionAnalytics({assignmentId:'fake',definition,
    includeCheckpoints:true,includeDrafts:true,summaryOnly:true,students:[student],...options});
  const active=build(row);
  assert.deepEqual(active.parts.map(p=>p.draftCount),[1,1]);
  assert.deepEqual(active.items.map(i=>i.counts.draftAnswered),[1,1,1]);
  assert.deepEqual(active.items[1].choices.map(c=>c.draftCount),[1,1]);
  assert.deepEqual(active.items[0].choices.map(c=>c.draftCount),[0,1]);
  assert.equal(active.items[0].counts.graded,0);
  assert.equal(build({...row,draftResponses:{...draftResponses,q1:'A'}}).items[2].counts.draftAnswered,0);
  const skipped=build({...row,checkpoints:[{blockId:'first',checkpointSubmissionId:'checkpoint',responses:{}}]});
  assert.deepEqual(skipped.parts.map(p=>[p.draftCount,p.submittedCount]),[[0,1],[0,0]]);
  assert.equal(skipped.items[0].counts.unanswered,1);
  const final=build({...row,submissionId:'final',responses:{q1:'A'},
    responseItems:[{itemVersionId:'q1',answerState:'answered'}],gradingItems:[{itemVersionId:'q1',verdict:'correct'}]});
  assert.equal(final.items[0].counts.answered,1);
  assert.equal(final.items[0].counts.correct,1);
  assert.equal(final.items[0].counts.draftAnswered,0);
  const detail=build(row,{summaryOnly:false,itemVersionId:'q1'});
  assert.equal(detail.items[0].students[0].answer,'B');
  assert.equal(active.items[0].responseVersion,detail.items[0].responseVersion);
});
