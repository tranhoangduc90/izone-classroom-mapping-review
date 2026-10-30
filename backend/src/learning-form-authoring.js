// Nhận definition/key của nháp; không cho tạo mới dạng gạch chân đã được Đức yêu cầu gỡ.
// Copy tạo ID mới và giữ điều kiện/bố cục; validation báo vị trí cần sửa, không tự thêm loại bài/chấm AI.
import crypto from 'node:crypto';
import {effectiveItemKind} from './learning-item-kinds.js';
import {parseFormDefinition,parseFormDraftDefinition,parseFormGradingKey} from './learning-contracts.js';
import {sha256,stableStringify} from './learning-domain.js';

export const AUTHORING_TYPES=Object.freeze([
  {code:'reflection',label:'Câu trả lời mở / nhìn lại bài học'},
  {code:'mcq',label:'Chọn một phương án'},
  {code:'multi',label:'Chọn nhiều đáp án'},
  {code:'matching',label:'Nối cặp'},
  {code:'short_answer',label:'Điền từ — đáp án chấp nhận'},
  {code:'dropdown',label:'Dropdown Matching Headings'},
  {code:'gapfill',label:'Điền từ trong câu / chuỗi lập luận'},
  {code:'numbered_short_texts',label:'Nhóm ô ngắn đánh số'},
  {code:'speaking_checklist',label:'Checklist Speaking'},
  {code:'conditional_explanation',label:'Ô giải thích có điều kiện'},
  {code:'self_reported_score',label:'Số câu đúng học viên tự khai'}
]);

// Danh mục tạo mới theo từng phần; reader các phiên bản cũ vẫn giữ các dạng lịch sử.
export const AUTHORING_CATALOG=Object.freeze({
  exercise:['mcq','multi','short_answer','gapfill','dropdown'],
  survey:['mcq','multi','short_answer','gapfill','dropdown','reflection','self_reported_score']
});

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
  if(pair==='multi_choice_group:multiple_choice_cards')return 'multi';
  if(pair==='multi_choice_group:matching_pairs')return 'matching';
  if(pair==='short_text:plain_prompt')return 'short_answer';
  if(pair==='long_text:plain_prompt') return 'reflection';
  if(pair==='single_choice:choice_cards') return 'mcq';
  if(pair==='single_choice:matching_heading_dropdown') return 'dropdown';
  if(pair==='short_text:reasoning_chain_completion') return 'gapfill';
  if(pair==='short_text:numbered_short_texts') return item.interactionConfig?.sentenceLines||legacySentenceLines[item.itemVersionId]
    ?'gapfill':'numbered_short_texts';
  if(pair==='multi_choice_group:speaking_issue_checklist') return 'speaking_checklist';
  if(pair==='multi_choice_group:keyword_selection') return 'keyword_selection';
  if(['short_text:conditional_other_text','long_text:inline_option_text'].includes(pair)) return 'conditional_explanation';
  if(pair==='number_score:score_fraction') return 'self_reported_score';
  return null;
}

export class FormAuthoringError extends Error {
  constructor(code,message,issues=[],httpStatus=400) {super(message);this.code=code;this.issues=issues;this.httpStatus=httpStatus;}
}

// Chỉ xác nhận đúng nội dung/khóa đang xem; đổi câu hoặc key làm xác nhận cũ hết hiệu lực.
export function importReviewContent(item,key){
  return stableStringify({item,answer:key.items[item.itemVersionId]||null,reference:key.referenceAnswers?.[item.itemVersionId]||null});
}

export function validateAuthoringPayload({definition:rawDefinition,gradingKey:rawKey,requireAnswers=false,allowIncomplete=false}) {
  let definition,gradingKey;
  const savingDraft=allowIncomplete&&!requireAnswers;
  try {definition=(savingDraft?parseFormDraftDefinition:parseFormDefinition)(rawDefinition);gradingKey=parseFormGradingKey(rawKey);}
  catch(error) {throw new FormAuthoringError('DRAFT_INVALID','Nháp có trường cần sửa.',error.issues||[]);}
  if(gradingKey.formVersionId!==definition.formVersionId) throw new FormAuthoringError('DRAFT_KEY_VERSION_MISMATCH','Đáp án không thuộc phiên bản nháp này.');
  if(Object.keys(gradingKey.groups).length) throw new FormAuthoringError('DRAFT_TYPE_NOT_ALLOWED','Chưa hỗ trợ chấm theo nhóm ngoài các phiếu hiện có.');
  const items=definition.blocks.flatMap(block=>block.items),byId=new Map(items.map(item=>[item.itemVersionId,item]));
  const missing=[];
  for(const block of definition.blocks) for(const item of block.items) {
    const kind=effectiveItemKind(item,block);if(!kind)continue;
    const type=authoringType(item);
    if(!AUTHORING_CATALOG[kind].includes(type)) throw new FormAuthoringError('DRAFT_PART_TYPE_INVALID',
      'Câu '+item.position+' không thuộc danh mục '+(kind==='survey'?'Khảo sát':'Bài tập')+'. Giữ nội dung và chọn chế độ phù hợp.');
    if(!item.skillCodes.length || item.skillCodes.some(code=>!['general','listening','reading','speaking','writing'].includes(code)))
      throw new FormAuthoringError('DRAFT_SKILL_REQUIRED','Câu '+item.position+': hãy chọn Kỹ năng, hoặc chủ động chọn Chung.',[{itemVersionId:item.itemVersionId,field:'skillCodes',message:'Cần bổ sung thông tin này'}]);
    if(kind==='survey'&&(item.graderType!=='none'||item.maxScore!==0||rawKey.items?.[item.itemVersionId]))
      throw new FormAuthoringError('DRAFT_SURVEY_NOT_SCORED','Khảo sát chỉ ghi nhận thông tin; chuyển đáp án sang đáp án tham khảo trước khi lưu.');
    if(kind==='exercise'&&item.graderType==='none')
      throw new FormAuthoringError('DRAFT_EXERCISE_GRADER_REQUIRED','Câu '+item.position+' trong Bài tập cần luật chấm.',[{itemVersionId:item.itemVersionId,field:'kind',message:'Chọn chế độ và luật chấm phù hợp cho câu hỏi.'}]);
    if(kind==='exercise'&&type==='multi') {
      const count=gradingKey.items[item.itemVersionId]?.expectedOptionIds?.length;
      if(count&&item.interactionConfig.maxSelections!==count) throw new FormAuthoringError('DRAFT_SELECTION_LIMIT_MISMATCH',
        'Câu '+item.position+': giới hạn chọn phải bằng số đáp án đúng.');
    }
  }
  for(const item of items) {
    const type=authoringType(item);
    const allowed={none:AUTHORING_TYPES.map(t=>t.code),exact_option:['mcq','dropdown'],
      exact_option_set:['multi'],exact_sequence:['matching'],accepted_text:['short_answer'],accepted_text_sequence:['gapfill','numbered_short_texts']};
    if(!type||!allowed[item.graderType]?.includes(type)) {
      throw new FormAuthoringError('DRAFT_TYPE_NOT_ALLOWED','Câu '+item.position+' nằm ngoài các dạng Progress Log đang dùng.');
    }
    const key=gradingKey.items[item.itemVersionId];
    if(savingDraft){if(item.graderType!=='none'&&!key)missing.push(item.itemVersionId);continue;}
    if(type==='keyword_selection'&&(item.options.some(option=>/\s/u.test(option.label))
      ||item.interactionConfig.maxSelections>Math.min(10,item.options.length))) {
      throw new FormAuthoringError('DRAFT_KEYWORDS_INVALID','Câu '+item.position+': mỗi lựa chọn cần là một từ; số từ được chọn tối đa không vượt số từ của câu hoặc 10.');
    }
    if(item.graderType!=='none') {
      if(item.maxScore<=0) throw new FormAuthoringError('DRAFT_SCORE_INVALID','Câu chấm khách quan phải có điểm tối đa lớn hơn 0.');
      if(!key) missing.push(item.itemVersionId);
      else if(key.graderType!==item.graderType
        ||(item.graderType==='exact_option'&&!item.options.some(option=>option.id===key.expectedOptionId))
        ||(['exact_option_set','exact_sequence'].includes(item.graderType)
          &&(new Set(key.expectedOptionIds).size!==key.expectedOptionIds.length
            ||key.expectedOptionIds.some(id=>!item.options.some(o=>o.id===id))
            ||(item.graderType==='exact_option_set'&&key.expectedOptionIds.length>(item.interactionConfig.maxSelections||10))
            ||(item.graderType==='exact_sequence'&&key.expectedOptionIds.length!==item.interactionConfig.matchingPrompts.length)))
        ||(item.graderType==='accepted_text'&&key.accepted.some(value=>!value.trim()))
        ||(item.graderType==='accepted_text_sequence'&&(key.acceptedBySlot.length!==item.interactionConfig.responseCount||key.acceptedBySlot.some(accepted=>!accepted.length)))) {
        throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Đáp án câu '+item.position+' không khớp phương án.',[{itemVersionId:item.itemVersionId,field:'answer',message:'Đáp án không khớp các phương án của câu hỏi.'}]);
      }
    } else if(key) throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Câu không chấm không được có khóa chấm.');
  }
  for(const id of Object.keys(gradingKey.items)) if(!byId.has(id)) throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Có đáp án tham chiếu câu không tồn tại.');
  for(const id of Object.keys(gradingKey.referenceAnswers||{})) if(!byId.has(id)) throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Có đáp án tham khảo của câu không tồn tại.');
  for(const [id,slots]of Object.entries(gradingKey.referenceAnswersBySlot||{})) {
    if(!byId.has(id)||slots.length!==byId.get(id).interactionConfig.responseCount)throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Tham khảo từng ô không khớp câu hoặc số ô.');
  }
  for(const [id,state]of Object.entries(gradingKey.authoringState||{})){
    const item=byId.get(id);if(!item)throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Metadata tham chiếu câu không tồn tại.');
    const blankIds=new Set(item.interactionConfig.blankIds||[]);
    for(const blankId of Object.keys(state.sources||{}))if(!blankIds.has(blankId))throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Chữ gốc không khớp mã ô trống.');
    for(const [blankId,rows]of Object.entries(state.answerRows||{})){
      if(item.interactionType!=='short_text')throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Hàng đáp án chỉ dành cho câu điền từ.');
      if(!blankIds.has(blankId)&&!(blankId==='answer'&&!item.interactionConfig.responseCount))throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Hàng đáp án không khớp mã ô trống.');
      if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Mã hàng đáp án bị trùng.');
      if(!savingDraft&&rows.some(row=>!row.value.trim()))throw new FormAuthoringError('DRAFT_ANSWER_REQUIRED','Câu '+item.position+': hãy nhập đáp án hoặc bỏ ô đáp án còn trống.',rows.filter(row=>!row.value.trim()).map(row=>({itemVersionId:id,field:'answer',rowId:row.id,blankId,message:'Cần bổ sung thông tin này'})));
      const block=definition.blocks.find(block=>block.items.some(value=>value.itemVersionId===id)),kind=effectiveItemKind(item,block),survey=kind==='survey'||kind===null&&item.graderType==='none',slot=(item.interactionConfig.blankIds||[]).indexOf(blankId);
      const canonical=item.interactionConfig.responseCount?(survey?gradingKey.referenceAnswersBySlot?.[id]?.[slot]??(gradingKey.referenceAnswers?.[id]?.[slot]?[gradingKey.referenceAnswers[id][slot]]:[]):gradingKey.items[id]?.acceptedBySlot?.[slot]||[]):survey?gradingKey.referenceAnswers?.[id]||[]:gradingKey.items[id]?.accepted||[];
      if(JSON.stringify(rows.map(row=>row.value.trim()).filter(Boolean))!==JSON.stringify(canonical.map(value=>value.trim())))throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Hàng đáp án câu '+item.position+' chưa khớp khóa chấm. Hãy mở lại và kiểm đáp án.');
    }
  }
  for(const id of Object.keys(gradingKey.explanations||{})) if(!byId.has(id)) throw new FormAuthoringError('DRAFT_ANSWER_INVALID','Có lời giải của câu không tồn tại.');
  for(const id of Object.keys(gradingKey.importSources||{}))if(!byId.has(id))throw new FormAuthoringError('DRAFT_IMPORT_SOURCE_INVALID','Dấu vết nguồn không thuộc câu hiện có.');
  for(const [id,review]of Object.entries(gradingKey.importReviews||{})){
    if(!byId.has(id))throw new FormAuthoringError('DRAFT_IMPORT_REVIEW_INVALID','Cảnh báo nhập nguồn không thuộc câu hiện có.');
    if(requireAnswers&&review.reviewedContent!==importReviewContent(byId.get(id),gradingKey))
      throw new FormAuthoringError('DRAFT_IMPORT_REVIEW_REQUIRED',review.sourceLabel+': còn cảnh báo key cần giảng viên xử lý và xác nhận.',[{itemVersionId:id,field:'importReview',message:'Cần kiểm và xác nhận cảnh báo đáp án của câu này.'}]);
  }
  if(requireAnswers&&missing.length) throw new FormAuthoringError('DRAFT_ANSWER_REQUIRED','Còn '+missing.length+' câu cần chọn đáp án trước khi duyệt.',missing.map(id=>({itemVersionId:id,field:'answer',message:'Cần bổ sung thông tin này'})));
  return {definition,gradingKey,missingAnswers:missing,contentHash:sha256(stableStringify({definition,gradingKey}))};
}

export function copyAuthoringPayload(payload,{uuid=()=>crypto.randomUUID()}={}) {
  const checked=validateAuthoringPayload({...payload,allowIncomplete:true}),definition=structuredClone(checked.definition),gradingKey=structuredClone(checked.gradingKey);
  const versionId=uuid(),ids=new Map(),blanks=new Map();
  definition.formVersionId=versionId;gradingKey.formVersionId=versionId;
  for(const block of definition.blocks) {
    block.blockId=uuid();
    for(const item of block.items) {
      const old=item.itemVersionId;ids.set(old,uuid());
      if(legacySentenceLines[old]&&!item.interactionConfig.sentenceLines) item.interactionConfig.sentenceLines=structuredClone(legacySentenceLines[old]);
      // Bản sao vẫn là cùng câu chuyên môn; chỉ phiên bản và định danh điều khiển thay đổi.
      item.itemVersionId=ids.get(old);
      if(item.interactionConfig.blankIds)item.interactionConfig.blankIds=item.interactionConfig.blankIds.map(id=>{const next=uuid();blanks.set(id,next);return next;});
    }
  }
  for(const item of definition.blocks.flatMap(block=>block.items)) {
    const dependency=item.interactionConfig.visibleWhenItemVersionId;
    if(dependency) item.interactionConfig.visibleWhenItemVersionId=ids.get(dependency);
  }
  gradingKey.items=Object.fromEntries(Object.entries(gradingKey.items).map(([id,key])=>[ids.get(id),key]));
  if(gradingKey.savedExerciseKeys)gradingKey.savedExerciseKeys=Object.fromEntries(Object.entries(gradingKey.savedExerciseKeys).filter(([id])=>ids.has(id)).map(([id,key])=>[ids.get(id),key]));
  if(gradingKey.referenceAnswers) gradingKey.referenceAnswers=Object.fromEntries(Object.entries(gradingKey.referenceAnswers).map(([id,value])=>[ids.get(id),value]));
  if(gradingKey.referenceAnswersBySlot) gradingKey.referenceAnswersBySlot=Object.fromEntries(Object.entries(gradingKey.referenceAnswersBySlot).map(([id,value])=>[ids.get(id),value]));
  if(gradingKey.authoringState)gradingKey.authoringState=Object.fromEntries(Object.entries(gradingKey.authoringState).map(([id,state])=>[ids.get(id),{
    ...(state.exerciseShape?{exerciseShape:remapExerciseShape(state.exerciseShape,blanks)}:{}),
    ...(state.sources?{sources:Object.fromEntries(Object.entries(state.sources).map(([blankId,text])=>[blanks.get(blankId),text]))}:{}),
    ...(state.answerRows?{answerRows:Object.fromEntries(Object.entries(state.answerRows).map(([blankId,rows])=>[blanks.get(blankId)||blankId,rows.map(row=>({...row,id:uuid()}))]))}:{})
  }]));
  if(gradingKey.explanations) gradingKey.explanations=Object.fromEntries(Object.entries(gradingKey.explanations).map(([id,value])=>[ids.get(id),value]));
  if(gradingKey.importSources)gradingKey.importSources=Object.fromEntries(Object.entries(gradingKey.importSources).map(([id,value])=>[ids.get(id),value]));
  if(gradingKey.importReviews)gradingKey.importReviews=Object.fromEntries(Object.entries(gradingKey.importReviews).map(([id,value])=>{
    const {reviewedContent,...review}=value;return [ids.get(id),review];
  }));
  return validateAuthoringPayload({definition,gradingKey,allowIncomplete:true});
}

function remapExerciseShape(value,blanks){
  try{const shape=JSON.parse(value);if(Array.isArray(shape)&&Array.isArray(shape[1]))shape[1]=shape[1].map(id=>blanks.get(id)||id);else if(Array.isArray(shape.blanks))shape.blanks=shape.blanks.map(id=>blanks.get(id)||id);return JSON.stringify(shape);}catch{return value;}
}
