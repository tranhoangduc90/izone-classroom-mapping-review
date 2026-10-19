import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Nhận đúng app.js đã đọc từ K56. Chỉ thêm import/mount đường xem tiến trình;
// mọi byte cũ giữ nguyên để không ghi đè các sửa production chưa có trên main.
// Nguồn khác hash hoặc đích đã có thì dừng, không phát hành hoặc tự ghi đè.
const expected='fa7eb1af8d62db5e50e59f04cd31a5beba18daf6e7bd0c5de534e8376dbf6f8c';
const addedImport="import {mountTeacherSavedProgress} from './k56-teacher-saved-progress.js';\n";
const anchor="  app.get('/api/term-tests/teacher/options', testReadLimiter, authenticate, asyncRoute(async (req, res) => {";
const mount="  mountTeacherSavedProgress(app,{pool,authenticate,limiter:testReadLimiter});\n";
export function patchK56TeacherApp(bytes){
 if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('K56_SOURCE_CHANGED: cần đọc và đối chiếu lại nguồn đang chạy.');
 const source=bytes.toString('utf8');if(source.split(anchor).length!==2)throw new Error('K56_MOUNT_ANCHOR_INVALID');
 return Buffer.from(addedImport+source.replace(anchor,mount+anchor),'utf8');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [source,target]=process.argv.slice(2);if(!source||!target)throw new Error('Cần đường dẫn nguồn và đích mới.');
 const bytes=patchK56TeacherApp(await readFile(source));await writeFile(target,bytes,{flag:'wx'});
 process.stdout.write(JSON.stringify({ok:true,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})+'\n');
}
