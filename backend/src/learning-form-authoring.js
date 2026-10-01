// Nhận definition/key của nháp: chỉ giữ các nhóm đã có trong sáu phiếu hiện hành.
// Copy tạo ID mới và giữ điều kiện/bố cục; validation báo vị trí cần sửa, không tự thêm loại bài/chấm AI.
import crypto from 'node:crypto';
import {parseFormDefinition,parseFormGradingKey} from './learning-contracts.js';
import {sha256,stableStringify} from './learning-domain.js';

export const AUTHORING_TYPES=Object.freeze([
  {code:'reflection',label:'Câu trả lời mở / nhìn lại bài học'},
  {code:'mcq',label:'Chọn một phương án'},
  {code:'dropdown',label:'Dropdown Matching Headings'},
  {code:'gapfill',label:'Điền từ trong câu / chuỗi lập luận'},
  {code:'numbered_short_texts',label:'Nhóm ô ngắn đánh số'},
  {code:'speaking_checklist',label:'Checklist Speaking'},
  {code:'conditional_explanation',label:'Ô giải thích có điều kiện'},
  {code:'self_reported_score',label:'Số câu đúng học viên tự khai'}
]);

const legacySentenceLines={
  '56000000-0000-4000-8400-000000000004':[
    {title:'Task Response:',parts:['Yêu cầu người viết phải trả lời đúng ',' và ','.']},
    {title:'Coherence and Cohesion:',parts:['Đảm bảo sự liên kết về ',' (Coherence) và liên kết về ',' (Cohesion).']},
    {title:'Lexical Resource:',parts:['Sử dụng từ vựng đảm bảo tính ',' và ','.']},
    {title:'Grammatical Range and Accuracy:',parts:['Sử dụng cấu trúc ngữ pháp đảm bảo tính ',' và ','.']}],
  '56000000-0000-4000-8400-000000000006':[{title:'',parts:['',' và ','.']}]
};

export function authoringType(item) {
  const pair=item.interactionType+':'+item.layoutType;
  if(pair==='long_text:plain_prompt') return 'reflection';
  if(pair==='single_choice:choice_cards') return 'mcq';
  if(pair==='single_choice:matching_heading_dropdown') return 'dropdown';
  if(pair==='short_text:reasoning_chain_completion') return 'gapfill';
  if(pair==='short_text:numbered_short_texts') return item.interactionConfig?.sentenceLines||legacySentenceLines[item.itemVersionId]
    ?'gapfill':'numbered_short_texts';
  if(pair==='multi_choice_group:speaking_issue_checklist') return 'speaking_checklist';
  if(['short_text:conditional_other_text','long_text:inline_option_text'].includes(pair)) return 'conditional_explanation';
  if(pair==='number_score:score_fraction') return 'self_reported_score';
  return null;
}

export class FormAuthoringError extends Error {
  constructor(code,message,issues=[],httpStatus=400) {super(message);this.code=code;this.issues=issues;this.httpStatus=httpStatus;}
}

export function validateAuthoringPayload({definition:rawDefinition,gradingKey:rawKey,requireAnswers=false}) {
  let definition,gradingKey;
  try {definition=parseFormDefinition(rawDefinition);gradingKey=parseFormGradingKey(rawKey);}
  catch(error) {throw new FormAuthoringError('DRAFT_INVALID','Nháp có trường cần sửa.',error.issues||[]);}
  if(gradingKey.formVersionId!==definition.formVersionId) throw new FormAuthoringError('DRAFT_KEY_VERSION_MISMATCH','Đáp án không thuộc phiên bản nháp này.');
  if(Object.keys(gradingKey.groups).length) throw new FormAuthoringError('DRAFT_TYPE_NOT_ALLOWED','Chưa hỗ trợ chấm theo nhóm ngoài các phiếu hiện có.');
  const items=definition.blocks.flatMap(block=>block.items),byId=new Map(items.map(item=>[item.itemVersionId,item]));
  const missing=[];
  for(const item of items) {
    const type=authoringType(item);
    if(!type||!['none','exact_option'].includes(item.graderType)
      ||(item.graderType==='exact_option'&&!['mcq','dropdown'].includes(type))) {
      throw new FormAuthoringError('DRAFT_TYPE_NOT_ALLOWED','Câu '+item.position+' nằm ngoài các dạng Progress Log đang dùng.');
    }
    const key=gradingKey.items[item.itemVersionId];
    if(item.graderType==='exact_option') {
      if(item.maxScore<=0) throw new FormAuthoringError('DRAFT_SCORE_INVALID','Câu chấm khách quan phải có điểm tối đa lớn hơn 0.');
      if(!key) missing.push(item.itemVersionId);
      else if(key.graderType!=='exact_option'||!item.options.some(option=>option.id===key.expectedOptionId)) {
        throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Đáp án câu '+item.position+' không khớp phương án.');
      }
    } else if(key) throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Câu không chấm không được có khóa chấm.');
  }
  for(const id of Object.keys(gradingKey.items)) if(!byId.has(id)) throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Có đáp án tham chiếu câu không tồn tại.');
  for(const id of Object.keys(gradingKey.referenceAnswers||{})) if(!byId.has(id)) throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Có đáp án tham khảo của câu không tồn tại.');
  if(requireAnswers&&missing.length) throw new FormAuthoringError('DRAFT_ANSWER_REQUIRED','Còn '+missing.length+' câu cần chọn đáp án trước khi duyệt.');
  return {definition,gradingKey,missingAnswers:missing,contentHash:sha256(stableStringify({definition,gradingKey}))};
}

export function copyAuthoringPayload(payload,{uuid=()=>crypto.randomUUID()}={}) {
  const checked=validateAuthoringPayload(payload),definition=structuredClone(checked.definition),gradingKey=structuredClone(checked.gradingKey);
  const versionId=uuid(),ids=new Map();
  definition.formVersionId=versionId;gradingKey.formVersionId=versionId;
  for(const block of definition.blocks) {
    block.blockId=uuid();
    for(const item of block.items) {
      const old=item.itemVersionId;ids.set(old,uuid());
      if(legacySentenceLines[old]&&!item.interactionConfig.sentenceLines) item.interactionConfig.sentenceLines=structuredClone(legacySentenceLines[old]);
      // Bản sao vẫn là cùng câu chuyên môn; chỉ phiên bản và định danh điều khiển thay đổi.
      item.itemVersionId=ids.get(old);
    }
  }
  for(const item of definition.blocks.flatMap(block=>block.items)) {
    const dependency=item.interactionConfig.visibleWhenItemVersionId;
    if(dependency) item.interactionConfig.visibleWhenItemVersionId=ids.get(dependency);
  }
  gradingKey.items=Object.fromEntries(Object.entries(gradingKey.items).map(([id,key])=>[ids.get(id),key]));
  if(gradingKey.referenceAnswers) gradingKey.referenceAnswers=Object.fromEntries(Object.entries(gradingKey.referenceAnswers).map(([id,value])=>[ids.get(id),value]));
  return validateAuthoringPayload({definition,gradingKey});
}
