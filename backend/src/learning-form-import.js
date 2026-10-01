// Nhận CSV hoặc văn bản phân cột tab, giữ nguyên Unicode/nháy/phẩy/xuống dòng trong ô.
// Trả bản xem trước cùng lỗi có số dòng; không ghi DB, bỏ dòng lỗi hoặc phát hành phiếu.
import crypto from 'node:crypto';
import {AUTHORING_TYPES,FormAuthoringError,validateAuthoringPayload} from './learning-form-authoring.js';
const columns=new Set(['type','prompt','checkpoint','block_title','options','answer','required','config',
  'display_number','skill','alias','depends_on','when','graded']);

export function readDelimitedText(raw,{delimiter}={}) {
  if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>240000) throw new FormAuthoringError('IMPORT_TOO_LARGE','Chỉ nhập tối đa 240 KB văn bản mỗi lần.');
  const text=raw.replace(/^\uFEFF/u,'');
  const separator=delimiter||(text.split(/\r?\n/u)[0].includes('\t')?'\t':',');
  if(![',','\t'].includes(separator)) throw new FormAuthoringError('IMPORT_DELIMITER_INVALID','Chỉ hỗ trợ CSV hoặc các cột cách bằng tab.');
  const rows=[];let row=[],cell='',quoted=false,closed=false,line=1,rowLine=1;
  function cellEnd(){row.push(cell);cell='';closed=false;}
  function rowEnd(){cellEnd();rows.push({line:rowLine,values:row});row=[];rowLine=line+1;}
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(quoted) {
      if(char==='"') {if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}
      else {cell+=char;if(char==='\n') line++;}
      continue;
    }
    if(char==='"') {
      if(cell||closed) throw new FormAuthoringError('IMPORT_CSV_INVALID','Dấu nháy không hợp lệ ở dòng '+line+'.');
      quoted=true;continue;
    }
    if(char===separator){cellEnd();continue;}
    if(char==='\n'||char==='\r') {
      if(char==='\r'&&text[i+1]==='\n') i++;
      rowEnd();line++;continue;
    }
    if(closed) throw new FormAuthoringError('IMPORT_CSV_INVALID','Có ký tự sau dấu nháy đóng ở dòng '+line+'.');
    cell+=char;
  }
  if(quoted) throw new FormAuthoringError('IMPORT_CSV_INVALID','Thiếu dấu nháy đóng từ dòng '+rowLine+'.');
  if(cell||row.length||closed) {cellEnd();rows.push({line:rowLine,values:row});}
  return rows;
}

function boolean(value,fallback) {
  if(value==='') return fallback;
  if(['true','1','có'].includes(value.trim().toLocaleLowerCase('vi'))) return true;
  if(['false','0','không'].includes(value.trim().toLocaleLowerCase('vi'))) return false;
  throw new Error('Giá trị có/không phải là true/false, 1/0 hoặc Có/Không.');
}
function object(value) {
  const result=value?JSON.parse(value):{};
  if(!result||typeof result!=='object'||Array.isArray(result)) throw new Error('config cần là một object JSON.');
  return result;
}

export function previewFormImport(raw,{definition:baseDefinition,gradingKey:baseKey,uuid=()=>crypto.randomUUID()}={}) {
  let data;
  try {data=readDelimitedText(raw);}
  catch(error) {return {rows:[],errors:[{line:0,message:error.message}],payload:null};}
  const errors=[],types=new Set(AUTHORING_TYPES.map(type=>type.code));
  if(data.length<2) return {rows:[],errors:[{line:1,message:'Cần dòng tiêu đề và ít nhất một câu hỏi.'}],payload:null};
  const header=data[0].values.map(value=>value.trim());
  if(new Set(header).size!==header.length||!header.includes('prompt')||header.some(value=>!columns.has(value))) {
    return {rows:[],errors:[{line:1,message:'Tiêu đề thiếu prompt, trùng cột hoặc có cột chưa hỗ trợ.'}],payload:null};
  }
  const items=[],rows=[],aliases=new Map(),blocks=new Map();
  const definition=baseDefinition?structuredClone(baseDefinition):{schemaVersion:'FormDefinitionV1',formVersionId:uuid(),
    title:'Phiếu nhập từ văn bản',kind:'mixed',answerReleasePolicy:'hidden',blocks:[]};
  const gradingKey=baseKey?structuredClone(baseKey):{schemaVersion:'FormGradingKeyV1',formVersionId:definition.formVersionId,graderVersion:1,items:{},groups:{}};
  let position=Math.max(0,...definition.blocks.flatMap(block=>block.items).map(item=>item.position)),lastBlockKey='',currentBlock=null;
  for(const record of data.slice(1)) {
    if(record.values.every(value=>value==='')) continue;
    if(record.values.length!==header.length) {errors.push({line:record.line,message:'Số cột không khớp tiêu đề.'});continue;}
    const value=Object.fromEntries(header.map((key,i)=>[key,record.values[i]]));
    try {
      const config=object(value.config),options=value.options?JSON.parse(value.options):[];
      if(!Array.isArray(options)) throw new Error('options cần là một mảng JSON gồm id và label.');
      const type=(value.type||'').trim()||(options.length?'mcq':'reflection');
      if(!types.has(type)) throw new Error('Dạng bài chưa được hỗ trợ: '+type+'.');
      const checkpoint=Number(value.checkpoint||1);
      if(!Number.isInteger(checkpoint)||checkpoint<1||checkpoint>3) throw new Error('checkpoint phải là 1, 2 hoặc 3.');
      const item={itemVersionId:uuid(),itemFamilyId:uuid(),position:++position,prompt:value.prompt,
        helpText:'',required:boolean(value.required||'',true),options,interactionConfig:config,
        graderType:'none',maxScore:0,pedagogicalTypeCode:'reflection',layoutType:'plain_prompt',interactionType:'long_text',
        skillCodes:(value.skill||'').split(/[\s;]+/u).filter(Boolean),evidenceSource:'student_self_report'};
      if(value.display_number) item.displayNumber=value.display_number;
      if(['mcq','dropdown'].includes(type)) {
        item.interactionType='single_choice';item.layoutType=type==='mcq'?'choice_cards':'matching_heading_dropdown';
        item.pedagogicalTypeCode=type==='mcq'?'multiple_choice':'matching_headings';
        if(boolean(value.graded||'',true)) {
          item.graderType='exact_option';item.maxScore=1;
          if(value.answer) gradingKey.items[item.itemVersionId]={graderType:'exact_option',expectedOptionId:value.answer.trim()};
        } else if(value.answer) throw new Error('Câu không chấm không được nhập đáp án.');
      } else if(type==='numbered_short_texts'||type==='gapfill') {
        item.interactionType='short_text';item.layoutType='numbered_short_texts';item.pedagogicalTypeCode='sentence_completion';
        if(type==='gapfill') {
          if(config.beforeText&&config.afterText) item.layoutType='reasoning_chain_completion';
          else if(config.sentenceLines) config.responseCount=config.sentenceLines.reduce((n,row)=>n+row.parts.length-1,0);
          else throw new Error('Gapfill cần sentenceLines hoặc beforeText + afterText trong config.');
        } else if(config.sentenceLines) throw new Error('Chọn gapfill cho các ô nằm trong câu.');
      } else if(type==='speaking_checklist') {
        item.interactionType='multi_choice_group';item.layoutType='speaking_issue_checklist';item.pedagogicalTypeCode='speaking_reflection';
        config.maxSelections??=Math.min(2,options.length);
      } else if(type==='self_reported_score') {
        item.interactionType='number_score';item.layoutType='score_fraction';item.pedagogicalTypeCode='score_self_report';
      } else if(type==='conditional_explanation') {
        const parent=aliases.get(value.depends_on);
        if(!parent) throw new Error('depends_on cần alias của câu lựa chọn đứng trước.');
        item.required=false;config.visibleWhenItemVersionId=parent.itemVersionId;config.visibleWhenValue=value.when;
        config.requiredWhenVisible=true;item.interactionType=parent.layoutType==='speaking_issue_checklist'?'long_text':'short_text';
        item.layoutType=item.interactionType==='long_text'?'inline_option_text':'conditional_other_text';
      }
      if(!['mcq','dropdown'].includes(type)&&(value.answer||value.graded)) throw new Error('Các dạng này chưa chấm tự động; bỏ answer/graded.');
      if(value.alias) {
        if(aliases.has(value.alias)) throw new Error('alias bị trùng.');
        aliases.set(value.alias,item);
      }
      const blockTitle=value.block_title||'Phần '+checkpoint,key=checkpoint+':'+blockTitle;
      // Giữ đúng thứ tự dòng nhập; hai đoạn cùng tên nhưng cách nhau không được gom rồi đảo câu phụ thuộc.
      if(key!==lastBlockKey){currentBlock={blockId:uuid(),checkpoint,title:blockTitle,instructions:'',items:[]};blocks.set(currentBlock.blockId,currentBlock);lastBlockKey=key;}
      currentBlock.items.push(item);items.push(item);rows.push({line:record.line,type,prompt:item.prompt,checkpoint,
        optionCount:options.length,required:item.required,slotCount:config.responseCount||1,graderType:item.graderType});
    } catch(error) {errors.push({line:record.line,message:error.message});}
  }
  if(!rows.length&&!errors.length) errors.push({line:2,message:'Không có câu hỏi để nhập.'});
  if(errors.length) return {rows,errors,payload:null};
  definition.blocks.push(...blocks.values());
  try {
    const checked=validateAuthoringPayload({definition,gradingKey});
    return {rows,errors,payload:{definition:checked.definition,gradingKey:checked.gradingKey},
      missingAnswers:checked.missingAnswers,contentHash:checked.contentHash};
  } catch(error) {
    return {rows,errors:[{line:0,message:error.message,issues:error.issues||[]}],payload:null};
  }
}
