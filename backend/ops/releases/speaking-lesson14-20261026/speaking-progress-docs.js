import { planSpeakingStatusWrite, verifySpeakingStatusWrite } from './speaking-independent-status.js';
import {withTransaction} from './db.js';

const schemas = new Set(['speaking_independent','speaking_homework']);
function table(schema) { if(!schemas.has(schema))throw new Error('DOC_PROGRESS_SCOPE_INVALID');return schema+'.doc_progress'; }
const teacherBase='https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/';
const label=part=>({freestyle:'Speaking chính',speaking:'Speaking chính',paraphrase:'Diễn đạt lại câu hỏi',
  clarify_1:'Làm rõ cấp 1',clarify_2:'Làm rõ cấp 2',clarify_3:'Làm rõ cấp 3',insert_middle:'Chèn điểm giữa',
  reason_action:'Lý do làm một việc',benefit_harm:'Lợi và hại',how_to_do:'Cách làm một việc',
  comparison_direct:'So sánh trực tiếp',comparison_extended:'So sánh mở rộng',story_context:'Xây dựng bối cảnh',
  story_sequence:'Trình tự câu chuyện',story_detail:'Diễn biến chi tiết',object_intro:'Mở bài tả vật',object_description:'Miêu tả chi tiết một vật',object_function:'Tả vật – Chức năng',object_what_if:'Tả vật – What if'})[part];

// Only trusted server state determines progress; no learner text/exercise titles in Docs.
export function progressPayload({parts,links,requiredPracticeCount,receiptId,assignmentCode,documentId,independent}) {
  const required=[...parts.map((p,index)=>({title:parts.length===1?'Speaking chính':p.display_title||p.title||label(p.part_key)||`Speaking ${index+1}`,link:links.find(l=>l.kind==='main'&&l.part===p.part_key)})),
    ...Array.from({length:requiredPracticeCount},(_,i)=>({title:`Bổ trợ ${i+1}`,link:links.find(l=>l.kind==='practice'&&Number(l.slot)===i+1)}))];
  const accepted=required.filter(r=>r.link?.status==='accepted').length;
  const url=new URL(receiptId?'teacher.html':'teacher-progress.html',teacherBase);
  if(receiptId){url.searchParams.set('receipt',receiptId);if(independent)url.searchParams.set('system','independent');}
  else {url.searchParams.set('code',assignmentCode);url.searchParams.set('documentId',documentId);}
  const heading=receiptId?'Đã nộp bài thành công.':accepted===required.length?'Đã xác nhận đủ các phần — đang hoàn tất nộp bài.':`Đã xác nhận ${accepted}/${required.length} phần bắt buộc.`;
  const lines=required.map(({title,link})=>`${title}: ${link?.status==='accepted'?'đã xác nhận'+(link.kind==='main'&&Number(link.question_count)>0?` ${link.question_count} ${['object_intro','object_description','object_function','object_what_if'].includes(link.part)?'lượt':'câu'}`:''):link?.status==='pending'?'đang kiểm tra':link?.status==='rejected'?'chưa được công nhận':'chưa xác nhận'}.`);
  return {text:[heading,...lines,'Giảng viên nhấn vào đây để xem '+(receiptId?'kết quả.':'tiến độ.')].join('\n'),link:url.href,receiptId:receiptId||null};
}

export async function enqueueSpeakingProgress(db,schema,unitId) {
  const target=table(schema);let row,parts,links;
  await db.query(`SELECT id FROM ${schema==='speaking_independent'?'speaking_independent.work_unit':'speaking_homework.access_grant'} WHERE id=$1 FOR UPDATE`,[unitId]);
  if(schema==='speaking_independent'){
    row=(await db.query(`SELECT u.*,r.id AS receipt_id FROM speaking_independent.work_unit u
      LEFT JOIN speaking_independent.receipt r ON r.work_unit_id=u.id WHERE u.id=$1 AND u.revoked_at IS NULL`,[unitId])).rows[0];
    if(!row?.document_id)return;
    parts=row.template.parts;row.required_practice_count=row.template.requiredPracticeCount;
    links=(await db.query(`SELECT DISTINCT ON(kind,part) * FROM speaking_independent.link WHERE work_unit_id=$1 ORDER BY kind,part,revision DESC`,[unitId])).rows;
  }else{
    row=(await db.query(`SELECT g.document_id,a.assignment_code,a.required_practice_count,s.id AS submission_id,r.id AS receipt_id
      FROM speaking_homework.access_grant g JOIN speaking_homework.assignment a ON a.id=g.assignment_id
      JOIN speaking_homework.submission s ON s.access_grant_id=g.id LEFT JOIN speaking_homework.receipt r ON r.submission_id=s.id
      WHERE g.id=$1 AND g.revoked_at IS NULL`,[unitId])).rows[0];
    if(!row?.document_id)return;
    row.tab_id='t.0';
    parts=(await db.query(`SELECT p.part_key,p.display_title FROM speaking_homework.assignment_part p JOIN speaking_homework.submission s ON s.id=$1
      JOIN speaking_homework.access_grant g ON g.id=s.access_grant_id WHERE p.assignment_id=g.assignment_id ORDER BY p.position`,[row.submission_id])).rows;
    links=(await db.query(`SELECT DISTINCT ON(part) part,check_status AS status,question_count,'main' AS kind,NULL::integer AS slot
      FROM speaking_homework.submission_link WHERE submission_id=$1 ORDER BY part,revision DESC`,[row.submission_id])).rows;
    links.push(...(await db.query(`SELECT DISTINCT ON(slot) slot,status,question_count,'practice' AS kind FROM speaking_homework.practice_link
      WHERE access_grant_id=$1 AND slot IS NOT NULL ORDER BY slot,revision DESC`,[unitId])).rows);
  }
  const payload=progressPayload({parts,links,requiredPracticeCount:Number(row.required_practice_count),receiptId:row.receipt_id,
    assignmentCode:row.assignment_code,documentId:row.document_id,independent:schema==='speaking_independent'});
  // Skip untouched work. A late Docs binding still receives all previously accepted parts.
  if(!links.length&&!row.receipt_id)return;
  const previous=(await db.query(`SELECT document_id,tab_id FROM ${target} WHERE unit_id=$1`,[unitId])).rows[0];
  if(previous&&(previous.document_id!==row.document_id||previous.tab_id!==row.tab_id))throw new Error('DOC_IDENTITY_MISMATCH');
  await db.query(`INSERT INTO ${target}(unit_id,document_id,tab_id,assignment_code,payload)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(unit_id) DO UPDATE SET payload=EXCLUDED.payload,
    sequence=${target}.sequence+1,status='pending',attempts=0,error_code=NULL,available_at=now(),updated_at=now()
    WHERE ${target}.document_id=EXCLUDED.document_id AND ${target}.tab_id=EXCLUDED.tab_id AND ${target}.payload IS DISTINCT FROM EXCLUDED.payload`,
    [unitId,row.document_id,row.tab_id,row.assignment_code,JSON.stringify(payload)]);
}

export async function readSpeakingDocsProgress(db,schema,unitId) {
  const row=(await db.query(`SELECT status,error_code,sequence,applied_sequence,verified_at FROM ${table(schema)} WHERE unit_id=$1`,[unitId])).rows[0];
  return row||null;
}

export async function existingSpeakingDocsProgress(db,schema,unitId){
  const exists=(await db.query('SELECT to_regclass($1) IS NOT NULL AS present',[table(schema)])).rows[0]?.present;
  return exists?readSpeakingDocsProgress(db,schema,unitId):null;
}
export async function enqueueExistingSpeakingProgress(db,schema,unitId){
  if(await existingSpeakingDocsProgress(db,schema,unitId))return enqueueSpeakingProgress(db,schema,unitId);
}

export async function restoreSpeakingDocsProgress(pool,schema,unitId){
  const row=await readSpeakingDocsProgress(pool,schema,unitId);
  if(row)return row;
  await withTransaction(pool,db=>enqueueSpeakingProgress(db,schema,unitId));
  return readSpeakingDocsProgress(pool,schema,unitId);
}

// Reuse the guarded Speaking cell planner. Metadata is server owned, not inferred from cell text.
export function planProgressWrite(document,row) {
  checkProgressDocument(document,row);
  return planSpeakingStatusWrite({document,documentId:row.document_id,tabId:row.tab_id,receiptId:row.payload.receiptId,
    teacherBaseUrl:teacherBase+'teacher.html',progress:{...row.payload,lastText:row.last_text,lastLink:row.last_link,
      attemptText:row.attempt_text,attemptLink:row.attempt_link,
      initialStatus:Number(row.applied_sequence)===0&&!row.payload.receiptId}});
}
export function verifyProgressWrite(document,row) {
  checkProgressDocument(document,row);
  return verifySpeakingStatusWrite({document,documentId:row.document_id,tabId:row.tab_id,linkUrl:row.payload.link,expectedText:row.payload.text});
}

function checkProgressDocument(document,row){
  if(document.documentId!==row.document_id)throw new Error('DOC_IDENTITY_MISMATCH');
  const flatten=list=>(list||[]).flatMap(t=>[t,...flatten(t.childTabs)]);
  const tab=flatten(document.tabs).find(t=>t.tabProperties?.tabId===row.tab_id);
  if(!tab)throw new Error('DOC_TAB_NOT_FOUND');
  const text=value=>value?.textRun?value.textRun.content||'':value&&typeof value==='object'?Object.values(value).map(text).join(''):'';
  if(typeof row.assignment_code!=='string'||text(tab.documentTab?.body?.content).split(row.assignment_code).length!==2)throw new Error('DOC_CODE_MISMATCH');
}

export function createSpeakingProgressDocsWorker({pool,schema,gateway}) {
  const target=table(schema);let initialized=false;
  async function once(unitId) {
    if(!gateway)return false;
    if(!initialized){initialized=(await pool.query('SELECT to_regclass($1) IS NOT NULL AS present',[target])).rows[0]?.present===true;if(!initialized)return false;}
    const db=await pool.connect();let lock;
    try{
      const row=(await db.query(`SELECT * FROM ${target} WHERE ${unitId?'unit_id=$1 AND ':''}status IN ('pending','processing')
        AND available_at<=now() ORDER BY updated_at LIMIT 1`,unitId?[unitId]:[])).rows[0];
      if(!row)return false;
      lock='speaking-doc:'+row.document_id;
      if(!(await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[lock])).rows[0].locked){lock=null;return false;}
      // Refetch after locking: another writer may have already applied this version.
      const current=(await db.query(`UPDATE ${target} SET status='processing',attempts=attempts+1 WHERE unit_id=$1
        AND status IN ('pending','processing') AND available_at<=now() RETURNING *`,[row.unit_id])).rows[0];
      if(!current)return false;
      try{
        const document=await gateway.get(current.document_id);
        const plan=planProgressWrite(document,current);
        if(plan.requests.length){
          // Keep the attempted output across a lost ACK, even when a newer snapshot arrives.
          await db.query(`UPDATE ${target} SET attempt_text=$2,attempt_link=$3 WHERE unit_id=$1`,[current.unit_id,current.payload.text,current.payload.link]);
          await gateway.write(current.document_id,{requests:plan.requests,writeControl:{requiredRevisionId:plan.revisionId}});
        }
        const readback=plan.requests.length?await gateway.get(current.document_id):document;
        if(!verifyProgressWrite(readback,current))throw new Error('DOC_READBACK_MISMATCH');
        await db.query(`UPDATE ${target} SET last_text=$2,last_link=$3,attempt_text=NULL,attempt_link=NULL,applied_sequence=$4,
          status=CASE WHEN sequence=$4 THEN 'verified' ELSE 'pending' END,error_code=NULL,attempts=0,available_at=now(),verified_at=now()
          WHERE unit_id=$1`,[current.unit_id,current.payload.text,current.payload.link,current.sequence]);
        if(schema==='speaking_homework'&&current.payload.receiptId)await db.query("SELECT pg_notify('speaking_homework_write_doc_ready','')");
      }catch(error){
        const code=String(error.code||error.message||'DOC_RETRY').slice(0,90);
        const blocked=/DOC_(?:MANUAL|IDENTITY|TAB|CODE|STATUS|HTTP_40[134]|READ_FORBIDDEN|READ_NOT_FOUND)/.test(code)||current.attempts>=8;
        await db.query(`UPDATE ${target} SET status=CASE WHEN sequence<>$2 THEN 'pending' WHEN $3 THEN 'blocked' ELSE 'pending' END,
          error_code=$4,available_at=now()+$5*interval '1 second' WHERE unit_id=$1`,
          [current.unit_id,current.sequence,blocked,code,Math.min(300,2**current.attempts)]);
      }
      return true;
    }finally{if(lock)await db.query('SELECT pg_advisory_unlock(hashtext($1))',[lock]);db.release();}
  }
  return {once};
}

export function startSpeakingProgressDocsWorker(options) {
  const worker=createSpeakingProgressDocsWorker(options);let stopped=false,running=false,timer;
  async function tick(){if(stopped||running)return;running=true;try{for(let n=0;n<4;n++)if(!await worker.once())break;}
    catch(error){console.error('Speaking Docs progress:',String(error.code||'PROGRESS_WORKER_ERROR'));}
    finally{running=false;if(!stopped)timer=setTimeout(tick,2000).unref();}}
  if(options.gateway)timer=setTimeout(tick,0).unref();
  return {async stop(){stopped=true;clearTimeout(timer);while(running)await new Promise(r=>setTimeout(r,100));}};
}
