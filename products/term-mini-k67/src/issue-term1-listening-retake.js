import {z} from 'zod';
import {loadConfig} from './config.js';
import {createDatabasePool,verifyDatabaseBoundary} from './db.js';
import {findStudentForTermTestSql} from './sql.js';
import {issueTerm1RetakeGrant} from './term1-listening-retake.js';

const options=z.tuple([z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),z.uuid()])
  .rest(z.string()).refine(args=>args.length<=3);

async function issue(args){
  const [classCode,studentRef,hours='24']=options.parse(args);
  const validHours=z.coerce.number().int().min(1).max(72).parse(hours);
  const config=loadConfig();
  if(config.term1ListeningRetakeMode!=='on')throw new Error('RETAKE_DISABLED');
  const pool=createDatabasePool(config);
  try{
    await verifyDatabaseBoundary(pool,config);
    const result=await pool.query(findStudentForTermTestSql,[classCode,'term-test-1',studentRef]);
    if(result.rowCount!==1)throw new Error('RETAKE_SCOPE');
    const grant=issueTerm1RetakeGrant({classCode,studentRef},
      config.term1ListeningRetakeSecret||config.termTestSessionSecret,{validHours});
    const link=new URL('https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/term-test-1-listening-retake/');
    link.search=new URLSearchParams({class:classCode,student:studentRef,retake:grant}).toString();
    process.stdout.write(`${link.href}\n`);
  }finally{
    await pool.end();
  }
}

try{
  await issue(process.argv.slice(2));
}catch(error){
  const message=error.message==='RETAKE_SCOPE'?'Không tìm thấy đúng một học viên đủ quyền trong lớp đã chọn.'
    :error.message==='RETAKE_DISABLED'?'Luồng thi bù chưa mở cấp vé.'
      :'Không cấp được vé. Kiểm tra cấu hình và cú pháp: MÃ_LỚP UUID_HỌC_VIÊN [GIỜ_HIỆU_LỰC].';
  process.stderr.write(`${message}\n`);
  process.exitCode=1;
}
