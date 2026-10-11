import { createHash, createHmac, randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { parseSpeakingShareUrl, SpeakingHomeworkError } from './speaking-homework.js';

const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (code,message,status=409) => { throw new SpeakingHomeworkError(code,message,status); };
const latestSql = `SELECT DISTINCT ON(kind,part) * FROM speaking_independent.link
  WHERE work_unit_id=$1 ORDER BY kind,part,revision DESC`;

// Đầu vào: danh tính đã đối soát và mẫu bài từ nguồn sở hữu, không cần bài giao.
// Lưu bài/biên nhận/hàng xử lý riêng; phần kiểm hội thoại tiếp tục dùng bộ kiểm Speaking.
// Lỗi trả mã rõ ràng, transaction giữ bài cũ khi không thể chốt bài mới.
export function createIndependentSpeaking({pool,accessSecret,source,documents}) {
  if (String(accessSecret).length < 32) throw new Error('INDEPENDENT_ACCESS_SECRET_REQUIRED');
  const token = u => createHmac('sha256',accessSecret).update(`${u.id}:${u.identity_ref}`).digest('base64url');
  async function context(input) { return source.context(input); }
  async function unitContext(u) {
    // Tên tự chọn chỉ thuộc hồ sơ Docs; chưa nhập lịch sử của hồ sơ đã duyệt.
    const selected=u.profile_kind==='document' && !u.course_id && u.student_ref;
    const c=await context({assignmentCode:u.assignment_code,...(u.student_ref?{
      classCode:u.class_code,...(selected?{}:{studentRef:u.student_ref})}:{})});
    if(selected && !c.selectionStudents?.some(s=>s.student_ref===u.student_ref))
      fail('STUDENT_NOT_ACTIVE','Học viên không còn trong danh sách đang học của lớp.',403);
    return c;
  }
  async function classes({assignmentCode}) {
    const c=await context({assignmentCode});
    return Promise.all(c.classes.map(async s=>{
      const status=c.template.lesson<6 ? (await context({assignmentCode,classCode:s.class_code})).template.assignmentStatus||'open':'open';
      return {classCode:s.class_code,classRef:String(s.class_id),ready:status==='open',assignmentStatus:status};
    }));
  }
  async function roster(input) {
    if(input.documentId) {
      const old=await source.legacyOpen?.(input);if(old)return old;
      if(documents)return documents.open(input);
      fail('DOCUMENT_INTAKE_PENDING','Chưa đọc được bản Docs; bạn có thể mở link web trực tiếp.');
    }
    const c=await context(input);
    return {...c.template,classCode:c.scope.class_code,students:c.students.map(s=>({student_ref:s.student_ref,name:s.name})),assignmentStatus:c.template.assignmentStatus||'open'};
  }
  async function resolveIdentity({assignmentCode,studentRef}) {
    const list=await classes({assignmentCode});
    const matches=[];
    for (const c of list) {
      const r=await roster({assignmentCode,classCode:c.classCode});
      if (r.students.some(s=>s.student_ref===studentRef)) matches.push(c.classCode);
    }
    return matches.length===1 ? {status:'unique',classCode:matches[0]} : {status:matches.length?'ambiguous':'missing'};
  }
  async function startSelected(input) {
    // Một bài web đã mở phải tiếp tục là bài đó, kể cả Docs cũ đến sau.
    // Truy vấn chỉ đọc; chưa có bài web mới hỏi cầu nối lịch sử.
    let hasWeb=false;
    if(source.legacySession && !input.documentId) {
      const existing=await pool.query(`SELECT u.id FROM speaking_independent.work_unit u
        JOIN speaking_independent.profile p ON p.id=u.profile_id
        WHERE p.class_code=$1 AND p.student_ref=$2 AND u.assignment_code=$3
          AND u.context_key='web' AND u.revoked_at IS NULL`,
        [input.classCode,input.studentRef,input.assignmentCode]);
      if(existing.rows.length>1)fail('SOURCE_CONFLICT','Có nhiều bài cá nhân cùng mã; cần giảng viên kiểm tra.');
      hasWeb=existing.rows.length===1;
    }
    const old=hasWeb?null:await source.legacySession?.(input);
    if(old)return old;
    if(input.documentId && documents) return documents.start(input);
    if (input.documentId) fail('DOCUMENT_INTAKE_PENDING','Chưa đọc được nội dung Docs. Bạn vẫn có thể mở link web trực tiếp.');
    const c=await context(input);
    if (!c.member) fail('STUDENT_NOT_ACTIVE','Chọn đúng tên học viên trong lớp.',403);
    if(!hasWeb && c.template.assignmentStatus && c.template.assignmentStatus!=='open')
      fail(c.template.assignmentStatus==='closed'?'HOMEWORK_CLOSED':'HOMEWORK_DRAFT','Bài này chưa nhận lượt nộp mới.',403);
    return withTransaction(pool,async db=>{
      const key=`member:${c.scope.class_id}:${c.member.student_ref}`;
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
      const {rows:[p]}=await db.query(`INSERT INTO speaking_independent.profile
        (identity_ref,profile_key,kind,class_id,class_code,student_ref,student_name,course_id)
        VALUES($1,$2,'member',$3,$4,$1,$5,$6) ON CONFLICT(profile_key) DO UPDATE
        SET student_name=EXCLUDED.student_name,class_code=EXCLUDED.class_code RETURNING *`,
      [c.member.student_ref,key,c.scope.class_id,c.scope.class_code,c.member.name,c.scope.course_id]);
      const id=randomUUID();
      const accessToken=token({id,identity_ref:p.identity_ref});
      const bound=(await db.query(`SELECT u.* FROM speaking_independent.source_binding b
        JOIN speaking_independent.work_unit u ON u.id=b.work_unit_id
        WHERE b.student_ref=$1 AND b.assignment_code=$2 AND b.course_id=$3 AND b.status='linked'`,
      [c.member.student_ref,input.assignmentCode,c.scope.course_id])).rows;
      if(new Set(bound.map(u=>u.id)).size>1) fail('SOURCE_CONFLICT','Có nhiều bài cá nhân cùng mã; cần giảng viên kiểm tra.');
      const {rows:[u]}=bound.length ? {rows:[bound[0]]} : await db.query(`INSERT INTO speaking_independent.work_unit
        (id,profile_id,assignment_code,context_key,template,template_digest,origin,token_hash)
        VALUES($1,$2,$3,'web',$4,$5,'web',$6)
        ON CONFLICT(profile_id,assignment_code,context_key) DO UPDATE SET profile_id=EXCLUDED.profile_id RETURNING *`,
      [id,p.id,input.assignmentCode,JSON.stringify(c.template),c.template.digest,hash(accessToken)]);
      // Chỉ lấy dữ liệu cá nhân cũ khi khởi tạo; không ghi ngược vào Doctor của bài cũ.
      if (u.id===id) for (const r of c.recommendations) await db.query(`INSERT INTO speaking_independent.doctor_recommendation
        (profile_id,exercise_id,recommendation_count,practice_count,waiting,proposed_at,last_practiced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[p.id,r.exercise_id,r.recommendation_count,r.practice_count,r.waiting,r.proposed_at,r.last_practiced_at]);
      const actualProfile=(await db.query('SELECT identity_ref FROM speaking_independent.profile WHERE id=$1',[u.profile_id])).rows[0];
      return {accessToken:token({...u,identity_ref:actualProfile.identity_ref}),studentRef:p.identity_ref,
        classCode:p.class_code,documentId:u.document_id,workUnitId:u.id};
    });
  }
  async function grant(identity,db=pool,lock=false) {
    const {rows:[u]}=await db.query(`SELECT u.*,p.identity_ref,p.kind AS profile_kind,p.class_id,p.class_code,p.student_ref,
      p.student_name,p.course_id FROM speaking_independent.work_unit u
      JOIN speaking_independent.profile p ON p.id=u.profile_id
      WHERE u.token_hash=$1 AND (p.identity_ref=$2 OR p.student_ref=$2) AND u.revoked_at IS NULL ${lock?'FOR UPDATE OF u':''}`,
    [hash(identity.accessToken),identity.studentRef]);
    if (!u) fail('SESSION_INVALID','Phiên làm bài không còn hợp lệ. Hãy mở lại bài.',403);
    // Danh sách đã nhớ không cấp quyền: kiểm đăng ký hiện hành ở mỗi lượt.
    await unitContext(u);
    return u;
  }
  async function links(id,db=pool) { return (await db.query(latestSql,[id])).rows; }
  async function queue(db,u,kind,key,link=null) {
    await db.query(`INSERT INTO speaking_independent.job(work_unit_id,kind,dedupe_key,link_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,[u,kind,key,link]);
  }
  async function open(identity) {
    const u=await grant(identity);
    const all=await links(u.id);
    const {rows:jobs}=await pool.query('SELECT kind,status,link_id FROM speaking_independent.job WHERE work_unit_id=$1',[u.id]);
    const {rows:[receipt]}=await pool.query('SELECT id,created_at FROM speaking_independent.receipt WHERE work_unit_id=$1',[u.id]);
    return {status:u.status,receipt:receipt||null,workUnitId:u.id,documentId:u.document_id,
      links:all.filter(l=>l.kind==='main').map(l=>{const review=jobs.some(j=>j.link_id===l.id&&j.kind==='check_main'&&j.status==='review');return {...l,check_status:review?'rejected':l.status,check_code:review?'CHECK_REVIEW_REQUIRED':l.check_code};}),
      practiceLinks:all.filter(l=>l.kind==='practice').map(l=>{const review=jobs.some(j=>j.link_id===l.id&&j.kind==='check_practice'&&j.status==='review');return {...l,status:review?'rejected':l.status,check_code:review?'CHECK_REVIEW_REQUIRED':l.check_code,analysis_status:jobs.find(j=>j.link_id===l.id&&j.kind==='analyze_practice')?.status||null};}),
      processing:Object.fromEntries(jobs.filter(j=>!j.link_id).map(j=>[j.kind,{status:j.status}]))};
  }
  async function request(identity,{part,slot=null,exerciseId=null,rawUrl,kind}) {
    const share=parseSpeakingShareUrl(rawUrl);
    return withTransaction(pool,async db=>{
      const u=await grant(identity,db,true);
      if (u.status==='submitted' && (kind==='main'||slot!==null)) fail('HOMEWORK_SUBMITTED','Bài đã nộp được giữ nguyên; bạn có thể chọn Luyện thêm.');
      let title=null,min=null;
      if (kind==='main') {
        const p=u.template.parts.find(p=>p.part_key===part);
        if (!p) fail('INVALID_PART','Phần bài chưa hợp lệ.',400);
        min=Number(p.min_questions);
      } else {
        const c=await unitContext(u);
        const e=c.exercises.find(e=>e.id===exerciseId);
        if (!e) fail('EXERCISE_NOT_FOUND','Bài luyện chưa có trong danh mục.',404);
        title=e.title;
        if (slot===null) {
          if (u.status!=='submitted') fail('HOMEWORK_REQUIRED','Nộp Homework trước khi luyện thêm.');
          slot=Math.max(2,...(await links(u.id,db)).filter(l=>l.kind==='practice').map(l=>l.slot))+1;
        }
        part=`practice_${slot}`;
      }
      const all=await links(u.id,db);
      const old=all.find(l=>l.kind===kind&&l.part===part);
      if (old?.share_url===share.url && old.exercise_id===exerciseId && old.status!=='rejected') return {id:old.id,status:old.status};
      if (all.some(l=>l.part!==part && (l.share_id===share.shareId || (kind==='practice'&&l.kind==='practice'&&l.slot<=2&&slot<=2&&l.exercise_id===exerciseId))))
        fail('SAME_CONVERSATION','Mỗi phần cần một hội thoại riêng và hai bài bổ trợ khác nhau.');
      const linkOnly=kind==='main'&&min===0;
      const {rows:[l]}=await db.query(`INSERT INTO speaking_independent.link
        (work_unit_id,kind,part,slot,exercise_id,exercise_title,revision,share_url,share_id,status,fingerprint,question_count,checked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $10='accepted' THEN now() END) RETURNING *`,
      [u.id,kind,part,slot,exerciseId,title,(old?.revision||0)+1,share.url,share.shareId,linkOnly?'accepted':'pending',linkOnly?hash(`link-only:${share.shareId}`):null,linkOnly?0:null]);
      if (!linkOnly) await queue(db,u.id,kind==='main'?'check_main':'check_practice',`check:${l.id}`,l.id);
      return {id:l.id,status:l.status};
    });
  }
  async function finish(identity) {
    return withTransaction(pool,async db=>{
      const u=await grant(identity,db,true);
      if (u.status==='submitted') return (await db.query('SELECT id,created_at FROM speaking_independent.receipt WHERE work_unit_id=$1',[u.id])).rows[0];
      const all=await links(u.id,db);
      const main=u.template.parts.map(p=>all.find(l=>l.kind==='main'&&l.part===p.part_key));
      if (main.some(l=>!l||l.status!=='accepted')) fail('ALL_LINKS_REQUIRED','Cần xác nhận đủ các phần Speaking trước khi nộp.');
      const required=Array.from({length:u.template.requiredPracticeCount},(_,i)=>all.find(l=>l.kind==='practice'&&l.slot===i+1));
      if (required.some(l=>!l||l.status!=='accepted') || new Set(required.map(l=>l?.exercise_id)).size!==required.length)
        fail('PRACTICE_LINKS_REQUIRED','Cần xác nhận hai bài bổ trợ khác nhau.');
      const total=[...main,...required];
      if (new Set(total.map(l=>l.share_id)).size!==total.length || new Set(total.map(l=>l.fingerprint)).size!==total.length)
        fail('SAME_CONVERSATION','Mỗi phần cần hội thoại riêng.');
      try { for (const l of total) await db.query('SELECT speaking_independent.reserve_claim($1)',[l.id]); }
      catch(e) { if(e.code==='23505') fail('REUSED_CONVERSATION','Một hội thoại đã được nộp ở bài khác trong khóa. Hãy dùng hội thoại mới.'); throw e; }
      const {rows:[r]}=await db.query('INSERT INTO speaking_independent.receipt(work_unit_id) VALUES($1) RETURNING id,created_at',[u.id]);
      await db.query("UPDATE speaking_independent.work_unit SET status='submitted',submitted_at=now() WHERE id=$1",[u.id]);
      await queue(db,u.id,'analyze_homework',`doctor:${r.id}`);
      if (u.document_id) await queue(db,u.id,'write_doc',`doc:${r.id}:${u.document_id}`);
      return r;
    });
  }
  async function catalog(u) {
    const c=await unitContext(u);
    return {exercises:c.exercises,digest:hash(JSON.stringify(c.exercises))};
  }
  async function listDoctor(identity) {
    const u=await grant(identity);
    const c=await catalog(u);
    const doctorId=(await pool.query('SELECT coalesce(linked_profile_id,id) AS id FROM speaking_independent.profile WHERE id=$1',[u.profile_id])).rows[0].id;
    const {rows}=await pool.query('SELECT * FROM speaking_independent.doctor_recommendation WHERE profile_id=$1',[doctorId]);
    const personal=rows.flatMap(r=>{const e=c.exercises.find(e=>e.id===r.exercise_id);return e?[{...r,title:e.title,exercise_url:e.exercise_url}]:[];});
    personal.sort((a,b)=>Number(b.waiting)-Number(a.waiting)||b.recommendation_count-a.recommendation_count||a.title.localeCompare(b.title));
    const needed=personal.filter(r=>r.waiting);
    return {needed:needed.slice(0,5),allNeeded:needed,neededCount:needed.length,practiced:personal.filter(r=>!r.waiting),personalCount:personal.length,
      sharedCatalog:c.exercises.filter(e=>!personal.some(r=>r.exercise_id===e.id)).map(e=>({...e,exercise_id:e.id}))};
  }
  async function claimJob() {
    return withTransaction(pool,async db=>{
      // Lease luôn ngắn hơn thời gian chờ hữu hạn; quá năm lượt sẽ hiển thị cần kiểm lại.
      await db.query(`UPDATE speaking_independent.job SET status='review',last_error=coalesce(last_error,'RETRY_EXHAUSTED')
        WHERE attempts>=5 AND (status='failed' OR (status='processing' AND lease_until<now()))`);
      const {rows:[j]}=await db.query(`SELECT * FROM speaking_independent.job WHERE attempts<5 AND available_at<=now()
        AND (status IN ('pending','failed') OR (status='processing' AND lease_until<now()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!j) return null;
      const owner=randomUUID();
      await db.query(`UPDATE speaking_independent.job SET status='processing',owner=$2,lease_until=now()+interval '2 minutes',
        attempts=attempts+1,updated_at=now() WHERE id=$1`,[j.id,owner]);
      const {rows:[u]}=await db.query(`SELECT u.*,p.class_id,p.class_code,p.student_ref,p.kind AS profile_kind,p.course_id FROM speaking_independent.work_unit u
        JOIN speaking_independent.profile p ON p.id=u.profile_id WHERE u.id=$1`,[j.work_unit_id]);
      const l=j.link_id?(await db.query('SELECT * FROM speaking_independent.link WHERE id=$1',[j.link_id])).rows[0]:null;
      const r=(await db.query('SELECT id FROM speaking_independent.receipt WHERE work_unit_id=$1',[u.id])).rows[0];
      return {...j,...l,kind:j.kind,link_kind:l?.kind,id:j.id,job_id:j.id,link_id:j.link_id,owner,u,receipt_id:r?.id,
        min_questions:u.template.parts.find(p=>p.part_key===l?.part)?.min_questions,
        class_id:u.class_id,student_ref:u.student_ref,
        links:Object.fromEntries((await links(u.id,db)).filter(l=>l.kind==='main').map(l=>[l.part,{url:l.share_url,fingerprint:l.fingerprint}]))};
    });
  }
  async function mutateJob(job,fn) {
    return withTransaction(pool,async db=>{
      const {rows:[j]}=await db.query(`SELECT * FROM speaking_independent.job WHERE id=$1 AND owner=$2
        AND status='processing' AND lease_until>now() FOR UPDATE`,[job.job_id,job.owner]);
      if (!j) fail('STALE_JOB','Lượt xử lý đã hết hạn; kết quả cũ không được ghi.');
      return fn(db,j);
    });
  }
  async function failJob(job,code) {
    return mutateJob(job,async db=>{
      await db.query(`UPDATE speaking_independent.job SET status=CASE WHEN attempts>=5 THEN 'review' ELSE 'failed' END,
        last_error=$2,available_at=now()+interval '30 seconds',lease_until=NULL,updated_at=now() WHERE id=$1`,[job.job_id,code]);
    });
  }
  async function checkComplete(job,result) {
    return mutateJob(job,async(db,j)=>{
      await db.query('SELECT id FROM speaking_independent.work_unit WHERE id=$1 FOR UPDATE',[j.work_unit_id]);
      const current=(await links(j.work_unit_id,db)).find(l=>l.part===job.part&&l.kind===job.link_kind);
      if (current?.id!==j.link_id) {
        await db.query("UPDATE speaking_independent.job SET status='done',result='{\"superseded\":true}' WHERE id=$1",[j.id]);
        return {status:'superseded'};
      }
      const valid=result.qualityPassed===true && Number.isInteger(result.questionCount)
        && result.questionCount>=Number(job.min_questions||1) && /^[0-9a-f]{64}$/.test(result.fingerprint||'')
        && (j.kind!=='check_practice'||result.matchedExerciseId===job.exercise_id);
      let code=valid?null:(result.checkCode||'PRACTICE_INCOMPLETE');
      const all=await links(j.work_unit_id,db);
      if (valid && all.some(l=>l.id!==j.link_id&&l.fingerprint===result.fingerprint)) code='REUSED_CONVERSATION';
      let status=valid&&!code?'accepted':'rejected';
      await db.query(`UPDATE speaking_independent.link SET status=$2,check_code=$3,fingerprint=$4,
        question_count=$5,evidence=$6,checked_at=now() WHERE id=$1`,
      [j.link_id,status,code,result.fingerprint||null,result.questionCount||0,JSON.stringify(result.evidence||{})]);
      if (status==='accepted'&&j.kind==='check_practice') {
        await db.query('SAVEPOINT reserve_practice');
        try { await db.query('SELECT speaking_independent.reserve_claim($1)',[j.link_id]); }
        catch(e) {
          await db.query('ROLLBACK TO SAVEPOINT reserve_practice');
          if(e.code!=='23505') throw e;
          status='rejected';
          await db.query("UPDATE speaking_independent.link SET status='rejected',check_code='REUSED_CONVERSATION' WHERE id=$1",[j.link_id]);
        }
        await db.query('RELEASE SAVEPOINT reserve_practice');
        if(status==='accepted') await queue(db,j.work_unit_id,'analyze_practice',`analyze:${j.link_id}`,j.link_id);
      }
      await db.query("UPDATE speaking_independent.job SET status='done',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id,JSON.stringify({status})]);
      return {status};
    });
  }
  async function recordEvent(db,u,{sourceKey,exerciseId,kind,occurredAt}) {
    const canonical=(await db.query('SELECT coalesce(linked_profile_id,id) AS id FROM speaking_independent.profile WHERE id=$1 FOR UPDATE',[u.profile_id])).rows[0].id;
    u={...u,profile_id:canonical};
    await db.query(`INSERT INTO speaking_independent.doctor_recommendation(profile_id,exercise_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[u.profile_id,exerciseId]);
    const {rows:[r]}=await db.query('SELECT * FROM speaking_independent.doctor_recommendation WHERE profile_id=$1 AND exercise_id=$2 FOR UPDATE',[u.profile_id,exerciseId]);
    const {rows}=await db.query(`INSERT INTO speaking_independent.doctor_event(source_key,profile_id,exercise_id,kind,occurred_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING source_key`,[sourceKey,u.profile_id,exerciseId,kind,occurredAt]);
    if (!rows.length) return;
    if(kind==='practice') await db.query(`UPDATE speaking_independent.doctor_recommendation SET practice_count=practice_count+1,
      waiting=false,last_practiced_at=$3 WHERE profile_id=$1 AND exercise_id=$2`,[u.profile_id,exerciseId,occurredAt]);
    else {
      const previous=Math.max(0,...[r.proposed_at,r.last_practiced_at].filter(Boolean).map(v=>new Date(v).getTime()));
      const reopen=previous===0||Date.parse(occurredAt)-previous>5*86400000;
      await db.query(`UPDATE speaking_independent.doctor_recommendation SET recommendation_count=recommendation_count+1,
        waiting=CASE WHEN $3 THEN true ELSE waiting END,proposed_at=CASE WHEN $3 THEN $4 ELSE proposed_at END
        WHERE profile_id=$1 AND exercise_id=$2`,[u.profile_id,exerciseId,reopen,occurredAt]);
    }
  }
  function workerService(job) {
    const complete=r=>checkComplete(job,r);
    const failWorker=r=>failJob(job,r.errorCode);
    const completeAnalysis=async r=>{
      const c=await catalog(job.u);
      if(c.digest!==r.catalogDigest||!Array.isArray(r.matches)||r.matches.length>80) fail('DOCTOR_RESULT_INVALID','Danh mục hoặc kết quả phân tích không hợp lệ.');
      const allowed=new Set(c.exercises.map(e=>e.id));
      if(r.matches.some(m=>!allowed.has(m.exerciseId)||!Number.isInteger(m.evidenceMessage)||m.evidenceMessage<1||typeof m.evidenceQuote!=='string'||m.evidenceQuote.length<5||m.evidenceQuote.length>160||typeof m.reason!=='string'||!m.reason.trim()||m.reason.length>500
        || (job.kind==='analyze_homework'&&!Object.keys(job.links).filter(p=>p!=='benefit_harm').includes(m.part))))
        fail('DOCTOR_RESULT_INVALID','Bằng chứng ghép bài luyện không hợp lệ.');
      return mutateJob(job,async(db,j)=>{
        for(const exerciseId of new Set(r.matches.map(m=>m.exerciseId))) await recordEvent(db,job.u,{sourceKey:`doctor:${j.id}:${exerciseId}`,exerciseId,kind:'recommendation',occurredAt:new Date(j.created_at).toISOString()});
        await db.query("UPDATE speaking_independent.job SET status='done',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id,JSON.stringify(r)]);
        return {status:'done'};
      });
    };
    return {completeCheck:complete,completePracticeCheck:complete,
      rejectCheckJob:r=>complete({...r,qualityPassed:false}),rejectPracticeCheckJob:r=>complete({...r,qualityPassed:false}),
      failCheckJob:failWorker,failPracticeCheckJob:failWorker,failPracticeAnalysisJob:failWorker,failOutboxJob:failWorker,
      getDoctorCatalog:()=>catalog(job.u),getPracticeDoctorCatalog:()=>catalog(job.u),
      recordDoctorEvent:r=>mutateJob(job,db=>recordEvent(db,job.u,r)),
      completeDoctorJob:completeAnalysis,completePracticeAnalysisJob:completeAnalysis};
  }
  async function teacherReceipt(receiptId,headers) {
    const {rows:[u]}=await pool.query(`SELECT u.*,p.class_id,p.class_code,p.student_name,p.course_id,r.id AS receipt_id,r.created_at AS receipt_created
      FROM speaking_independent.receipt r JOIN speaking_independent.work_unit u ON u.id=r.work_unit_id
      JOIN speaking_independent.profile p ON p.id=u.profile_id WHERE r.id=$1`,[receiptId]);
    if(!u||!await source.teacher(u.class_id,headers)) fail('RECEIPT_NOT_FOUND','Không thấy bài hoặc bạn chưa có quyền xem.',404);
    const all=await links(u.id);
    const {rows:jobs}=await pool.query('SELECT kind,status,result FROM speaking_independent.job WHERE work_unit_id=$1',[u.id]);
    return {receipt_id:u.receipt_id,created_at:u.receipt_created,submitted_at:u.submitted_at,title:u.template.title,
      class_id:u.class_id,class_code:u.class_code,student_name:u.student_name,document_id:u.document_id,course_id:u.course_id,
      links:Object.fromEntries(all.filter(l=>l.kind==='main').map(l=>[l.part,{url:l.share_url,questionCount:l.question_count,evidence:l.evidence,checkedAt:l.checked_at}])),
      practice_links:all.filter(l=>l.kind==='practice').map(l=>({slot:l.slot,exerciseTitle:l.exercise_title,url:l.share_url,status:l.status})),
      processing:Object.fromEntries(jobs.map(j=>[j.kind,{status:j.status}])),
      grade_summary:{status:'done',partCounts:Object.fromEntries(all.filter(l=>l.kind==='main').map(l=>[l.part,l.question_count])),totalQuestions:all.filter(l=>l.kind==='main').reduce((n,l)=>n+l.question_count,0),typingWarningParts:[],voiceConfirmedParts:[]}};
  }
  return {classes,roster,resolveIdentity,startSelected,open,finish,listDoctor,teacherReceipt,claimJob,workerService,failJob,
    requestCheck:i=>request(i,{...i,kind:'main'}),requestPracticeCheck:i=>request(i,{...i,kind:'practice'}),
    pool,context,grant,links,queue,mutateJob};
}
