import { createHash,createHmac,randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { SpeakingHomeworkError } from './speaking-homework.js';
import { planSpeakingCopyCta,verifySpeakingCopyCta } from './speaking-classroom-copies.js';
import { planSpeakingStatusWrite,verifySpeakingStatusWrite } from './speaking-independent-status.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const error=(code,message)=>{throw new SpeakingHomeworkError(code,message);};
const teacherPage='https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/teacher.html';
function allText(value) {
  if(value?.textRun) return value.textRun.content||'';
  return value&&typeof value==='object'?Object.values(value).map(allText).join(''):'';
}
export function validateIndependentDocument(document,{documentId,assignmentCode}) {
  if(document.documentId!==documentId||!document.revisionId) error('DOCUMENT_IDENTITY_MISMATCH','Nội dung Docs chưa khớp file đang mở.');
  const found=[];
  for(const tab of document.tabs||[]) {
    const text=allText(tab.documentTab?.body).normalize('NFKC');
    const codes=text.match(/67-speaking-[a-z0-9_]+/g)||[];
    if(codes.length===1 && codes[0]===assignmentCode && /SPEAKING\s*[-–]/i.test(text)
      && text.includes('NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING') && text.includes('TÌNH TRẠNG NỘP BÀI SPEAKING')) found.push(tab.tabProperties?.tabId);
  }
  if(found.length!==1||!found[0]) error('DOCUMENT_CONTENT_INVALID','Docs cần đúng mã và cấu trúc Homework Speaking; hãy kiểm lại bản sao.');
  return {tabId:found[0],revision:document.revisionId};
}

// Đọc Docs thực qua cầu nối có quyền. File chưa nằm trong Classroom vẫn có hồ sơ riêng.
// Chỉ nguồn Classroom đã đối soát mới gắn lớp/học viên; không suy chủ file từ tên người chọn.
export function createIndependentDocuments({pool,source,accessSecret,gateway}) {
  const mint=u=>createHmac('sha256',accessSecret).update(`${u.id}:${u.identity_ref}`).digest('base64url');
  async function ensure({documentId,assignmentCode}) {
    const {template}=await source.context({assignmentCode});
    const document=await gateway.get(documentId);
    const verified=validateIndependentDocument(document,{documentId,assignmentCode});
    const prepared=await withTransaction(pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`document:${documentId}:${verified.tabId}`]);
      let u=(await db.query(`SELECT u.*,p.identity_ref,p.student_name,p.class_code,p.student_ref
        FROM speaking_independent.document_binding b JOIN speaking_independent.work_unit u ON u.id=b.work_unit_id
        JOIN speaking_independent.profile p ON p.id=u.profile_id
        WHERE b.document_id=$1 AND b.tab_id=$2 AND b.assignment_code=$3`,[documentId,verified.tabId,assignmentCode])).rows[0];
      if(!u) {
        const {rows:[p]}=await db.query(`INSERT INTO speaking_independent.profile(identity_ref,profile_key,kind,student_name)
          VALUES($1,$2,'document',$3) ON CONFLICT(profile_key) DO UPDATE SET profile_key=EXCLUDED.profile_key RETURNING *`,
        [randomUUID(),`document:${documentId}:${verified.tabId}`,String(document.title||'Bài Speaking riêng').slice(0,300)]);
        const id=randomUUID(),accessToken=mint({id,identity_ref:p.identity_ref});
        const {rows:[unit]}=await db.query(`INSERT INTO speaking_independent.work_unit
          (id,profile_id,assignment_code,context_key,template,template_digest,document_id,tab_id,document_revision,origin,token_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'document',$10) RETURNING *`,
        [id,p.id,assignmentCode,`document:${documentId}:${verified.tabId}`,JSON.stringify(template),template.digest,documentId,verified.tabId,verified.revision,hash(accessToken)]);
        u={...unit,identity_ref:p.identity_ref,student_name:p.student_name,class_code:null};
        await db.query(`INSERT INTO speaking_independent.document_binding(document_id,tab_id,assignment_code,work_unit_id,verified_revision,template_digest)
          VALUES($1,$2,$3,$4,$5,$6)`,[documentId,verified.tabId,assignmentCode,u.id,verified.revision,template.digest]);
      }
      return {u,template};
    });
    const known=(await pool.query(`SELECT 1 FROM speaking_independent.source_binding WHERE document_id=$1
      AND assignment_code=$2 AND cta_verified_at IS NOT NULL AND status='pending'`,[documentId,assignmentCode])).rows;
    if(known.length===1) {
      await verify({documentId,document});
      prepared.u=(await pool.query(`SELECT u.*,p.identity_ref,p.student_name,p.class_code,p.student_ref
        FROM speaking_independent.work_unit u JOIN speaking_independent.profile p ON p.id=u.profile_id WHERE u.id=$1`,[prepared.u.id])).rows[0];
    }
    return prepared;
  }
  async function open(input) {
    const {u,template}=await ensure(input);
    return {...template,classCode:u.class_code||'DOCS',intakeMode:u.class_code?'linked':'document',assignmentStatus:'open',
      students:[{student_ref:u.student_ref||u.identity_ref,name:u.student_name}]};
  }
  async function start(input) {
    const {u}=await ensure(input);
    if(![u.identity_ref,u.student_ref].includes(input.studentRef)) error('DOCUMENT_PROFILE_MISMATCH','Phiên chưa khớp hồ sơ của bản Docs.');
    return {accessToken:mint(u),studentRef:input.studentRef,classCode:u.class_code||'DOCS',documentId:u.document_id,workUnitId:u.id};
  }
  async function register(input) {
    const base=await source.context({assignmentCode:input.assignmentCode});
    const scope=base.classes.find(c=>c.course_id===input.courseId);
    if(!scope) error('CLASS_SCOPE_INVALID','Bài Classroom chưa thuộc lớp được đối soát.');
    const previous=(await pool.query('SELECT assignment_code FROM speaking_independent.source_assignment WHERE course_id=$1 AND course_work_id=$2',[input.courseId,input.courseWorkId])).rows[0];
    const saved=await pool.query(`INSERT INTO speaking_independent.source_assignment(course_id,course_work_id,assignment_code,class_id,class_code,title,state)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(course_id,course_work_id) DO UPDATE SET state=EXCLUDED.state,observed_at=now()
      WHERE speaking_independent.source_assignment.assignment_code=EXCLUDED.assignment_code RETURNING course_id`,
    [input.courseId,input.courseWorkId,input.assignmentCode,scope.class_id,scope.class_code,input.title||base.template.title,input.classroomState]);
    if(saved.rows.length!==1) error('SOURCE_CONFLICT','Bài Classroom đã mang mã khác; không đổi nguồn đã lưu.');
    return {registered:input.classroomState==='PUBLISHED'||(input.classroomState==='DELETED'&&Boolean(previous)),status:input.classroomState==='PUBLISHED'?'open':input.classroomState==='DELETED'?'closed':input.classroomState.toLowerCase(),
      assignmentId:`source:${input.courseId}:${input.courseWorkId}`,classCode:scope.class_code};
  }
  async function sourceAssignment(input,db=pool) {
    const {rows:[a]}=await db.query(`SELECT * FROM speaking_independent.source_assignment WHERE course_id=$1 AND course_work_id=$2 AND state='PUBLISHED'`,[input.courseId,input.courseWorkId]);
    if(!a) error('SOURCE_NOT_FOUND','Chưa đọc được đúng bài Classroom đã phát hành.');
    return a;
  }
  async function sync(input) {
    const a=await sourceAssignment(input);
    const c=await source.context({assignmentCode:a.assignment_code,classCode:a.class_code});
    const pending=[];
    let skippedExcluded=0;
    if(new Set(input.submissions.map(s=>s.id)).size!==input.submissions.length
      ||new Set(input.submissions.filter(s=>s.documentId).map(s=>s.documentId)).size!==input.submissions.filter(s=>s.documentId).length)
      error('SOURCE_SNAPSHOT_DUPLICATE','Danh sách Classroom trùng bài nộp hoặc Doc ID.');
    for(const s of input.submissions) {
      if(!s.documentId) continue;
      const matches=c.students.filter(m=>m.google_user_id===s.userId);
      if(!matches.length&&c.excludedStudents?.some(m=>m.google_user_id===s.userId)){skippedExcluded++;continue;}
      if(matches.length!==1) error('STUDENT_MAPPING_INVALID','Học viên Classroom chưa ghép duy nhất với lớp đang học.');
      const member=matches[0];
      const result=await pool.query(`INSERT INTO speaking_independent.source_binding
        (course_id,course_work_id,submission_id,google_user_id,document_id,student_ref,assignment_code)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(course_id,course_work_id,submission_id,document_id) DO UPDATE SET google_user_id=EXCLUDED.google_user_id
        WHERE speaking_independent.source_binding.google_user_id=EXCLUDED.google_user_id
          AND speaking_independent.source_binding.student_ref=EXCLUDED.student_ref RETURNING cta_verified_at`,
      [input.courseId,input.courseWorkId,s.id,s.userId,s.documentId,member.student_ref,a.assignment_code]);
      if(!result.rows.length) error('SOURCE_CONFLICT','Nguồn Classroom có chủ bài mâu thuẫn; cần kiểm lại.');
      if(!result.rows[0].cta_verified_at) pending.push({documentId:s.documentId,classroomSubmissionId:s.id,classCode:a.class_code,assignmentCode:a.assignment_code});
    }
    return {pending,bound:input.submissions.filter(s=>s.documentId).length-skippedExcluded,skippedExcluded};
  }
  async function binding(documentId,db=pool) {
    const {rows}=await db.query(`SELECT b.*,a.class_id,a.class_code FROM speaking_independent.source_binding b
      JOIN speaking_independent.source_assignment a USING(course_id,course_work_id)
      WHERE b.document_id=$1 AND a.state='PUBLISHED'`,[documentId]);
    if(rows.length!==1) error('SOURCE_CONFLICT','File chưa có duy nhất nguồn Classroom.');
    return rows[0];
  }
  async function plan(input) {
    const b=await binding(input.documentId);
    validateIndependentDocument(input.document,{documentId:input.documentId,assignmentCode:b.assignment_code});
    return {...planSpeakingCopyCta({...input,classCode:b.class_code,assignmentCode:b.assignment_code}),documentId:input.documentId};
  }
  async function verify(input) {
    const b=await binding(input.documentId);
    const v=validateIndependentDocument(input.document,{documentId:input.documentId,assignmentCode:b.assignment_code});
    if(!verifySpeakingCopyCta({...input,classCode:b.class_code,assignmentCode:b.assignment_code})) error('DOC_CTA_NOT_VERIFIED','CTA chưa trỏ đúng bản Docs.');
    const c=await source.context({assignmentCode:b.assignment_code,classCode:b.class_code,studentRef:b.student_ref});
    return withTransaction(pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`member:${b.class_id}:${b.student_ref}`]);
      const units=(await db.query(`SELECT u.*,p.identity_ref,p.kind AS profile_kind,p.course_id AS profile_course
        FROM speaking_independent.work_unit u JOIN speaking_independent.profile p ON p.id=u.profile_id
        WHERE u.assignment_code=$1 AND ((p.class_id=$2 AND p.student_ref=$3) OR u.document_id=$4) FOR UPDATE OF u,p`,
      [b.assignment_code,b.class_id,b.student_ref,input.documentId])).rows;
      const unique=[...new Map(units.map(u=>[u.id,u])).values()];
      if(unique.length>1||unique.some(u=>u.document_id&&u.document_id!==input.documentId)) {
        await db.query("UPDATE speaking_independent.source_binding SET status='review' WHERE document_id=$1",[input.documentId]);
        return {documentId:input.documentId,verified:true,status:'review',reason:'EXISTING_PROGRESS_CONFLICT'};
      }
      let u=unique[0];
      // Chưa làm bài: chỉ lưu nguồn. Khi mở lần đầu, bản Docs tự tạo hồ sơ rồi gắn lại.
      if(u) {
        await db.query('SAVEPOINT bind_source');
        try {
          if(u.profile_course && u.profile_course!==b.course_id) error('SOURCE_CONFLICT','Khóa học của bài cũ không khớp nguồn.');
          await db.query(`UPDATE speaking_independent.profile SET class_id=$2,class_code=$3,student_ref=$4,student_name=$5,course_id=$6 WHERE id=$1`,
          [u.profile_id,b.class_id,b.class_code,b.student_ref,c.member.name,b.course_id]);
          if(u.profile_kind==='document') {
            const memberKey=`member:${b.class_id}:${b.student_ref}`;
            const knownMember=(await db.query('SELECT id FROM speaking_independent.profile WHERE profile_key=$1',[memberKey])).rows[0];
            const {rows:[member]}=await db.query(`INSERT INTO speaking_independent.profile(identity_ref,profile_key,kind,class_id,class_code,student_ref,student_name,course_id)
              VALUES($1,$2,'member',$3,$4,$1,$5,$6) ON CONFLICT(profile_key) DO UPDATE SET profile_key=EXCLUDED.profile_key RETURNING id`,
            [b.student_ref,memberKey,b.class_id,b.class_code,c.member.name,b.course_id]);
            // Hồ sơ Docs được gắn lớp lần đầu cũng kế thừa Doctor cũ như hồ sơ mở web.
            // Chỉ lấy snapshot lúc tạo thành viên, không cộng lại khi sự kiện được gửi lặp.
            if(!knownMember) for(const r of c.recommendations) await db.query(`INSERT INTO speaking_independent.doctor_recommendation
              (profile_id,exercise_id,recommendation_count,practice_count,waiting,proposed_at,last_practiced_at)
              VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[member.id,r.exercise_id,r.recommendation_count,r.practice_count,r.waiting,r.proposed_at,r.last_practiced_at]);
            const original=(await db.query('SELECT linked_profile_id FROM speaking_independent.profile WHERE id=$1',[u.profile_id])).rows[0];
            if(!original.linked_profile_id) {
              await db.query(`INSERT INTO speaking_independent.doctor_recommendation(profile_id,exercise_id,recommendation_count,practice_count,waiting,proposed_at,last_practiced_at)
                SELECT $2,exercise_id,recommendation_count,practice_count,waiting,proposed_at,last_practiced_at FROM speaking_independent.doctor_recommendation WHERE profile_id=$1
                ON CONFLICT(profile_id,exercise_id) DO UPDATE SET recommendation_count=speaking_independent.doctor_recommendation.recommendation_count+EXCLUDED.recommendation_count,
                  practice_count=speaking_independent.doctor_recommendation.practice_count+EXCLUDED.practice_count,
                  waiting=speaking_independent.doctor_recommendation.waiting OR EXCLUDED.waiting,
                  proposed_at=greatest(speaking_independent.doctor_recommendation.proposed_at,EXCLUDED.proposed_at),
                  last_practiced_at=greatest(speaking_independent.doctor_recommendation.last_practiced_at,EXCLUDED.last_practiced_at)`,[u.profile_id,member.id]);
              await db.query('UPDATE speaking_independent.doctor_event SET profile_id=$2 WHERE profile_id=$1',[u.profile_id,member.id]);
              await db.query('UPDATE speaking_independent.profile SET linked_profile_id=$2 WHERE id=$1',[u.profile_id,member.id]);
            }else if(original.linked_profile_id!==member.id) error('SOURCE_CONFLICT','Hồ sơ đã gắn với học viên khác.');
          }
          await db.query(`UPDATE speaking_independent.work_unit SET document_id=$2,tab_id=$3,document_revision=$4 WHERE id=$1`,[u.id,input.documentId,v.tabId,v.revision]);
          const claims=await db.query('SELECT link_id FROM speaking_independent.claim WHERE work_unit_id=$1',[u.id]);
          for(const l of claims.rows) await db.query('SELECT speaking_independent.reserve_claim($1)',[l.link_id]);
          await db.query(`INSERT INTO speaking_independent.document_binding(document_id,tab_id,assignment_code,work_unit_id,verified_revision,template_digest)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(document_id,tab_id,assignment_code) DO UPDATE SET verified_revision=EXCLUDED.verified_revision
            WHERE speaking_independent.document_binding.work_unit_id=EXCLUDED.work_unit_id`,[input.documentId,v.tabId,b.assignment_code,u.id,v.revision,u.template_digest]);
          if(u.status==='submitted') {
            const r=(await db.query('SELECT id FROM speaking_independent.receipt WHERE work_unit_id=$1',[u.id])).rows[0];
            await db.query(`INSERT INTO speaking_independent.job(work_unit_id,kind,dedupe_key) VALUES($1,'write_doc',$2) ON CONFLICT DO NOTHING`,[u.id,`doc:${r.id}:${input.documentId}`]);
          }
        } catch(e) {
          await db.query('ROLLBACK TO SAVEPOINT bind_source');
          if(e.code!=='23505') throw e;
          await db.query("UPDATE speaking_independent.source_binding SET status='review' WHERE document_id=$1",[input.documentId]);
          return {documentId:input.documentId,verified:true,status:'review',reason:'CONVERSATION_ALREADY_CLAIMED'};
        }
        await db.query('RELEASE SAVEPOINT bind_source');
      }
      await db.query(`UPDATE speaking_independent.source_binding SET cta_verified_at=now(),work_unit_id=$2,status=$3 WHERE document_id=$1`,[input.documentId,u?.id||null,u?'linked':'pending']);
      return {documentId:input.documentId,verified:true,status:u?'linked':'pending'};
    });
  }
  async function scopes() {
    return (await pool.query(`SELECT course_id,course_work_id,assignment_code,class_code,observed_at AS opened_at,'docs_cta' AS delivery_mode
      FROM speaking_independent.source_assignment WHERE state='PUBLISHED' ORDER BY class_code,assignment_code`)).rows;
  }
  async function scan(input) {
    const a=await sourceAssignment(input);
    const c=await source.context({assignmentCode:a.assignment_code,classCode:a.class_code});
    return withTransaction(pool,async db=>{
      const turned=[];
      for(const s of input.submissions) {
        if(s.state!=='TURNED_IN') continue;
        if(input.notBefore) {
          const epoch=Date.parse(s.updateTime||'');
          if(!Number.isFinite(epoch)||epoch>Date.now()+60000) error('ALERT_TIMESTAMP_REQUIRED','Chưa có thời gian nộp Classroom hợp lệ.');
          if(epoch<Date.parse(input.notBefore))continue;
        }
        const matches=c.students.filter(m=>m.google_user_id===s.userId);
        if(!matches.length&&c.excludedStudents?.some(m=>m.google_user_id===s.userId))continue;
        if(matches.length!==1) error('ALERT_STUDENT_UNMAPPED','Bài Classroom chưa khớp học viên đang học.');
        const m=matches[0];turned.push(s.id);
        const receipt=await db.query(`SELECT 1 FROM speaking_independent.receipt r
          JOIN speaking_independent.work_unit u ON u.id=r.work_unit_id JOIN speaking_independent.profile p ON p.id=u.profile_id
          WHERE u.assignment_code=$1 AND p.class_id=$2 AND p.student_ref=$3`,[a.assignment_code,a.class_id,m.student_ref]);
        if(receipt.rows.length) {
          await db.query("UPDATE speaking_independent.classroom_alert SET status='resolved' WHERE course_id=$1 AND course_work_id=$2 AND submission_id=$3 AND status='pending'",[input.courseId,input.courseWorkId,s.id]);
          continue;
        }
        const link=new URL(s.alternateLink);
        if(link.protocol!=='https:'||link.hostname!=='classroom.google.com') error('INVALID_CLASSROOM_LINK','Classroom chưa trả link mở bài hợp lệ.');
        await db.query(`INSERT INTO speaking_independent.classroom_alert(course_id,course_work_id,submission_id,student_ref,student_name,classroom_url)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(course_id,course_work_id,submission_id) DO UPDATE SET
          classroom_url=EXCLUDED.classroom_url,status=CASE WHEN speaking_independent.classroom_alert.status='resolved' THEN 'pending' ELSE speaking_independent.classroom_alert.status END`,
        [input.courseId,input.courseWorkId,s.id,m.student_ref,m.name,link.href]);
      }
      await db.query(`UPDATE speaking_independent.classroom_alert SET status='resolved'
        WHERE course_id=$1 AND course_work_id=$2 AND status='pending' AND NOT(submission_id=ANY($3::text[]))`,[input.courseId,input.courseWorkId,turned]);
      const {rows:[n]}=await db.query("SELECT count(*)::int n FROM speaking_independent.classroom_alert WHERE course_id=$1 AND course_work_id=$2 AND status='pending'",[input.courseId,input.courseWorkId]);
      return {enabled:true,pending:n.n};
    });
  }
  async function claimAlert(input) {
    await sourceAssignment(input);
    return withTransaction(pool,async db=>{
      const {rows}=await db.query(`SELECT * FROM speaking_independent.classroom_alert WHERE course_id=$1 AND course_work_id=$2
        AND status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100`,[input.courseId,input.courseWorkId]);
      if(!rows.length)return null;
      const batchId=randomUUID();
      await db.query("UPDATE speaking_independent.classroom_alert SET status='sending',batch_id=$2 WHERE id=ANY($1::uuid[])",[rows.map(r=>r.id),batchId]);
      return {batchId,items:rows.map(r=>({studentName:r.student_name,classroomUrl:r.classroom_url}))};
    });
  }
  async function ackAlert({batchId}) {
    const {rows}=await pool.query("UPDATE speaking_independent.classroom_alert SET status='sent',sent_at=now() WHERE batch_id=$1 AND status='sending' RETURNING id",[batchId]);
    if(!rows.length) error('ALERT_BATCH_NOT_FOUND','Không thấy lô báo giảng viên đang chờ xác nhận.');
    return {sent:rows.length};
  }
  return {open,start,register,sync,plan,verify,scopes,scan,claimAlert,ackAlert};
}

// Ghi ô trạng thái có khóa revision; sau timeout đọc lại trước khi thử ghi lại.
// Không báo done nếu Docs chưa chứa đúng biên nhận độc lập.
export async function writeIndependentDocument(service,job,gateway) {
  try {
    const document=await gateway.get(job.u.document_id);
    const linkUrl=`${teacherPage}?receipt=${job.receipt_id}&system=independent`;
    if(!verifySpeakingStatusWrite({document,documentId:job.u.document_id,tabId:job.u.tab_id,linkUrl})) {
      const plan=planSpeakingStatusWrite({document,documentId:job.u.document_id,tabId:job.u.tab_id,receiptId:job.receipt_id,teacherBaseUrl:teacherPage});
      for(const r of plan.requests) if(r.updateTextStyle?.textStyle?.link) r.updateTextStyle.textStyle.link.url=linkUrl;
      await gateway.write(job.u.document_id,{requests:plan.requests,writeControl:{requiredRevisionId:plan.revisionId}});
    }
    const readback=await gateway.get(job.u.document_id);
    if(!verifySpeakingStatusWrite({document:readback,documentId:job.u.document_id,tabId:job.u.tab_id,linkUrl})) throw new Error('DOC_READBACK_MISMATCH');
    await service.mutateJob(job,db=>db.query("UPDATE speaking_independent.job SET status='done',result=$2,lease_until=NULL WHERE id=$1",[job.job_id,JSON.stringify({documentId:job.u.document_id,revisionId:readback.revisionId})]));
  }catch(e){await service.failJob(job,String(e.code||e.message||'DOC_WRITE_FAILED').slice(0,100));}
}

export function createDocsGateway({url,secret,call=fetch}) {
  async function invoke(operation,documentId,body) {
    const response=await call(url,{method:'POST',headers:{'content-type':'application/json','x-speaking-worker-secret':secret},
      body:JSON.stringify({operation,documentId,...(body?{body}:{})}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok||data.ok!==true) throw new Error(data.error||'DOC_GATEWAY_UNAVAILABLE');
    return data.result;
  }
  return {get:id=>invoke('get',id),write:(id,body)=>invoke('write',id,body)};
}
