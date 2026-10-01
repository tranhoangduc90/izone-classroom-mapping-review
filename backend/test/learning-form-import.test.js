import test from 'node:test';
import assert from 'node:assert/strict';
import {previewFormImport,readDelimitedText} from '../src/learning-form-import.js';
const cell=value=>'"'+String(value).replaceAll('"','""')+'"';
function csv(rows){return rows.map(row=>row.map(cell).join(',')).join('\r\n');}
test('D05: CSV có nháy, phẩy, xuống dòng và Unicode giữ nội dung; văn bản tab được xem trước',()=>{
  const prompt='Em thấy "ý tưởng", nào hữu ích?\nHãy nói rõ bằng tiếng Việt.';
  const options=JSON.stringify([{id:'A',label:'Có, và giải thích'},{id:'B',label:'Chưa rõ'}]);
  const preview=previewFormImport(csv([['type','prompt','options','answer'],['mcq',prompt,options,'A']]));
  assert.deepEqual(preview.errors,[]);assert.equal(preview.rows[0].prompt,prompt);
  assert.equal(preview.payload.definition.blocks[0].items[0].options[0].label,'Có, và giải thích');
  const item=preview.payload.definition.blocks[0].items[0];
  assert.equal(preview.payload.gradingKey.items[item.itemVersionId].expectedOptionId,'A');
  const tab=previewFormImport('type\tprompt\nreflection\tCâu hỏi tiếng Việt');
  assert.deepEqual(tab.errors,[]);assert.equal(tab.rows[0].type,'reflection');
});
test('D01/D05: lỗi cả lô không tạo payload và không bỏ âm thầm câu lạ/đáp án sai',()=>{
  const preview=previewFormImport(csv([['type','prompt'],['reflection','Câu tốt'],['essay_ai','Dạng chưa cho phép']]));
  assert.equal(preview.rows.length,1);assert.equal(preview.payload,null);assert.equal(preview.errors[0].line,3);
  assert.throws(()=>readDelimitedText('type,prompt\nreflection,"Thiếu nháy'),error=>error.code==='IMPORT_CSV_INVALID');
  assert.equal(previewFormImport('prompt,prompt\nx,y').payload,null);
  assert.equal(previewFormImport('prompt,type\n"x"z,reflection').payload,null);
});
test('D05: gapfill và ô có điều kiện giữ slot và liên kết ID, không biến thành chấm điểm',()=>{
  const options=JSON.stringify([{id:'OTHER',label:'Khác'},{id:'NONE',label:'Không có'}]);
  const preview=previewFormImport(csv([
    ['type','prompt','options','graded','alias','depends_on','when','config'],
    ['mcq','Vấn đề Speaking?',options,'false','speaking','','',''],
    ['conditional_explanation','Nêu rõ vấn đề khác.','','','','speaking','OTHER',''],
    ['gapfill','Điền hai ô.','','','','','','{"sentenceLines":[{"parts":["A "," và ","."]}]}']
  ]));
  assert.deepEqual(preview.errors,[]);
  const items=preview.payload.definition.blocks.flatMap(block=>block.items);
  assert.equal(items[1].interactionConfig.visibleWhenItemVersionId,items[0].itemVersionId);
  assert.equal(items[1].required,false);assert.equal(items[2].interactionConfig.responseCount,2);
  assert.ok(items.every(item=>item.graderType==='none'));
});

test('D05: phần xen kẽ vẫn theo thứ tự dòng nguồn, ô phụ không bị kéo trước câu điều khiển',()=>{
  const preview=previewFormImport(csv([
    ['type','prompt','block_title','options','graded','alias','depends_on','when'],
    ['reflection','Câu đầu','Phần A','','','','',''],
    ['mcq','Câu điều khiển','Phần B','[{"id":"A","label":"A"},{"id":"B","label":"B"}]','false','parent','',''],
    ['conditional_explanation','Ô phụ','Phần A','','','','parent','A']
  ]));
  assert.deepEqual(preview.errors,[]);
  assert.deepEqual(preview.payload.definition.blocks.map(block=>block.title),['Phần A','Phần B','Phần A']);
  assert.deepEqual(preview.payload.definition.blocks.flatMap(block=>block.items).map(item=>item.prompt),['Câu đầu','Câu điều khiển','Ô phụ']);
});
