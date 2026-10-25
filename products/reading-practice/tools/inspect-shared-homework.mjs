import pg from 'pg';
import {OAuth2Client} from 'google-auth-library';
import {createDocsAdapter} from '../src/docs.js';
import {createSharedHomeworkResolver} from '../src/shared-homework.js';
import {ROBOTS_CODE} from '../src/lessons.js';
import {hash} from '../src/domain.js';

// Chỉ đọc mapping, bài đã hoàn thành và Docs để chuẩn bị/đối chiếu sau cập nhật bù.
// --documents xuất cấu trúc Docs vào kho riêng tư; mặc định chỉ xuất ID, hash và trạng thái.
const args=process.argv.slice(2);
if(args.some(a=>a!=='--documents'))throw new Error('Invalid argument');
const pool=new pg.Pool({connectionString:process.env.READING_DATABASE_URL,max:1,statement_timeout:10000});
const auth=new OAuth2Client(process.env.READING_DOCS_CLIENT_ID,process.env.READING_DOCS_CLIENT_SECRET);
auth.setCredentials({refresh_token:process.env.READING_DOCS_REFRESH_TOKEN});
const docs=createDocsAdapter(auth),resolve=createSharedHomeworkResolver({url:process.env.READING_OWNER_SOURCE_URL,key:process.env.READING_OWNER_SOURCE_KEY,auth,docs});
const records=[];
try{
 const role=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
 if(role.db!=='reading_practice_db'||role.role!=='reading_practice_app')throw new Error('Reading database required');
 const rows=(await pool.query(`SELECT b.*,a.class_id,a.class_code,c.code,w.state,w.updated_at
  FROM reading_practice.binding b JOIN reading_practice.assignment a ON a.id=b.assignment_id
  JOIN reading_practice.content c ON c.id=a.content_id JOIN reading_practice.work w ON w.binding_id=b.id
  WHERE c.code=$1 AND b.document_id IS NULL AND b.owner_proof->>'mode'='shared'
  AND w.state->>'firstCompleted' IS NOT NULL ORDER BY b.id`,[ROBOTS_CODE])).rows;
 for(const b of rows){
  const record={bindingId:b.id,studentRef:b.student_ref,classCode:b.class_code,stateHash:hash(JSON.stringify(b.state)),updatedAt:b.updated_at};
  try{
   const target=await resolve(b),document=await docs.read(target.documentId);
   records.push({...record,outcome:'success',target,documentHash:hash(JSON.stringify(document)),...(args.includes('--documents')?{document}:{})});
  }catch(e){records.push({...record,outcome:'failure',code:e.code||e.name});}
 }
 console.log(JSON.stringify({outcome:records.some(r=>r.outcome==='failure')?'partial':'success',records}));
 if(records.some(r=>r.outcome==='failure'))process.exitCode=2;
}finally{await pool.end();}
