import crypto from 'node:crypto';
import {withTransaction} from './db.js';
import {authorizeLearningJourneyPlanClassSql} from './learning-sql.js';
import {fetchCourseCurrentRosterSql} from './learning-course-overview.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => typeof value === 'string' ? JSON.parse(value) : value;
export function commentView(row) {
  if (!row) return null;
  return {studentRef:row.student_ref,sessionNumber:Number(row.session_number),
    noteText:row.note_text,visibility:row.visibility,revision:Number(row.revision),
    authorDisplayName:row.author_display_name,updatedAt:row.updated_at || row.occurred_at};
}

// Mã hóa link để GV lấy lại đúng link trên máy khác; khóa chỉ có trong cấu hình server.
export function createProgressLinkCipher({keys={},activeVersion='v1'}={}) {
  const keyMap = new Map(Object.entries(keys).map(([version,value])=>[version,Buffer.from(value,'base64')]));
  if (!keyMap.has(activeVersion) || [...keyMap.values()].some(key=>key.length!==32)) {
    throw new Error('Khóa mã hóa Hành trình phải là 32 byte, có phiên bản hiện hành.');
  }
  const aad = row => Buffer.from(`${row.id}:${row.erp_course_class_id}:${row.student_ref}`);
  return {
    encrypt(token,row) {
      const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',keyMap.get(activeVersion),iv);
      cipher.setAAD(aad(row));
      const data=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
      return {ciphertext:Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64'),version:activeVersion};
    },
    decrypt(row) {
      const key=keyMap.get(row.token_key_version);
      if (!key) throw new Error('Không tìm thấy phiên bản khóa của link.');
      const raw=Buffer.from(row.token_ciphertext,'base64');
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
      decipher.setAAD(aad(row));decipher.setAuthTag(raw.subarray(12,28));
      const token=Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8');
      if(hash(token)!==row.token_hash) throw new Error('Link giải mã không khớp.');
      return token;
    }
  };
}

export function createJourneyCommentService({pool,ErrorType,cipher}) {
  const fail=(code,message,status=409)=>{throw new ErrorType(code,message,status);};
  async function authorize(database,input,{session=false}={}) {
    const result=await database.query(authorizeLearningJourneyPlanClassSql,
      [input.classId,input.reviewer.email,input.reviewer.canAccessAllClasses]);
    if(result.rowCount!==1) fail('CLASS_ACCESS_DENIED','Lớp không thuộc phạm vi được cấp quyền.',403);
    const roster=await database.query(fetchCourseCurrentRosterSql,[input.classId]);
    let person=roster.rows.find(row=>row.student_ref===input.studentRef);
    if(!person) {
      const historic=await database.query(`SELECT roster.student_ref::text,roster.student_name_snapshot AS student_name
        FROM learning.form_assignment_roster AS roster JOIN learning.form_assignment AS assignment ON assignment.id=roster.assignment_id
        WHERE assignment.erp_course_class_id=$1::bigint AND roster.student_ref=$2::uuid
        ORDER BY assignment.session_number DESC,assignment.created_at DESC LIMIT 1`,[input.classId,input.studentRef]);
      person=historic.rows[0];
    }
    if(!person) fail('JOURNEY_STUDENT_NOT_FOUND','Không tìm thấy học viên trong lớp hoặc lịch sử lớp.',404);
    if(session) {
      // Khóa kế hoạch trong lần lưu: thay đổi số buổi phải chờ nhận xét commit/rollback.
      const plan=await database.query(`SELECT total_sessions FROM learning.class_journey_plan
        WHERE erp_course_class_id=$1::bigint FOR SHARE`,[input.classId]);
      if(!plan.rowCount || input.sessionNumber>Number(plan.rows[0].total_sessions))
        fail('COMMENT_SESSION_NOT_CONFIRMED','Buổi nhận xét phải nằm trong kế hoạch lớp đã xác nhận.');
    }
    return {...result.rows[0],...person};
  }
  async function lock(database,key) {
    await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  }
  function requestHash(input,action) {
    return hash(JSON.stringify([action,String(input.classId),input.studentRef,input.sessionNumber??null,
      input.expectedRevision??null,input.expectedAccessId??null,input.noteText??null,input.reviewer.email]));
  }
  async function readComments(classId,studentRef=null,{visibleOnly=false}={}) {
    const result=await pool.query(`SELECT * FROM learning.student_session_comment WHERE erp_course_class_id=$1::bigint
      AND ($2::uuid IS NULL OR student_ref=$2::uuid) ${visibleOnly?"AND visibility='visible'":''}
      ORDER BY session_number`,[classId,studentRef]);
    return result.rows.map(commentView);
  }
  async function writeComment(input,hide=false) {
    const text=String(input.noteText??'').trim();
    if(!hide && (!text || [...text].length>1000 || text.includes('\0')))
      fail('INVALID_SESSION_COMMENT','Nhận xét cần từ 1 đến 1.000 ký tự.',400);
    input={...input,noteText:hide?null:text};
    const fingerprint=requestHash(input,hide?'hide':'save');
    return withTransaction(pool,async db=>{
      await authorize(db,input,{session:true});
      await lock(db,`comment:${input.classId}:${input.studentRef}:${input.sessionNumber}`);
      await lock(db,`comment-operation:${input.operationId}`);
      const replay=await db.query('SELECT * FROM learning.student_session_comment_revision WHERE operation_id=$1::uuid',[input.operationId]);
      if(replay.rowCount) {
        if(replay.rows[0].request_hash!==fingerprint) fail('COMMENT_OPERATION_CONFLICT','Mã thao tác đã được dùng cho nội dung khác.');
        return {...commentView(replay.rows[0]),replayed:true};
      }
      const key=[input.classId,input.studentRef,input.sessionNumber];
      const prior=(await db.query(`SELECT * FROM learning.student_session_comment WHERE erp_course_class_id=$1::bigint
        AND student_ref=$2::uuid AND session_number=$3`,key)).rows[0];
      if(Number(prior?.revision||0)!==input.expectedRevision) fail('COMMENT_STALE',
        'Nhận xét đã được cập nhật. Bản bạn đang gõ vẫn được giữ; tải bản hiện hành trước khi lưu.');
      if(hide && !prior) fail('COMMENT_NOT_FOUND','Chưa có nhận xét để ẩn.',404);
      const name=String(input.reviewer.displayName||'Giáo viên').trim();
      const displayName=name.includes('@')?'Giáo viên':name.slice(0,200);
      const row=(await db.query(`INSERT INTO learning.student_session_comment
        (erp_course_class_id,student_ref,session_number,note_text,visibility,revision,author_display_name,updated_by_email)
        VALUES ($1::bigint,$2::uuid,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (erp_course_class_id,student_ref,session_number) DO UPDATE SET note_text=EXCLUDED.note_text,
          visibility=EXCLUDED.visibility,revision=EXCLUDED.revision,author_display_name=EXCLUDED.author_display_name,
          updated_by_email=EXCLUDED.updated_by_email,updated_at=now() RETURNING *`,
        [...key,hide?prior.note_text:text,hide?'hidden':'visible',Number(prior?.revision||0)+1,displayName,input.reviewer.email])).rows[0];
      await db.query(`INSERT INTO learning.student_session_comment_revision
        (operation_id,erp_course_class_id,student_ref,session_number,revision,action,note_text,visibility,
          author_display_name,actor_email,request_hash)
        VALUES ($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.operationId,...key,row.revision,hide?'hide':prior?'edit':'publish',row.note_text,row.visibility,
          row.author_display_name,input.reviewer.email,fingerprint]);
      const readback=(await db.query('SELECT * FROM learning.student_session_comment_revision WHERE operation_id=$1::uuid',[input.operationId])).rows[0];
      if(!readback || readback.request_hash!==fingerprint || Number(readback.revision)!==Number(row.revision))
        fail('COMMENT_READBACK_FAILED','Chưa xác nhận được nhận xét vừa lưu.',500);
      return {...commentView(readback),replayed:false};
    });
  }
  async function progressLink(input,action='resolve') {
    const fingerprint=requestHash(input,action);
    return withTransaction(pool,async db=>{
      const person=await authorize(db,input);
      await lock(db,`progress-link:${input.classId}:${input.studentRef}`);
      await lock(db,`progress-link-operation:${input.operationId}`);
      const operation=(await db.query('SELECT * FROM learning.student_progress_link_operation WHERE operation_id=$1::uuid',[input.operationId])).rows[0];
      if(operation && operation.request_hash!==fingerprint) fail('PROGRESS_LINK_OPERATION_CONFLICT','Mã thao tác đã được dùng cho link khác.');
      const rows=(await db.query(`SELECT * FROM learning.student_progress_access WHERE erp_course_class_id=$1::bigint
        AND student_ref=$2::uuid ORDER BY created_at DESC,id DESC`,[input.classId,input.studentRef])).rows;
      let current=rows.find(row=>row.status==='active')||rows[0];
      if(operation) {
        if(!current || current.id!==operation.access_id || (action!=='revoke' && current.status!=='active'))
          fail('PROGRESS_LINK_STALE','Link đã thay đổi sau thao tác này. Hãy lấy trạng thái hiện hành.');
      } else if(action!=='resolve') {
        if((current?.id||null)!==input.expectedAccessId) fail('PROGRESS_LINK_STALE','Link đã được thay đổi bởi giáo viên khác. Hãy tải lại.');
        if(action==='revoke' && !current) fail('PROGRESS_LINK_NOT_FOUND','Chưa có link để thu hồi.',404);
        if(current) await db.query(`UPDATE learning.student_progress_access SET status='revoked',revoked_at=now(),updated_at=now()
          WHERE id=$1::uuid`,[current.id]);
        if(action==='revoke') current={...current,status:'revoked'};
        else current=null;
      }
      if(!current) {
        if(!cipher) fail('PROGRESS_LINK_KEY_UNAVAILABLE','Chưa có khóa lưu link Hành trình.',503);
        const token=crypto.randomBytes(32).toString('base64url');
        const row={id:crypto.randomUUID(),erp_course_class_id:String(input.classId),student_ref:input.studentRef};
        const sealed=cipher.encrypt(token,row);
        current=(await db.query(`INSERT INTO learning.student_progress_access
          (id,erp_course_class_id,student_ref,token_hash,token_ciphertext,token_key_version,status,expires_at,
            created_by_email,operation_key,idempotency_key)
          VALUES ($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,'active',NULL,$7,$8,$9) RETURNING *`,
          [row.id,input.classId,input.studentRef,hash(token),sealed.ciphertext,sealed.version,input.reviewer.email,
            `progress-link:${input.operationId}`,`progress-link:${input.operationId}:write`])).rows[0];
      }
      if(!operation) await db.query(`INSERT INTO learning.student_progress_link_operation
        (operation_id,erp_course_class_id,student_ref,actor_email,request_hash,action,access_id)
        VALUES ($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7::uuid)`,
        [input.operationId,input.classId,input.studentRef,input.reviewer.email,fingerprint,action,current.id]);
      const valid=current.status==='active' && (!current.expires_at || Date.parse(current.expires_at)>Date.now());
      let token=null;
      if(valid && current.token_ciphertext) {
        try {token=cipher.decrypt(current);} catch {fail('PROGRESS_LINK_KEY_UNAVAILABLE','Chưa đọc lại được link; không thay link cũ. Hãy kiểm tra khóa server.',503);}
      }
      return {accessId:current.id,classId:String(input.classId),className:person.class_name,studentRef:input.studentRef,
        studentName:person.student_name,status:!valid?current.status==='revoked'?'revoked':'expired':token?'active':'legacy',
        accessToken:token,expiresAt:current.expires_at||null,replayed:Boolean(operation)};
    });
  }
  return {
    readComments,
    saveSessionComment:input=>writeComment(input),
    hideSessionComment:input=>writeComment(input,true),
    resolveStudentProgressLink:input=>progressLink(input),
    rotateStudentProgressLink:input=>progressLink(input,'rotate'),
    revokeStudentProgressLink:input=>progressLink(input,'revoke'),
    async getSessionCommentHistory(input) {
      await authorize(pool,input,{session:true});
      const rows=await pool.query(`SELECT * FROM learning.student_session_comment_revision WHERE erp_course_class_id=$1::bigint
        AND student_ref=$2::uuid AND session_number=$3 ORDER BY revision DESC`,[input.classId,input.studentRef,input.sessionNumber]);
      return rows.rows.map(row=>({...commentView(row),action:row.action}));
    },
    async studentCommentIdentity(input) {
      let result;
      if(input.attemptToken) result=await pool.query(`SELECT assignment.erp_course_class_id::text AS class_id,attempt.student_ref::text
        FROM learning.attempt JOIN learning.form_assignment AS assignment ON assignment.id=attempt.assignment_id
        WHERE attempt.attempt_token=$1::uuid`,[input.attemptToken]);
      else if(input.accessToken) result=await pool.query(`SELECT erp_course_class_id::text AS class_id,student_ref::text
        FROM learning.student_progress_access WHERE token_hash=$1 AND status='active' AND (expires_at IS NULL OR expires_at>now())`,[hash(input.accessToken)]);
      else if(input.identityConfirmed===true) result=await pool.query(`SELECT assignment.erp_course_class_id::text AS class_id,roster.student_ref::text
        FROM learning.form_assignment AS assignment JOIN learning.form_assignment_roster AS roster ON roster.assignment_id=assignment.id
        WHERE assignment.public_token=$1::uuid AND roster.student_ref=$2::uuid AND assignment.status IN ('published','closed')`,[input.publicToken,input.studentRef]);
      if(result?.rowCount!==1) fail('PROGRESS_LINK_INVALID','Không tìm thấy hành trình cho người học đã xác nhận.',404);
      return result.rows[0];
    },
    async getStudentSessionComments(input) {
      const identity=await this.studentCommentIdentity(input);
      return {classId:identity.class_id,studentRef:identity.student_ref,
        comments:await readComments(identity.class_id,identity.student_ref,{visibleOnly:true})};
    }
  };
}
