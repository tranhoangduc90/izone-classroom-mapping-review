import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {loadReview} from './review.js';

// Đọc manifest riêng tư của nhiều audio; từng tệp phải khớp hash trước mở API.
// Không có catalog thì giữ đường audio cũ. Lỗi tệp/mốc làm khởi động thất bại rõ ràng.
export async function loadMediaCatalog(file){
 if(!file)return {};
 const rows=JSON.parse(await readFile(file,'utf8')),catalog={};
 if(!Array.isArray(rows))throw new Error('Invalid private media catalog');
 for(const row of rows){
  const audioFile=path.resolve(path.dirname(file),row.audioPath);
  const hash=createHash('sha256').update(await readFile(audioFile)).digest('hex');
  if(hash!==row.sha256||catalog[hash])throw new Error('Audio hash mismatch or duplicate');
  catalog[hash]={audioFile,review:row.reviewPath?await loadReview(path.resolve(path.dirname(file),row.reviewPath),hash):null};
 }
 return catalog;
}
