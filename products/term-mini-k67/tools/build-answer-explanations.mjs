// Đọc bản Docs đã lưu và đề hiện hành; xuất lời giải riêng tư theo đúng kỹ năng/câu.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const [root,out,definitionFile,contentDir]=process.argv.slice(2);
if(!root||!out||!definitionFile||!contentDir)throw new Error('Cần thư mục nguồn riêng, thư mục xuất riêng và file định nghĩa đề đã kiểm và thư mục đề gốc.');
const ids=["1NhUDePQZ8XXlSDexD2GLFPFbiz22XH8hK7S8COLQDn0","1EK0UQOS3J5JDk2uwmhGbsJjDLfWjrDo0B80AkpriZI0","12nxXb6ngqVu9Uy6KPQfQ99W81HIa1EO2dQEub1ayH6I","1pX0_7JTU7ng38P1L7t4GXV9juqQOKVFSdQc69H1-Y7I"];
const docs=await Promise.all(ids.map(async id=>JSON.parse(await fs.readFile(root+'/drive/'+id+'.raw.json','utf8'))));
const tables=docs.map(d=>d.tabs[0].documentTab.body.content.filter(x=>x.table).map(x=>x.table.tableRows));
const defs=JSON.parse(await fs.readFile(definitionFile,'utf8'));
const hex=c=>c?'#'+['red','green','blue'].map(k=>Math.round((c[k]||0)*255).toString(16).padStart(2,'0')).join(''):null;
const paras=cell=>(cell?.content||[]).flatMap(x=>x.paragraph?[x.paragraph.elements.filter(x=>x.textRun).map(x=>({text:x.textRun.content.replace(/\u000b/g,'\n'),bold:!!x.textRun.textStyle?.bold,italic:!!x.textRun.textStyle?.italic,foreground:hex(x.textRun.textStyle?.foregroundColor?.color?.rgbColor),background:hex(x.textRun.textStyle?.backgroundColor?.color?.rgbColor)}))]:[]).filter(p=>p.some(r=>r.text.trim()));
const text=p=>p.map(r=>r.text).join('');
const promptParas=cell=>{const result=[];let seen=false;for(const x of cell.content||[]){if(!x.paragraph)continue;const p=paras({content:[x]})[0];if(p){seen=true;result.push(p);}else if(seen)break;}return result;};
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const bundles=[];
for(const def of defs){
 const raw=await fs.readFile(contentDir+'/'+def.slug+'/content.json','utf8');const content=JSON.parse(raw);
 const bundle={schemaVersion:1,testSlug:def.slug,definitionVersion:def.version,contentSha256:crypto.createHash('sha256').update(raw).digest('hex'),skills:{}};
 for(const skill of ['listening','reading']){
  const sd=def[skill+'_definition'];bundle.skills[skill]={entries:{}};
  for(const q of sd.questions){
   let di=0,ti=0,start,end,correct;const n=q.number;
   if(def.slug==='term-test-1'){
    if(skill==='listening'){
     if(n<=10){ti=0;start=n;end=n+1;}
     else if(n<=14){ti=1;start=1+(n-11)*4;end=start+4;correct=[start+1];}
     else if(n<=20){ti=1;start=n+3;end=start+1;}
     else if(n<=22){ti=2;start=1;end=6;correct=[2];}
     else if(n<=24){ti=2;start=6;end=12;correct=[7,8];}
     else if(n<=30){ti=2;start=n-11;end=start+1;}
     else {ti=3;start=n-30;end=start+1;}
    }else{
     if(n<=13){ti=4;start=n+(n>=8?1:0);end=start+1;}
     else if(n<=20){ti=5;start=n-13;end=start+1;}
     else if(n<=24){ti=5;start=n-11;end=start+1;}
     else if(n<=26){ti=5;start=15;end=20;correct=[16];}
     else if(n<=30){ti=6;start=1+(n-27)*5;end=start+5;correct=[start+1];}
     else if(n<=34){ti=6;start=n-9;end=start+1;}
     else{ti=6;start=n-8;end=start+1;}
    }
   }else if(skill==='reading'){di=1;ti=0;if(n<=19){start=n-13;end=start+1;}else if(n<=21){start=8;end=14;correct=[9,10];}else if(n<=23){start=14;end=20;correct=[15,16];}else {start=n-3;end=start+1;}}
   else{di=n<=20?2:3;ti=0;const first=n<=20?11:21;if(n<first+6){start=1+(n-first)*4;end=Math.min(start+4,n===16?24:25);correct=[start+1];}else{start=n<=20?n+9:n-1;end=start+1;}}
   const rows=tables[di][ti];const selected=rows.slice(start,end);if(!selected.length)throw Error('missing rows '+q.number);
   const blocks=selected.map((r,i)=>({row:start+i,analysis:paras(r.tableCells[0]),evidence:paras(r.tableCells[1])}));
   const correctBlocks=correct?blocks.filter(b=>correct.includes(b.row)):blocks;
   const evidence=correctBlocks.flatMap(b=>b.evidence);if(!evidence.length)throw Error('missing evidence '+def.slug+skill+n);
   const range=content[skill].sections.findIndex(s=>{const a=s.range.match(/\d+/g).map(Number);return n>=a[0]&&n<=a[1]});if(range<0)throw Error('missing section');
   const answer=q.pairGroup?sd.pairGroups[q.pairGroup].expected:q.accepted;
   bundle.skills[skill].entries[n]={number:n,section:range,type:q.type,answers:answer,pairNumbers:q.pairGroup?sd.pairGroups[q.pairGroup].numbers:null,prompt:promptParas(selected[0].tableCells[0]),evidence,blocks,source:{documentId:ids[di],tabId:docs[di].tabs[0].tabProperties.tabId,table:ti,rows:[start,end-1]}};
  }
 }
 bundle.definitionSha256=crypto.createHash('sha256').update(canonical({listening:def.listening_definition,reading:def.reading_definition})).digest('hex');
 await fs.mkdir(out+'/assets/'+def.slug,{recursive:true});await fs.writeFile(out+'/assets/'+def.slug+'/explanations.json',JSON.stringify(bundle,null,2)+'\n');await fs.writeFile(out+'/assets/'+def.slug+'/content.json',raw);bundles.push(bundle);
}
console.log(JSON.stringify(bundles.map(b=>({slug:b.testSlug,count:Object.fromEntries(Object.entries(b.skills).map(([k,v])=>[k,Object.keys(v.entries).length]))}))));
