// Google Docs giả cho test worker thật: giữ vùng nhập tay và áp dụng các request trong ô trạng thái.
// Không gọi Google; sai document/tab/phạm vi ghi làm test lỗi, không tự sửa fixture để khớp output.
import assert from 'node:assert/strict';

export function homeworkDocsFixture({code,documentId,tabId,cta,entryUrl,prefix,heading}){
 const manual='Em đã nộp bài ạ — link em giữ riêng.',manualLink='https://manual.test/original';
 let value=manual,autoLink='',writes=0;
 const paragraph=(start,text,link='')=>({paragraph:{elements:[{startIndex:start,endIndex:start+text.length+1,textRun:{content:text+'\n',textStyle:{link:link?{url:link}:undefined}}}]}});
 const docs={
  read:async id=>{
   assert.equal(id,documentId);
   const elements=[{startIndex:300,endIndex:300+manual.length,textRun:{content:manual,textStyle:{link:{url:manualLink},bold:true}}}];
   if(value.length>manual.length)elements.push({startIndex:300+manual.length,endIndex:300+value.length,textRun:{content:value.slice(manual.length),textStyle:{link:autoLink?{url:autoLink}:undefined}}});
   elements.push({startIndex:300+value.length,endIndex:301+value.length,textRun:{content:'\n'}});
   return{documentId,revisionId:'fixture-revision-'+writes,tabs:[{tabProperties:{tabId},documentTab:{body:{content:[paragraph(1,code),paragraph(100,cta,entryUrl),{table:{tableRows:[{tableCells:[{content:[paragraph(200,heading)]}]},{tableCells:[{content:[{paragraph:{elements}}]}]}]}}]}}}]};
  },
  write:async(id,plan)=>{
   assert.equal(id,documentId);assert.equal(plan.revisionId,'fixture-revision-'+writes);
   for(const req of plan.requests){
    if(req.deleteContentRange){const r=req.deleteContentRange.range;assert.equal(r.tabId,tabId);assert.ok(r.startIndex>=300+manual.length);value=value.slice(0,r.startIndex-300)+value.slice(r.endIndex-300);}
    if(req.insertText){const at=req.insertText.location.index;assert.equal(req.insertText.location.tabId,tabId);assert.ok(at>=300+manual.length);value=value.slice(0,at-300)+req.insertText.text+value.slice(at-300);}
    if(req.updateTextStyle){const r=req.updateTextStyle.range;assert.equal(r.tabId,tabId);assert.ok(r.startIndex>=300+manual.length);if(req.updateTextStyle.fields.includes('link'))autoLink=req.updateTextStyle.textStyle.link?.url||'';}
   }
   assert.equal(value.slice(0,manual.length),manual);assert.ok(value.slice(manual.length).startsWith('\n'+prefix));writes++;
  }
 };
 return{docs,manual,manualLink,get value(){return value;},get link(){return autoLink;},get writes(){return writes;}};
}
