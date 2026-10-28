// Nhận nháp đã duyệt hoặc bản xuất bản; không tạo bài nộp/điểm danh khi xuất bản hay giao.
// Mỗi đích giao có transaction và mã retry riêng; lỗi một đích không nhân các đích đã thành công.
import {withTransaction} from './db.js';
import crypto from 'node:crypto';
import {validateAuthoringPayload,FormAuthoringError} from './learning-form-authoring.js';
import {sha256,stableStringify,gradeLearningSubmission} from './learning-domain.js';
import {parseFormDefinition,parseFormGradingKey} from './learning-contracts.js';
import {decorateSchedule} from './learning-schedule-plan.js';
import {fetchCourseCurrentRosterSql} from './learning-course-overview.js';
import {buildLearningClassAccessPredicate,authorizeLearningJourneyPlanAssignmentSql,insertLearningAssignmentSql,insertLearningAssignmentRosterSql,
  insertLearningAssignmentBlockReleaseSql,fetchLearningRosterForClassSql} from './learning-sql.js';

const fail=(code,message,status=409)=>new FormAuthoringError(code,message,[],status);
const publicationDto=row=>({id:row.id,draftId:row.source_draft_id||row.bound_draft_id||null,
  assignmentId:row.source_assignment_id||null,libraryEntryId:row.source_library_id||null,revision:Number(row.source_revision),
  contentHash:row.content_hash,formVersionId:row.form_version_id});
const hasScore=definition=>definition.blocks.some(block=>block.items.some(item=>item.maxScore>0));
function validatePublishedSource({definition,gradingKey}){
  // Nguồn đã phát được kiểm bằng hợp đồng reader/chấm hiện hành, không áp danh mục tạo câu mới.
  // Giữ nguyên payload/hash lịch sử; không thêm default hoặc chuyển dạng khi giao lại.
  parseFormDefinition(definition);parseFormGradingKey(gradingKey);
  if(definition.formVersionId!==gradingKey.formVersionId)throw fail('PUBLICATION_CONTENT_MISMATCH','Đáp án không thuộc phiên bản nguồn.',500);
  gradeLearningSubmission({definition,gradingKey,responses:{}});
  return {definition:structuredClone(definition),gradingKey:structuredClone(gradingKey),contentHash:sha256(stableStringify({definition,gradingKey}))};
}
function accessSql(email,all){
  return `((publication.source_draft_id IS NOT NULL AND lower(publication.owner_email)=lower(${email}))
    OR EXISTS(SELECT 1 FROM learning.form_library_entry entry WHERE
      ((entry.id=publication.source_library_id AND entry.content_hash=publication.source_content_hash)
        OR (entry.source_draft_id=publication.source_draft_id AND entry.source_revision=publication.source_revision AND entry.content_hash=publication.content_hash)
        OR (entry.public_definition->>'formVersionId'=publication.form_version_id::text AND entry.content_hash=publication.content_hash))
      AND (entry.sharing_scope='izone' OR lower(entry.owner_email)=lower(${email})))
    OR EXISTS(SELECT 1 FROM learning.form_assignment source_assignment WHERE source_assignment.form_version_id=publication.form_version_id
      AND (${all}::boolean OR ${buildLearningClassAccessPredicate({reviewerEmailSql:email,classIdSql:'source_assignment.erp_course_class_id'})})))`;
}
function targetOperation(operationId,classId,sessionNumber){
  const h=sha256(operationId+':'+classId+':'+sessionNumber);
  return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}

export function createLearningFormPublications({pool,authorizeClass,owned,authority,assertCourse,erpScheduleReader}){
  async function lockSource(database,key){
    await database.query('INSERT INTO learning.form_publication_lock(source_key) VALUES($1) ON CONFLICT DO NOTHING',[key]);
    await database.query('SELECT source_key FROM learning.form_publication_lock WHERE source_key=$1 FOR UPDATE',[key]);
  }
  async function storeVersion(database,definition,key,owner,approver){
    const template=(await database.query(`INSERT INTO learning.form_template(title,kind,created_by_email) VALUES($1,$2,$3) RETURNING id`,[definition.title,definition.kind,owner])).rows[0];
    await database.query(`INSERT INTO learning.form_version(id,template_id,version,public_definition,definition_hash,status,
      created_by_email,approved_by_email,published_at) VALUES($1::uuid,$2::uuid,1,$3::jsonb,$4,'published',$5,$6,now())`,
      [definition.formVersionId,template.id,JSON.stringify(definition),sha256(stableStringify(definition)),owner,approver]);
    await database.query(`INSERT INTO learning.form_grading_key(form_version_id,schema_version,grader_version,private_definition,content_hash)
      VALUES($1::uuid,'FormGradingKeyV1',$2,$3::jsonb,$4)`,[definition.formVersionId,key.graderVersion,JSON.stringify(key),sha256(stableStringify(key))]);
  }
  async function checkSchedule(database,classId,sessionNumber){
    if(!erpScheduleReader)return;
    const plan=(await database.query('SELECT session_dates FROM learning.class_journey_plan WHERE erp_course_class_id=$1::bigint',[classId])).rows[0];
    const dates=typeof plan?.session_dates==='string'?JSON.parse(plan.session_dates):plan?.session_dates||[];
    const confirmed=dates.find(s=>Number(s.sessionNumber)===sessionNumber);
    if(!confirmed?.erpSessionId)throw fail('ERP_SESSION_NOT_CONFIRMED','Xác nhận mốc ERP trong kế hoạch lớp trước khi giao bài.');
    let schedule;
    try{schedule=decorateSchedule(String(classId),await erpScheduleReader(String(classId),{fresh:true}));}
    catch{throw fail('ERP_SCHEDULE_UNAVAILABLE','Chưa đọc được lịch ERP; bản xuất bản vẫn được giữ.',503);}
    const current=schedule.sessions.find(s=>s.erpSessionId===confirmed.erpSessionId);
    const baseline=(await database.query('SELECT erp_snapshot FROM learning.journey_plan_change WHERE class_id=$1::bigint ORDER BY id DESC LIMIT 1',[classId])).rows[0]?.erp_snapshot;
    const prior=baseline?.sessions.find(s=>s.erpSessionId===confirmed.erpSessionId);
    if(schedule.ambiguous||!current||![0,1].includes(current.statusCode)||current.date!==confirmed.date
      ||(prior&&(prior.startsAt!==current.startsAt||prior.endsAt!==current.endsAt)))
      throw fail('ERP_SESSION_REVIEW_REQUIRED','Lịch ERP đã đổi; đối chiếu kế hoạch trước khi giao bài.');
  }
  async function publication(database,id,reviewer){
    const row=(await database.query(`SELECT publication.*,version.public_definition,grading.private_definition,
      COALESCE(draft.approved_by_email,version.approved_by_email) AS approved_by_email,
      COALESCE(draft.owner_email,version.created_by_email) AS draft_owner_email,
      draft.content_hash AS draft_hash,version.public_definition AS published_definition,
      version.definition_hash,grading.private_definition AS published_key,grading.content_hash AS published_key_hash
      FROM learning.form_publication publication LEFT JOIN learning.form_draft draft ON draft.id=publication.source_draft_id
      JOIN learning.form_version version ON version.id=publication.form_version_id
      JOIN learning.form_grading_key grading ON grading.form_version_id=version.id WHERE publication.id=$1::uuid
      AND ${accessSql('$2','$3')}`,[id,reviewer.email,reviewer.canAccessAllClasses===true])).rows[0];
    if(!row)throw fail('PUBLICATION_NOT_FOUND','Không tìm thấy bản xuất bản trong kho bạn được dùng.',404);
    if(sha256(stableStringify(row.published_definition))!==row.definition_hash
      ||row.definition_hash!==sha256(stableStringify(row.public_definition))
      ||sha256(stableStringify(row.published_key))!==row.published_key_hash
      ||row.published_key_hash!==sha256(stableStringify(row.private_definition))
      ||row.content_hash!==sha256(stableStringify({definition:row.public_definition,gradingKey:row.private_definition}))
      ||row.source_draft_id&&row.draft_hash!==row.content_hash)
      throw fail('PUBLICATION_CONTENT_MISMATCH','Nội dung hoặc đáp án của phiên bản xuất bản chưa khớp; đã dừng giao.',500);
    if((row.source_draft_id||hasScore(row.public_definition))&&(!row.approved_by_email
      ||!await authority(database,row.approved_by_email,row.public_definition,row.draft_owner_email)))
      throw fail('DRAFT_APPROVAL_REVOKED','Quyền duyệt đã thay đổi; chưa thể giao bản này.',403);
    return row;
  }
  async function readDelivery(database,delivery){
    const row=(await database.query(`SELECT assignment.id::text AS assignment_id,assignment.form_version_id::text,
      assignment.public_token::text,assignment.erp_course_class_id::text,assignment.session_number,
      (SELECT count(*)::integer FROM learning.form_assignment_roster WHERE assignment_id=assignment.id) AS roster_count,
      (SELECT count(*)::integer FROM learning.assignment_block_release WHERE assignment_id=assignment.id) AS block_count
      FROM learning.form_assignment assignment WHERE assignment.id=$1::uuid`,[delivery.assignment_id])).rows[0];
    if(!row||String(row.erp_course_class_id)!==String(delivery.erp_course_class_id)
      ||Number(row.session_number)!==Number(delivery.session_number)||row.roster_count<1)
      throw fail('DELIVERY_READBACK_MISMATCH','Chưa xác nhận được đúng lớp, buổi và danh sách vừa giao.',500);
    return {assignmentId:row.assignment_id,formVersionId:row.form_version_id,publicToken:row.public_token,
      classId:String(row.erp_course_class_id),sessionNumber:Number(row.session_number),rosterCount:row.roster_count,blockCount:row.block_count};
  }
  return {
    async listPublications({reviewer}){
      const rows=(await pool.query(`SELECT publication.*,(SELECT draft.id FROM learning.form_draft draft
          WHERE draft.public_definition->>'formVersionId'=publication.form_version_id::text AND draft.content_hash=publication.content_hash
          AND lower(draft.owner_email)=lower($1) LIMIT 1) AS bound_draft_id
        FROM learning.form_publication publication WHERE ${accessSql('$1','$2')}
        ORDER BY created_at DESC,id LIMIT 200`,[reviewer.email,reviewer.canAccessAllClasses===true])).rows;
      return rows.map(publicationDto);
    },
    async publicationFromSource({source,id,operationId,reviewer}){
      return withTransaction(pool,async database=>{
        let row,definition,key,approver,owner,revision,sourceHash;
        if(source==='assignment'){
          const access=await database.query(authorizeLearningJourneyPlanAssignmentSql,[id,reviewer.email,reviewer.canAccessAllClasses]);
          if(access.rowCount!==1)throw fail('PUBLICATION_SOURCE_DENIED','Không được dùng phiếu ngoài phạm vi lớp.',403);
          row=(await database.query(`SELECT version.*,grading.private_definition,grading.content_hash AS grading_hash
            FROM learning.form_assignment assignment JOIN learning.form_version version ON version.id=assignment.form_version_id
            JOIN learning.form_grading_key grading ON grading.form_version_id=version.id
            WHERE assignment.id=$1::uuid AND version.status='published'`,[id])).rows[0];
          if(!row)throw fail('PUBLICATION_SOURCE_NOT_READY','Phiếu nguồn chưa có phiên bản được duyệt.');
          const checked=validatePublishedSource({definition:row.public_definition,gradingKey:row.private_definition});
          if(row.definition_hash!==sha256(stableStringify(checked.definition))||row.grading_hash!==sha256(stableStringify(checked.gradingKey)))
            throw fail('PUBLICATION_CONTENT_MISMATCH','Nội dung hoặc đáp án phiếu nguồn chưa khớp.',500);
          definition=checked.definition;key=checked.gradingKey;owner=row.created_by_email;approver=row.approved_by_email;revision=Number(row.version);sourceHash=checked.contentHash;
        }else if(source==='library'){
          row=(await database.query(`SELECT entry.*
            FROM learning.form_library_entry entry
            WHERE entry.id=$1::uuid AND (entry.sharing_scope='izone' OR lower(entry.owner_email)=lower($2))`,[id,reviewer.email])).rows[0];
          if(!row)throw fail('PUBLICATION_SOURCE_DENIED','Không tìm thấy bản chụp trong kho bạn được dùng.',403);
          // Cùng thứ tự khóa draft → version như publishLibrary; đợi save đang chạy rồi đọc revision thật.
          // Không dùng hash đọc trước khóa để quyết định giữ ID và vô tình đóng băng nháp mới hơn.
          const currentDraft=(await database.query(`SELECT status AS draft_status,approved_by_email AS draft_approver,
            approved_hash AS draft_approval_hash,approved_revision AS draft_approved_revision,content_hash AS draft_current_hash
            FROM learning.form_draft WHERE id=$1::uuid FOR UPDATE`,[row.source_draft_id])).rows[0];
          Object.assign(row,currentDraft||{});
          const checked=validatePublishedSource({definition:row.public_definition,gradingKey:row.private_definition});
          if(checked.contentHash!==row.content_hash)throw fail('LIBRARY_CONTENT_MISMATCH','Bản chụp trong kho chưa khớp nội dung.',500);
          const approved=row.approval_hash===row.content_hash&&row.approved_by_email
            ||row.draft_approval_hash===row.content_hash&&Number(row.draft_approved_revision)===Number(row.source_revision)&&['approved','published'].includes(row.draft_status);
          if(!approved&&!(row.sharing_scope==='izone'&&!hasScore(checked.definition)))
            throw fail('LIBRARY_APPROVAL_REQUIRED','Bản chụp cần được duyệt đúng phiên bản trước khi giao. Tạo bản riêng để gửi duyệt.');
          definition=checked.definition;key=checked.gradingKey;owner=row.owner_email;
          approver=row.approval_hash===row.content_hash?row.approved_by_email:row.draft_approval_hash===row.content_hash?row.draft_approver:null;
          revision=Number(row.source_revision);sourceHash=row.content_hash;
        }else throw fail('PUBLICATION_SOURCE_INVALID','Nguồn phiếu chưa hợp lệ.',400);
        if(hasScore(definition)&&(!approver||!await authority(database,approver,definition,owner)))
          throw fail('DRAFT_APPROVAL_REVOKED','Chưa xác minh được quyền duyệt của bản nguồn; cần duyệt lại.',403);
        await lockSource(database,source+':'+id);
        const sourceColumn=source==='assignment'?'source_assignment_id':'source_library_id';
        const previous=(await database.query(`SELECT * FROM learning.form_publication WHERE ${sourceColumn}=$1::uuid`,[id])).rows[0];
        if(previous){if(previous.source_content_hash!==sourceHash)throw fail('PUBLICATION_CONTENT_MISMATCH','Bản nguồn đã đổi sau lần xuất bản.');return {...publicationDto(previous),replayed:true};}
        await lockSource(database,'version:'+definition.formVersionId);
        const existingVersion=(await database.query(`SELECT version.public_definition,version.definition_hash,grading.private_definition,
          grading.content_hash AS grading_hash FROM learning.form_version version JOIN learning.form_grading_key grading ON grading.form_version_id=version.id WHERE version.id=$1::uuid`,[definition.formVersionId])).rows[0];
        if(existingVersion&&(existingVersion.definition_hash!==sha256(stableStringify(definition))||existingVersion.grading_hash!==sha256(stableStringify(key)))){
          if(source!=='library')throw fail('PUBLICATION_CONTENT_MISMATCH','Phiên bản nguồn đã đổi.',500);
          // Bản chụp cũ có thể dùng cùng ID nháp với revision mới: pin phiên bản riêng, giữ nguyên câu và key.
          definition=structuredClone(definition);key=structuredClone(key);definition.formVersionId=crypto.randomUUID();key.formVersionId=definition.formVersionId;
          await storeVersion(database,definition,key,owner,approver||owner);
        }else if(!existingVersion){
          if(source==='library'&&row.draft_current_hash&&row.draft_current_hash!==sourceHash){
            definition=structuredClone(definition);key=structuredClone(key);definition.formVersionId=crypto.randomUUID();key.formVersionId=definition.formVersionId;
          }
          await storeVersion(database,definition,key,owner,approver||owner);
        }
        const checked=validatePublishedSource({definition,gradingKey:key});
        const priorVersion=(await database.query('SELECT * FROM learning.form_publication WHERE form_version_id=$1::uuid',[definition.formVersionId])).rows[0];
        if(priorVersion)return {...publicationDto(priorVersion),replayed:true};
        const saved=(await database.query(`INSERT INTO learning.form_publication(operation_id,${sourceColumn},source_revision,source_content_hash,content_hash,form_version_id,owner_email)
          VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7) RETURNING *`,[operationId,id,revision,sourceHash,checked.contentHash,definition.formVersionId,reviewer.email])).rows[0];
        await publication(database,saved.id,reviewer);return {...publicationDto(saved),replayed:false};
      });
    },
    async publishLibrary({id,expectedRevision,operationId,reviewer}){
      return withTransaction(pool,async database=>{
        const draft=await owned(database,id,reviewer,{lock:true});
        await lockSource(database,'version:'+draft.public_definition.formVersionId);
        if(Number(draft.revision)!==expectedRevision)throw fail('DRAFT_STALE','Nháp đã đổi; đọc lại trước khi xuất bản.');
        const prior=(await database.query('SELECT * FROM learning.form_publication WHERE source_draft_id=$1::uuid OR operation_id=$2::uuid',[id,operationId])).rows;
        if(prior.length){const row=prior[0];if(prior.length!==1||row.source_draft_id!==id||row.operation_id!==operationId)
          throw fail('PUBLICATION_OPERATION_CONFLICT','Phiếu đã được xuất bản hoặc mã thao tác đã dùng.');
          return {...publicationDto(row),replayed:true};}
        const existing=(await database.query('SELECT * FROM learning.form_publication WHERE form_version_id=$1::uuid',[draft.public_definition.formVersionId])).rows[0];
        if(existing){if(existing.content_hash!==draft.content_hash)throw fail('PUBLICATION_CONTENT_MISMATCH','Mã phiên bản đã được dùng cho nội dung khác. Tạo bản riêng trước khi xuất bản.');
          return {...publicationDto({...existing,bound_draft_id:id}),replayed:true};}
        if(draft.status!=='approved'||draft.approved_hash!==draft.content_hash||draft.approved_revision!==draft.revision)
          throw fail('DRAFT_APPROVAL_REQUIRED','Cần duyệt đúng phiên bản trước khi xuất bản vào kho.');
        if(!await authority(database,draft.approved_by_email,draft.public_definition,draft.owner_email))
          throw fail('DRAFT_APPROVAL_REVOKED','Quyền duyệt đã thay đổi; cần duyệt lại.',403);
        const checked=validateAuthoringPayload({definition:draft.public_definition,gradingKey:draft.private_definition,requireAnswers:true});
        const definition=checked.definition,key=checked.gradingKey;
        const template=(await database.query(`INSERT INTO learning.form_template(title,kind,created_by_email) VALUES($1,$2,$3) RETURNING id`,
          [definition.title,definition.kind,draft.owner_email])).rows[0];
        await database.query(`INSERT INTO learning.form_version(id,template_id,version,public_definition,definition_hash,status,
          created_by_email,approved_by_email,published_at) VALUES($1::uuid,$2::uuid,1,$3::jsonb,$4,'published',$5,$6,now())`,
          [definition.formVersionId,template.id,JSON.stringify(definition),sha256(stableStringify(definition)),draft.owner_email,draft.approved_by_email]);
        await database.query(`INSERT INTO learning.form_grading_key(form_version_id,schema_version,grader_version,private_definition,content_hash)
          VALUES($1::uuid,'FormGradingKeyV1',$2,$3::jsonb,$4)`,[definition.formVersionId,key.graderVersion,JSON.stringify(key),sha256(stableStringify(key))]);
        const saved=(await database.query(`INSERT INTO learning.form_publication(operation_id,source_draft_id,source_revision,content_hash,form_version_id,owner_email)
          VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6) RETURNING *`,[operationId,id,draft.revision,draft.content_hash,definition.formVersionId,reviewer.email])).rows[0];
        const readback=(await database.query(`SELECT version.definition_hash,grading.content_hash FROM learning.form_version version
          JOIN learning.form_grading_key grading ON grading.form_version_id=version.id WHERE version.id=$1::uuid`,[saved.form_version_id])).rows[0];
        if(!readback||readback.definition_hash!==sha256(stableStringify(definition))||readback.content_hash!==sha256(stableStringify(key)))
          throw fail('PUBLICATION_READBACK_MISMATCH','Chưa xác nhận được phiên bản vừa xuất bản.',500);
        return {...publicationDto(saved),replayed:false};
      });
    },
    async assignPublication({id,targets,operationId,reviewer}){
      const unique=new Set(targets.map(t=>String(t.classId)+':'+t.sessionNumber));
      if(unique.size!==targets.length)throw fail('DELIVERY_DUPLICATE_TARGET','Không chọn trùng một lớp và buổi.',400);
      const results=[];
      // Kiểm quyền đọc nguồn trước vòng lặp; không trả nội dung private ra caller.
      await publication(pool,id,reviewer);
      for(const target of targets){
        const operation=targetOperation(operationId,target.classId,target.sessionNumber);
        try{
          const delivered=await withTransaction(pool,async database=>{
            const source=await publication(database,id,reviewer),classInfo=await authorizeClass(database,target.classId,reviewer);
            await database.query('INSERT INTO learning.form_draft_class_lock VALUES($1::bigint) ON CONFLICT DO NOTHING',[target.classId]);
            await database.query('SELECT erp_course_class_id FROM learning.form_draft_class_lock WHERE erp_course_class_id=$1::bigint FOR UPDATE',[target.classId]);
            const prior=(await database.query('SELECT * FROM learning.form_delivery WHERE operation_id=$1::uuid',[operation])).rows[0];
            if(prior){if(prior.publication_id!==id||prior.owner_email.toLowerCase()!==reviewer.email.toLowerCase())
              throw fail('DELIVERY_OPERATION_CONFLICT','Mã thao tác đã được dùng cho bản khác.');
              return {...await readDelivery(database,prior),replayed:true};}
            await assertCourse(database,{erp_course_class_id:target.classId,public_definition:source.public_definition});
            await checkSchedule(database,target.classId,target.sessionNumber);
            const existing=await database.query(`SELECT id FROM learning.form_assignment WHERE erp_course_class_id=$1::bigint
              AND session_number=$2 AND status IN ('published','closed') LIMIT 1`,[target.classId,target.sessionNumber]);
            if(existing.rowCount)throw fail('ASSIGNMENT_SESSION_CONFLICT','Buổi này đã có phiếu; hãy thu hồi hoặc thay phiếu có giữ lịch sử.');
            const current=await database.query(fetchCourseCurrentRosterSql,[target.classId]);
            if(!current.rowCount||current.rows.some(s=>s.membership_verified!==true))throw fail('DRAFT_ROSTER_UNVERIFIED','Đọc lại danh sách ERP trước khi giao bài.');
            const refs=new Set(current.rows.map(s=>s.student_ref)),roster=(await database.query(fetchLearningRosterForClassSql,[target.classId])).rows.filter(s=>refs.has(s.student_ref));
            if(roster.length!==refs.size)throw fail('DRAFT_ROSTER_CHANGED','Danh sách học viên cần được đối chiếu lại.');
            const definition=source.public_definition;
            const assignment=(await database.query(insertLearningAssignmentSql,[source.form_version_id,definition.courseCode||null,
              target.classId,classInfo.class_name,target.sessionNumber,definition.title,null,null,reviewer.email])).rows[0];
            for(const student of roster)await database.query(insertLearningAssignmentRosterSql,[assignment.assignment_id,student.student_ref,student.student_id,student.student_name,student.display_discriminator]);
            const first=Math.min(...definition.blocks.map(b=>b.checkpoint));
            for(const block of definition.blocks)await database.query(insertLearningAssignmentBlockReleaseSql,[assignment.assignment_id,block.blockId,block.checkpoint,block.checkpoint===first?'open':'locked',reviewer.email]);
            const delivery=(await database.query(`INSERT INTO learning.form_delivery(operation_id,publication_id,owner_email,erp_course_class_id,session_number,assignment_id)
              VALUES($1::uuid,$2::uuid,$3,$4::bigint,$5,$6::uuid) RETURNING *`,[operation,id,reviewer.email,target.classId,target.sessionNumber,assignment.assignment_id])).rows[0];
            const result=await readDelivery(database,delivery);
            if(result.formVersionId!==source.form_version_id||result.blockCount!==definition.blocks.length)
              throw fail('DELIVERY_READBACK_MISMATCH','Phiên bản hoặc các phần vừa giao chưa khớp.',500);
            return {...result,replayed:false};
          });
          results.push({...target,ok:true,delivery:delivered});
        }catch(error){
          // Lỗi đích sau một đích thành công phải được báo theo từng dòng để retry đúng đích.
          const known=error instanceof FormAuthoringError;
          results.push({...target,ok:false,error:known?error.code:'DELIVERY_FAILED',
            message:known?error.message:'Chưa giao được đích này. Thử lại sẽ đối chiếu mã thao tác cũ.',status:known?error.httpStatus:500});}
      }
      return {status:results.every(r=>r.ok)?'success':results.some(r=>r.ok)?'partial':'failure',results};
    }
  };
}
