// Container-only operator repair. Input is a private, reviewed allowlist, never a learner request.
// Creates new checks or queues the ordinary Docs worker; never submits, grades, or writes Docs directly.
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {enqueueSpeakingProgress,planProgressWrite,createSpeakingProgressDocsWorker} from '/app/src/speaking-progress-docs.js';
import {createSpeakingProgressGoogle} from '/app/src/speaking-progress-google.js';
const [mode,schema]=process.argv.slice(1);
if(!['recheck','progress'].includes(mode)||!['speaking_homework','speaking_independent'].includes(schema))throw Error('RECOVERY_SCOPE_INVALID');
const rows=JSON.parse(await readFile('/dev/stdin','utf8'));
if(!Array.isArray(rows)||rows.length>30)throw Error('RECOVERY_INPUT_INVALID');
const pool=new pg.Pool({connectionString:process.env[schema==='speaking_homework'?'SPEAKING_HOMEWORK_DATABASE_URL':'INDEPENDENT_DATABASE_URL'],max:3});
const gateway=mode==='progress'?createSpeakingProgressGoogle({credentialFile:process.env.SPEAKING_PROGRESS_DOCS_CREDENTIALS_FILE||process.env.SPEAKING_DOCS_READ_CREDENTIALS_FILE}):null;
const worker=gateway&&createSpeakingProgressDocsWorker({pool,schema,gateway});
function statusCell(doc,tabId){
 const flat=a=>(a||[]).flatMap(t=>[t,...flat(t.childTabs)]),tab=flat(doc.tabs).find(t=>t.tabProperties?.tabId===tabId);
 const text=v=>v?.textRun?v.textRun.content||'':v&&typeof v==='object'?Object.values(v).map(text).join(''):'';
 const cells=[];function walk(a){for(const e of a||[]){if(!e.table)continue;const rows=e.table.tableRows||[];for(let i=0;i<rows.length-1;i++)if(text(rows[i].tableCells?.[0]).trim()==='TÌNH TRẠNG NỘP BÀI SPEAKING')cells.push(rows[i+1].tableCells[0]);for(const r of rows)for(const c of r.tableCells||[])walk(c.content);}}walk(tab?.documentTab?.body?.content);
 if(cells.length!==1)throw Error('DOC_STATUS_CELL_AMBIGUOUS');
 const links=[];function visit(v){if(v?.textRun?.textStyle?.link?.url)links.push(v.textRun.textStyle.link.url);if(v&&typeof v==='object')Object.values(v).forEach(visit);}visit(cells[0]);
 return {text:text(cells[0]).trim(),links:[...new Set(links)].sort()};
}
try{for(const target of rows){
 if((target.schema==='legacy'?'speaking_homework':'speaking_independent')!==schema)throw Error('RECOVERY_SCHEMA_MISMATCH');
 const db=await pool.connect();let outcome;
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='20s'");
  let current;
  if(schema==='speaking_homework')current=(await db.query(`SELECT g.id,g.document_id,g.student_ref,g.revoked_at,a.assignment_code,s.id AS submission_id,s.status,r.id AS receipt_id
    FROM speaking_homework.access_grant g JOIN speaking_homework.assignment a ON a.id=g.assignment_id JOIN speaking_homework.submission s ON s.access_grant_id=g.id
    LEFT JOIN speaking_homework.receipt r ON r.submission_id=s.id WHERE g.id=$1 FOR UPDATE OF g,s`,[target.unit_id])).rows[0];
  else current=(await db.query(`SELECT u.*,p.student_ref,r.id AS receipt_id FROM speaking_independent.work_unit u JOIN speaking_independent.profile p ON p.id=u.profile_id
    LEFT JOIN speaking_independent.receipt r ON r.work_unit_id=u.id WHERE u.id=$1 FOR UPDATE OF u`,[target.unit_id])).rows[0];
  if(!current||current.document_id!==target.document_id||current.assignment_code!==target.assignment_code||current.student_ref!==target.student_ref)throw Error('RECOVERY_IDENTITY_MISMATCH');
  if(current.revoked_at||current.status!=='draft'||current.receipt_id){outcome={status:'skipped_closed'};await db.query('ROLLBACK');}
  else if(mode==='recheck'){
   if(schema!=='speaking_homework'||target.link.kind!=='main')throw Error('RECOVERY_CHECK_SCOPE_INVALID');
   const old=target.link;
   const latest=(await db.query('SELECT * FROM speaking_homework.submission_link WHERE submission_id=$1 AND part=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[current.submission_id,old.part])).rows[0];
   if(latest?.id!==old.id){outcome={status:'skipped_newer_revision'};await db.query('ROLLBACK');}
   else{
    if(latest.check_status!=='rejected'||latest.share_url!==old.share_url||latest.share_id!==old.share_id)throw Error('RECOVERY_LINK_CHANGED');
    const inserted=(await db.query(`INSERT INTO speaking_homework.submission_link(submission_id,part,revision,share_url,share_id)
      VALUES($1,$2,$3,$4,$5) RETURNING id,revision`,[current.submission_id,old.part,latest.revision+1,latest.share_url,latest.share_id])).rows[0];
    await db.query('INSERT INTO speaking_homework.check_job(link_id) VALUES($1)',[inserted.id]);
    await enqueueSpeakingProgress(db,schema,target.unit_id);await db.query('COMMIT');outcome={status:'queued',oldLinkId:old.id,...inserted};
   }
  }else{
   const document=await gateway.get(target.document_id),actual=statusCell(document,target.tab_id);
   await enqueueSpeakingProgress(db,schema,target.unit_id);
   let progress=(await db.query(`SELECT * FROM ${schema}.doc_progress WHERE unit_id=$1 FOR UPDATE`,[target.unit_id])).rows[0];
   if(!progress||progress.payload.receiptId)throw Error('RECOVERY_PROGRESS_SCOPE_INVALID');
   if(actual.text!==progress.payload.text){
    if(actual.text!==target.actual.text||JSON.stringify(actual.links)!==JSON.stringify([...target.actual.links].sort()))throw Error('RECOVERY_DOC_CHANGED');
    if(Number(progress.applied_sequence)!==0)throw Error('RECOVERY_DOC_PREVIOUSLY_MANAGED');
    if(actual.text&&!/^(?:xong|đã hoàn thành đủ|https:\/\/chatgpt\.com\/share\/[a-f0-9-]{36})$/iu.test(actual.text))throw Error('RECOVERY_MANUAL_STATUS_NOT_APPROVED');
    if(actual.links.length>1)throw Error('RECOVERY_MULTIPLE_LINKS');
    await db.query(`UPDATE ${schema}.doc_progress SET last_text=$2,last_link=$3 WHERE unit_id=$1`,[target.unit_id,actual.text,actual.links[0]||'']);
    progress={...progress,last_text:actual.text,last_link:actual.links[0]||''};
   }
   planProgressWrite(document,progress);
   console.log(JSON.stringify({phase:'backup_cell',unitId:target.unit_id,documentId:target.document_id,revision:document.revisionId,actual}));
   await db.query(`UPDATE ${schema}.doc_progress SET status='pending',attempts=0,error_code=NULL,available_at=now() WHERE unit_id=$1`,[target.unit_id]);
   await db.query('COMMIT');outcome={status:'progress_queued'};
  }
 }catch(error){await db.query('ROLLBACK');outcome={status:'blocked',error:String(error.message).slice(0,100)};}
 finally{db.release();}
 if(outcome.status==='progress_queued'){
  await worker.once(target.unit_id);
  outcome={...outcome,progress:(await pool.query(`SELECT status,error_code,sequence,applied_sequence FROM ${schema}.doc_progress WHERE unit_id=$1`,[target.unit_id])).rows[0]};
 }
 console.log(JSON.stringify({phase:mode,unitId:target.unit_id,...outcome}));
}}finally{await pool.end();}
