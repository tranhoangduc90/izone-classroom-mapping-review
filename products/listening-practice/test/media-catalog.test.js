import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadMediaCatalog} from '../src/media-catalog.js';

// Hai audio giả có byte khác nhau: chọn đúng hash, từ chối sai hash hoặc trùng.
test('catalog media nhiều bài giữ đúng tệp theo hash và không chấp nhận ghi đè',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'listening-media-'));
 try{
  const rows=[];
  for(const name of ['one','two']){
   const bytes=Buffer.from('fixture-'+name),audioPath=name+'.wav';await writeFile(path.join(dir,audioPath),bytes);
   rows.push({audioPath,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const file=path.join(dir,'catalog.json');await writeFile(file,JSON.stringify(rows));
  const catalog=await loadMediaCatalog(file);assert.equal(Object.keys(catalog).length,2);
  assert.equal(catalog[rows[1].sha256].audioFile,path.join(dir,'two.wav'));
  await writeFile(file,JSON.stringify([rows[0],rows[0]]));await assert.rejects(()=>loadMediaCatalog(file),/duplicate/);
  await writeFile(file,JSON.stringify([{...rows[0],sha256:rows[1].sha256}]));await assert.rejects(()=>loadMediaCatalog(file),/mismatch/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
