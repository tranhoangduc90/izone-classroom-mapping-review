import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Nhận app K67 đúng bản đang chạy, chỉ thêm lối giảng viên theo dõi bản đã lưu.
// Giữ nguyên các byte và hành vi cũ; sai nguồn hoặc đích đã có thì báo lỗi, không ghi đè.
export const LIVE_K67_APP_SHA256='039b460b102e3c18a2d8c505150f262d6a9f46980a38ce8b91fe81c35940482d';
export function patchK67TeacherApp(bytes){
 if(createHash('sha256').update(bytes).digest('hex')!==LIVE_K67_APP_SHA256)throw new Error('K67_SOURCE_DRIFT');
 let text=bytes.toString('utf8');const newline=text.includes('\r\n')?'\r\n':'\n';
 const add=(anchor,before)=>{if(text.split(anchor).length!==2)throw new Error('K67_ANCHOR_CONFLICT');text=text.replace(anchor,before+anchor);};
 add("import { findTermTestClientEventAttemptSql }", "import {mountTeacherSavedProgress} from './teacher-saved-progress.js';"+newline+"import {mountReadinessTeacher} from './readiness-teacher.js';"+newline);
 add('  // Tuyến làm quen có limiter/phiên riêng,', '  // Đọc giảng viên đứng trước catch-all học viên, giữ auth và giới hạn riêng.'+newline+'  const readinessTeacherRoutes=express.Router();'+newline+'  app.use(readinessTeacherRoutes);'+newline);
 add("  app.get('/api/term-tests/teacher/options', testReadLimiter, authenticate, requireContext,",'  mountTeacherSavedProgress(app,{pool,authenticate,requireContext,limiter:testReadLimiter,auth});'+newline+'  mountReadinessTeacher(readinessTeacherRoutes,{pool,config,authenticate,requireContext,limiter:testReadLimiter,auth});'+newline);
 return Buffer.from(text,'utf8');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [source,target]=process.argv.slice(2);if(!source||!target||source===target)throw new Error('SOURCE_AND_NEW_TARGET_REQUIRED');
 const result=patchK67TeacherApp(await readFile(source));await writeFile(target,result,{flag:'wx'});
 console.log(JSON.stringify({ok:true,bytes:result.length,sha256:createHash('sha256').update(result).digest('hex')}));
}
