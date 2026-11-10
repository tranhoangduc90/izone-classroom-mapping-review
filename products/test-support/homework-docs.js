// Google Docs giả cho test worker thật: giữ vùng nhập tay và áp dụng các request trong ô trạng thái.
// Không gọi Google; sai document/tab/phạm vi ghi làm test lỗi, không tự sửa fixture để khớp output.
import assert from 'node:assert/strict';

// Model UTF-16 positions and field masks so verification sees what was actually written.
export function docsTextBuffer(start, initial='', initialStyle={}) {
 const characters=(text,style={})=>text.split('').map(content=>({content,style}));
 const data=characters(initial,initialStyle);
 return {
  get text(){return data.map(ch=>ch.content).join('');},
  get link(){return data.findLast(ch=>ch.style.link)?.style.link.url||'';},
  elements(){
   return [...data, ...characters('\n')].map(({content,style},i)=>({
    startIndex:start+i,endIndex:start+i+1,textRun:{content,textStyle:style},
   }));
  },
  apply(request){
   if(request.insertText){
    const {location,text}=request.insertText;
    data.splice(location.index-start,0,...characters(text));
   }
   if(request.deleteContentRange){
    const {startIndex,endIndex}=request.deleteContentRange.range;
    data.splice(startIndex-start,endIndex-startIndex);
   }
   if(request.updateTextStyle){
    const {range,textStyle,fields}=request.updateTextStyle;
    for(const ch of data.slice(range.startIndex-start,range.endIndex-start)){
     ch.style={...ch.style};
     for(const field of fields.split(',')){
      if(field in textStyle)ch.style[field]=textStyle[field];
      else delete ch.style[field];
     }
    }
   }
  },
 };
}

export function homeworkDocsFixture({code,documentId,tabId,cta,entryUrl,prefix,heading,codeInTable=false}){
 const manual='Em đã nộp bài ạ — link em giữ riêng.',manualLink='https://manual.test/original';
 const buffer=docsTextBuffer(300,manual,{link:{url:manualLink},bold:true});
 let writes=0;
 const paragraph=(start,text,link='')=>({paragraph:{elements:[{startIndex:start,endIndex:start+text.length+1,textRun:{content:text+'\n',textStyle:{link:link?{url:link}:undefined}}}]}});
 const docs={
  read:async id=>{
   assert.equal(id,documentId);
   const elements=buffer.elements();
   const rows=[...(codeInTable?[{tableCells:[{content:[paragraph(150,code)]}]}]:[]),{tableCells:[{content:[paragraph(200,heading)]}]},{tableCells:[{content:[{paragraph:{elements}}]}]}];
   return{documentId,revisionId:'fixture-revision-'+writes,tabs:[{tabProperties:{tabId},documentTab:{body:{content:[...(!codeInTable?[paragraph(1,code)]:[]),paragraph(100,cta,entryUrl),{table:{tableRows:rows}}]}}}]};
  },
  write:async(id,plan)=>{
   assert.equal(id,documentId);assert.equal(plan.revisionId,'fixture-revision-'+writes);
   for(const req of plan.requests){
    if(req.deleteContentRange){const r=req.deleteContentRange.range;assert.equal(r.tabId,tabId);assert.ok(r.startIndex>=300+manual.length);}
    if(req.insertText){const at=req.insertText.location.index;assert.equal(req.insertText.location.tabId,tabId);assert.ok(at>=300+manual.length);}
    if(req.updateTextStyle){const r=req.updateTextStyle.range;assert.equal(r.tabId,tabId);assert.ok(r.startIndex>=300+manual.length);}
    buffer.apply(req);
   }
   const value=buffer.text;
   assert.equal(value.slice(0,manual.length),manual);assert.ok(value.slice(manual.length).startsWith('\n'+prefix));writes++;
  }
 };
 return{docs,manual,manualLink,get value(){return buffer.text;},get link(){return buffer.link;},get writes(){return writes;}};
}
