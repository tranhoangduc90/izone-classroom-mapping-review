// Nhận lịch chốt, roster và trạng thái từng phiếu, tạo đủ ô học viên × buổi.
// Buổi chưa có phiếu/Test/tương lai không bị đánh là vắng; trạng thái Portal tách khỏi Progress Log.
export function buildCourseOverview({classId,className,plan,currentRoster,rows,testResults=[],testCoverage=null,capturedAt=new Date().toISOString()}) {
  const assignments = new Map();
  const people = new Map(currentRoster.map(student=>[student.student_ref,{studentRef:student.student_ref,
    name:student.student_name,discriminator:student.display_discriminator,current:true}]));
  for (const row of rows) {
    assignments.set(row.assignment_id,{assignmentId:row.assignment_id,sessionNumber:Number(row.session_number),title:row.title});
    if (row.student_ref && !people.has(row.student_ref)) people.set(row.student_ref,{studentRef:row.student_ref,
      name:row.student_name_snapshot,discriminator:row.display_discriminator,current:false});
  }
  const highest = Math.max(0,...[...assignments.values()].map(a=>a.sessionNumber));
  const total = Math.max(Number(plan?.total_sessions || 0),highest);
  const tests = new Set(plan?.test_session_numbers || []);
  const dates = new Map((plan?.session_dates || []).map(date=>[date.sessionNumber,date.date]));
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Ho_Chi_Minh'}).format(new Date(capturedAt));
  const sessions=Array.from({length:total},(_,i)=>{
    const sessionNumber=i+1, matching=[...assignments.values()].filter(a=>a.sessionNumber===sessionNumber);
    return {sessionNumber,sessionDate:dates.get(sessionNumber)||null,sessionKind:tests.has(sessionNumber)?'test':'lesson',
      assignments:matching,future:dates.has(sessionNumber)&&dates.get(sessionNumber)>today,conflict:matching.length>1};
  });
  const statusByKey=new Map(rows.filter(r=>r.student_ref).map(r=>[r.assignment_id+':'+r.student_ref,r]));
  const resultByKey=new Map(testResults.map(r=>[r.sessionNumber+':'+r.studentRef,r.result]));
  const students=[...people.values()].sort((a,b)=>a.name.localeCompare(b.name,'vi')||a.studentRef.localeCompare(b.studentRef)).map(student=>{
    const cells=sessions.map(session=>{
      const assignment=session.assignments.length===1?session.assignments[0]:null;
      const row=assignment?statusByKey.get(assignment.assignmentId+':'+student.studentRef):null;
      const testResult=resultByKey.get(session.sessionNumber+':'+student.studentRef)||null;
      const status=session.conflict?'needs_review':testResult?'test_result':!assignment
        ?session.sessionKind==='test'?'test_pending':'no_assignment'
        :!row?'not_assigned':row.submission_id?row.completeness==='complete'?'complete':'incomplete'
        :session.future?'scheduled':'not_submitted';
      return {sessionNumber:session.sessionNumber,assignmentId:assignment?.assignmentId||null,status,
        submissionId:row?.submission_id||null,submittedAt:row?.submitted_at||null,
        attendanceStatus:row?.attendance_status||null,portalSync:row?.portal_sync||null,testResult};
    });
    return {...student,cells,completeCount:cells.filter(c=>c.status==='complete').length};
  });
  return {classId,className,capturedAt,planRevision:Number(plan?.revision||0),totalSessions:total,
    rosterCoverage:!currentRoster.length?'unknown':currentRoster.some(student=>student.membership_verified===false)?'mapping_unverified':'erp_snapshot',
    planOutdated:highest>Number(plan?.total_sessions||0),sessions,students,
    counts:{students:students.length,currentStudents:students.filter(s=>s.current).length,
      assignments:assignments.size,complete:students.reduce((n,s)=>n+s.completeCount,0)},
    testCoverage:testCoverage || (testResults.length?'connected':(plan?.test_sources?.length?'awaiting_source_read':'not_mapped'))};
}

// Chi tiết đọc bài hiện hành theo ID lớp, buổi và học viên; không lấy đáp án riêng trong public definition.
export const fetchCourseSessionDetailSql = `SELECT assignment.id::text AS assignment_id,
  version.public_definition, status.student_ref::text AS student_ref,
  status.student_name_snapshot AS student_name, status.display_discriminator,
  status.submission_id::text AS submission_id, submission.response_payload AS responses,
  (SELECT jsonb_agg(jsonb_build_object('itemVersionId', item.item_version_id::text,
    'verdict', item.verdict, 'scoreEarned', item.score_earned, 'maxScore', item.max_score))
    FROM learning.grading_result_item AS item WHERE item.grading_run_id = grading.id) AS grading_items,
  (SELECT jsonb_build_object('noteText', note.note_text, 'sentAt', note.sent_at)
    FROM learning.teacher_session_feedback AS note
    WHERE note.assignment_id=assignment.id AND note.student_ref=status.student_ref
    ORDER BY note.revision DESC LIMIT 1) AS teacher_session_feedback
FROM learning.form_assignment AS assignment
JOIN learning.form_version AS version ON version.id=assignment.form_version_id
JOIN learning.assignment_student_status AS status ON status.assignment_id=assignment.id AND status.student_ref=$3::uuid
LEFT JOIN learning.submission AS submission ON submission.id=status.submission_id
LEFT JOIN LATERAL (SELECT run.id FROM learning.grading_run AS run WHERE run.submission_id=submission.id
  AND run.status='complete' ORDER BY run.completed_at DESC NULLS LAST,run.created_at DESC,run.id DESC LIMIT 1) AS grading ON true
WHERE assignment.erp_course_class_id=$1::bigint AND assignment.session_number=$2::integer
  AND assignment.status IN ('published','closed');`;

export const fetchCourseOverviewSql = `SELECT
  assignment.id::text AS assignment_id, assignment.session_number, assignment.title,
  status.student_ref::text AS student_ref, status.student_name_snapshot, status.display_discriminator,
  status.submission_id::text AS submission_id, status.completeness, status.submitted_at, status.attendance_status,
  (SELECT jsonb_build_object('status', job.status, 'updatedAt', job.updated_at,
    'lastErrorCode', job.last_error_code, 'portalOutcome', 'not_recorded')
    FROM learning.outbox_job AS job
    WHERE job.job_type = 'sync_portal_attendance'
      AND job.unit_key = 'portal-attendance:' || assignment.id::text || ':session:' || assignment.session_number::text
      AND job.entity_key = 'student:' || status.student_ref::text
    ORDER BY job.created_at DESC, job.id DESC LIMIT 1) AS portal_sync
FROM learning.form_assignment AS assignment
LEFT JOIN learning.assignment_student_status AS status ON status.assignment_id=assignment.id
WHERE assignment.erp_course_class_id=$1::bigint AND assignment.status IN ('published','closed')
ORDER BY assignment.session_number,assignment.id,status.student_ref;`;

// Snapshot ERP quyết định roster hiện hành khi đã có. Khi chưa đồng bộ, trả cờ chưa đối chiếu
// cùng mapping đang biết để UI không khẳng định đó là sĩ số mới nhất trên Portal.
export const fetchCourseCurrentRosterSql = `WITH source AS (
  SELECT EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot WHERE erp_course_class_id=$1::bigint) AS known
), active AS (
  SELECT DISTINCT ON (review.erp_student_contact_id) review.public_id AS student_ref,
    review.erp_student_name_snapshot AS student_name, source.known AS membership_verified
  FROM mapping.student_mapping_review AS review CROSS JOIN source
  WHERE review.erp_course_class_id=$1::bigint AND review.status <> 'superseded'
    AND (NOT source.known OR EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot AS membership
      WHERE membership.erp_course_class_id=review.erp_course_class_id
        AND membership.erp_student_contact_id=review.erp_student_contact_id
        AND COALESCE(to_jsonb(membership)->>'source_state','active')='active'
        AND lower(trim(COALESCE(to_jsonb(membership)->>'registration_status',''))) NOT IN ('dropped','on_hold')))
  ORDER BY review.erp_student_contact_id,review.updated_at DESC NULLS LAST,review.id DESC
), numbered AS (
  SELECT active.*,count(*) OVER (PARTITION BY lower(trim(student_name))) AS same_name_count,
    row_number() OVER (PARTITION BY lower(trim(student_name)) ORDER BY student_ref) AS same_name_number FROM active
)
SELECT student_ref::text,student_name,membership_verified,
  CASE WHEN same_name_count>1 THEN 'Học viên '||same_name_number::text ELSE '' END AS display_discriminator
FROM numbered ORDER BY student_name,student_ref;`;
