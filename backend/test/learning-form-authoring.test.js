import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {authoringType,copyAuthoringPayload,validateAuthoringPayload} from '../src/learning-form-authoring.js';
const forms=JSON.parse(await readFile(new URL('./fixtures/progress-log-authoring-public-definitions.json',import.meta.url),'utf8'));
function payload(definition) {
  return {definition,gradingKey:{schemaVersion:'FormGradingKeyV1',formVersionId:definition.formVersionId,
    graderVersion:1,items:{},groups:{}}};
}
test('D01/D02: đủ 57 item của sáu phiếu thuộc tám nhóm; copy đổi ID nhưng giữ nội dung/điều kiện/checkpoint và gapfill',()=>{
  let count=0;const types=new Set(),blanks=[];
  for(const form of forms) {
    const input=payload(form.definition),copy=copyAuthoringPayload(input);
    const before=form.definition.blocks.flatMap(block=>block.items),after=copy.definition.blocks.flatMap(block=>block.items);
    assert.notEqual(copy.definition.formVersionId,form.definition.formVersionId);
    assert.deepEqual(copy.definition.blocks.map(block=>[block.title,block.instructions,block.checkpoint]),
      form.definition.blocks.map(block=>[block.title,block.instructions,block.checkpoint]));
    for(const [i,item] of before.entries()) {
      count++;types.add(authoringType(item));const copied=after[i];
      assert.equal(copied.prompt,item.prompt);assert.equal(copied.required,item.required);
      assert.deepEqual(copied.options,item.options);assert.equal(copied.graderType,item.graderType);
      assert.notEqual(copied.itemVersionId,item.itemVersionId);assert.equal(copied.itemFamilyId,item.itemFamilyId);
      const dependency=item.interactionConfig.visibleWhenItemVersionId;
      if(dependency) assert.equal(copied.interactionConfig.visibleWhenItemVersionId,after[before.findIndex(original=>original.itemVersionId===dependency)].itemVersionId);
      if(authoringType(item)==='gapfill') blanks.push(copied.layoutType==='reasoning_chain_completion'?1:
        copied.interactionConfig.sentenceLines.reduce((n,line)=>n+line.parts.length-1,0));
    }
  }
  assert.equal(count,57);assert.equal(types.size,8);assert.ok(!types.has(null));
  assert.equal(blanks.length,4);assert.equal(blanks.reduce((a,b)=>a+b,0),14);
});
test('D01: không mở grader accepted_text/rubric_async hoặc layout ngoài danh mục; đáp án sai option bị chặn',()=>{
  const input=payload(structuredClone(forms[2].definition));
  const items=input.definition.blocks.flatMap(block=>block.items),scored=items.find(item=>item.graderType==='exact_option');
  input.gradingKey.items[scored.itemVersionId]={graderType:'exact_option',expectedOptionId:'NOT_IN_OPTIONS'};
  assert.throws(()=>validateAuthoringPayload(input),error=>error.code==='DRAFT_ANSWER_INVALID');
  input.gradingKey.items={};
  assert.throws(()=>validateAuthoringPayload({...input,requireAnswers:true}),error=>error.code==='DRAFT_ANSWER_REQUIRED');
  items[0].layoutType='new_essay_layout';
  assert.throws(()=>validateAuthoringPayload(input),error=>error.code==='DRAFT_TYPE_NOT_ALLOWED');
});
