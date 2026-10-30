// Hợp nhất kết quả lịch sử và hai kho Test hiện hành bằng cùng lớp/UUID học viên.
// Chỉ SELECT; lỗi một nguồn làm kết quả tạm chưa sẵn sàng thay vì lấy điểm cũ làm điểm mới.
import pg from 'pg';
import {createAssessmentSchemaPool} from './assessment-schema-pool.js';
import {createLearningTestResultReader} from './learning-test-results.js';

export function combineLearningTestReaders(readers){
  if(!Array.isArray(readers)||!readers.length||readers.some(reader=>!reader?.readStudent||!reader?.readWriting||!reader?.readClass))throw Error('TEST_SOURCES_INVALID');
  function merge(batches,classView=false){
    const selected=new Map();
    for(const batch of batches)for(const row of batch){
      const result=classView?row.result:row,key=(classView?row.studentRef+':':'')+result.testSlug;
      const timestamp=Date.parse(result.completedAt),previous=selected.get(key);
      if(!Number.isFinite(timestamp))throw Error('TEST_RESULT_ROW_INVALID');
      // Nguồn hiện hành được đặt sau lịch sử, ưu tiên khi thời điểm bằng nhau.
      if(!previous||timestamp>=Date.parse((classView?previous.result:previous).completedAt))selected.set(key,row);
    }
    return [...selected.values()];
  }
  const read=async input=>merge(await Promise.all(readers.map(reader=>reader(input))));
  read.readStudent=async input=>merge(await Promise.all(readers.map(reader=>reader.readStudent(input))));
  read.readClass=async input=>merge(await Promise.all(readers.map(reader=>reader.readClass(input))),true);
  read.readWriting=async input=>{
    const current=await read.readStudent(input);
    if(!current.some(row=>row.testSlug===input.testSlug&&row.resultRef===input.resultRef&&row.writing?.status==='ready'))return null;
    const results=(await Promise.all(readers.map(reader=>reader.readWriting(input)))).filter(Boolean);
    if(results.length>1&&results.some(result=>JSON.stringify(result)!==JSON.stringify(results[0])))throw Error('TEST_RESULT_SOURCE_CONFLICT');
    return results[0]||null;
  };
  return read;
}

export function createLearningTestSources({config,legacyPool,Pool=pg.Pool}){
  // Server thật phải có đủ hai tuyến; createApp vẫn nhận reader giả để kiểm local.
  if(!config.learningTestK56DatabaseUrl||!config.learningTestK67DatabaseUrl)throw Error('Cần cấu hình nguồn Test chỉ đọc K56 và K67 cho Progress Log.');
  const pools=[];
  for(const [family,connectionString] of [['k56',config.learningTestK56DatabaseUrl],['k67',config.learningTestK67DatabaseUrl]]){
    const pool=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
      statement_timeout:6000,options:'-c default_transaction_read_only=on',application_name:'progress_log_test_reader_'+family});
    pool.on('error',()=>console.error('Nguồn Test Progress Log tạm lỗi kết nối.'));
    pools.push(createAssessmentSchemaPool(pool,{family}));
  }
  return {reader:combineLearningTestReaders([legacyPool,...pools].map(pool=>createLearningTestResultReader({pool}))),
    close:()=>Promise.all(pools.map(pool=>pool.end()))};
}
