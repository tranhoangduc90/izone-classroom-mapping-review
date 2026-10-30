// Dữ liệu nhận vào: lớp, học viên và các mã bài Test đã được giảng viên ghép vào buổi.
// Việc chính: nối định danh học viên với kho bài thi và lấy bản hoàn tất mới nhất.
// Kết quả: chỉ điểm tóm tắt Listening/Reading; Writing chỉ hiện khi bản chấm cuối đã sẵn sàng.
// Khi lỗi hoặc định danh không duy nhất: không trả điểm; caller giữ Journey và báo nguồn tạm lỗi.
import {createHash} from 'node:crypto';
const identitySql = `WITH requested AS (
  SELECT DISTINCT slug AS test_slug FROM assessment.test_definition
  WHERE ($3::text[] IS NULL OR slug = ANY($3::text[]))
    AND slug ~ '^(term-test-[1-9][0-9]*|mini-test-[a-z0-9-]+)$'
), candidate_identity AS (
  SELECT requested.test_slug, roster.erp_student_contact_id
  FROM requested
  JOIN assessment.term_test_roster AS roster
    ON roster.test_slug = requested.test_slug
   AND roster.erp_course_class_id = $1::bigint
   AND roster.student_ref = $2::uuid
  UNION ALL
  SELECT requested.test_slug, review.erp_student_contact_id
  FROM requested
  JOIN mapping.student_mapping_review AS review
    ON review.erp_course_class_id = $1::bigint
   AND review.public_id = $2::uuid
   AND review.status <> 'superseded'
  UNION ALL
  SELECT requested.test_slug, -temporary.temporary_student_id
  FROM requested
  JOIN assessment.term_test_temporary_student AS temporary
    ON temporary.test_slug = requested.test_slug
   AND temporary.erp_course_class_id = $1::bigint
   AND temporary.student_ref = $2::uuid
   AND temporary.active = true
), unique_identity AS (
  SELECT test_slug, min(erp_student_contact_id) AS erp_student_contact_id
  FROM candidate_identity
  GROUP BY test_slug
  HAVING count(DISTINCT erp_student_contact_id) = 1
 )`;
const resultSql = identitySql+`, source_rows AS (
  SELECT attempt.test_slug, definition.title, attempt.combined_result AS result_json,
    attempt.completed_at AS completed_at, attempt.writing_submitted_at,
    CASE WHEN final.status = 'ready' THEN final.writing_score ELSE NULL END AS writing_score,
    CASE WHEN final.status = 'ready' THEN to_jsonb(final) ELSE NULL END AS writing_final,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('number',run.task_number,'status',run.status) ORDER BY run.task_number)
      FROM assessment.term_test_writing_grading_run run WHERE run.attempt_id=attempt.id
        AND run.grading_version=COALESCE((to_jsonb(final)->>'grading_version')::integer,1)), '[]'::jsonb) AS writing_task_states,
    attempt.id::text AS result_attempt_id, 1 AS source_priority
  FROM unique_identity AS identity
  JOIN assessment.term_test_attempt AS attempt
    ON attempt.test_slug = identity.test_slug
   AND attempt.erp_course_class_id = $1::bigint
   AND attempt.erp_student_contact_id = identity.erp_student_contact_id
  JOIN assessment.test_definition AS definition ON definition.slug = attempt.test_slug
  LEFT JOIN assessment.term_test_writing_grading_final AS final ON final.attempt_id = attempt.id
  WHERE attempt.completed_at IS NOT NULL AND attempt.combined_result IS NOT NULL
    AND to_jsonb(attempt)->>'superseded_at' IS NULL
  UNION ALL
  SELECT legacy.test_slug, definition.title, legacy.result AS result_json,
    legacy.updated_at AS completed_at, NULL::timestamptz AS writing_submitted_at,
    NULL::numeric AS writing_score, NULL::jsonb AS writing_final, '[]'::jsonb AS writing_task_states,
    NULL::text AS result_attempt_id, 0 AS source_priority
  FROM unique_identity AS identity
  JOIN assessment.mini_test_result AS legacy
    ON legacy.test_slug = identity.test_slug
   AND legacy.erp_course_class_id = $1::bigint
   AND legacy.erp_student_contact_id = identity.erp_student_contact_id
  JOIN assessment.test_definition AS definition ON definition.slug = legacy.test_slug
  WHERE legacy.result IS NOT NULL
), ranked AS (
  SELECT source_rows.*,
    row_number() OVER (PARTITION BY test_slug
      ORDER BY completed_at DESC, source_priority DESC, result_attempt_id DESC NULLS LAST) AS rank
  FROM source_rows
)
SELECT test_slug, title, result_json, completed_at, writing_submitted_at, writing_score,
  writing_final, result_attempt_id, writing_task_states
FROM ranked WHERE rank = 1;`;

function sectionScore(section) {
  if (!section || typeof section !== 'object') return null;
  if(section.correct==null||section.total==null)return null;
  const correct = Number(section.correct);
  const total = Number(section.total);
  if (!Number.isInteger(correct) || !Number.isInteger(total)
    || total < 1 || correct < 0 || correct > total) return null;
  const band = section.band;
  const analysis=sectionAnalysis(section.typeStats);
  return { correct, total,...(analysis?{analysis}:{}),
    band: typeof band === 'number' && Number.isFinite(band) && band >= 0 && band <= 9
      ? band : band === '<2.5' ? band : null };
}

function sectionAnalysis(stats){
  if(!Array.isArray(stats)||!stats.length||stats.length>100)return null;
  const seen=new Set(),values=[];
  for(const value of stats){
    const type=typeof value?.type==='string'?value.type.trim():'';
    if(!type||type.length>200||seen.has(type)||!Number.isInteger(value.correct)||!Number.isInteger(value.total)
      ||value.total<1||value.correct<0||value.correct>value.total)return null;
    seen.add(type);values.push({type,correct:value.correct,total:value.total,percentage:value.correct/value.total});
  }
  // Cùng quy tắc splitPerformance của Term Test, áp riêng từng kỹ năng.
  values.sort((a,b)=>b.percentage-a.percentage||a.type.localeCompare(b.type,'vi'));
  const highest=values[0].percentage,lowest=values.at(-1).percentage;
  return {status:'available',needsImprovement:values.filter(v=>v.percentage===lowest&&lowest!==highest)
    .map(({percentage,...value})=>value)};
}
const resultRef=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/iu.test(value)
  ?createHash('sha256').update(value).digest('hex'):null;
function writingTasks(final){
  if(!final||typeof final!=='object')return null;
  const tasks={};
  for(const number of [1,2]){
    const raw=final['task_'+number+'_score'];if(raw==null)continue;
    const score=Number(raw);if(!Number.isFinite(score)||score<0||score>9)throw Error('TEST_RESULT_ROW_INVALID');
    tasks[number]={score,status:'ready'};
  }
  return Object.keys(tasks).length?tasks:null;
}

function decodeTestResult(row, allowed) {
  if (!allowed.has(row.test_slug)) throw new Error('TEST_RESULT_ROW_INVALID');
  const data = row.result_json;
  const completed = new Date(row.completed_at);
  if (!data || typeof data !== 'object' || !Number.isFinite(completed.getTime())) {
    throw new Error('TEST_RESULT_ROW_INVALID');
  }
  const writingScore = row.writing_score == null ? null : Number(row.writing_score);
  if (writingScore !== null && (!Number.isFinite(writingScore)
    || writingScore < 0 || writingScore > 9)) throw new Error('TEST_RESULT_ROW_INVALID');
  let tasks=writingTasks(row.writing_final);const ref=resultRef(row.result_attempt_id);
  for(const state of Array.isArray(row.writing_task_states)?row.writing_task_states:[]){if(![1,2].includes(state.number))throw Error('TEST_RESULT_ROW_INVALID');
    tasks??={};if(!tasks[state.number])tasks[state.number]={score:null,status:['review_required','failed'].includes(state.status)?'needs_review':row.writing_submitted_at?'pending':'not_submitted'};}
  return {
    testSlug: row.test_slug,
    title: String(row.title || 'Buổi Test'),
    completedAt: completed.toISOString(),
    ...(ref?{resultRef:ref}:{}),
    listening: sectionScore(data.listening),
    reading: sectionScore(data.reading),
    writing: row.test_slug.startsWith('term-test-')
      ? { status: writingScore !== null ? 'ready'
        : row.writing_submitted_at ? 'pending' : 'not_submitted',
      score: writingScore,...(tasks?{tasks}:{}) } : null
  };
}

export function createLearningTestResultReader({ pool }) {
  if (!pool) return null;
  const reader = async ({ classId: rawClassId, studentRef, testSlugs=null }) => {
    const classId = String(rawClassId);
    if (!/^\d{1,19}$/u.test(classId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(studentRef)
      || testSlugs!==null&&(!Array.isArray(testSlugs) || testSlugs.length > 100
      || testSlugs.some(slug => !/^(?:term-test-[1-9]\d*|mini-test-[a-z0-9-]+)$/u.test(slug)))) {
      throw new Error('TEST_RESULT_INPUT_INVALID');
    }
    if (testSlugs?.length===0) return [];
    const result = await pool.query(resultSql, [classId, studentRef, testSlugs]);
    if (!Array.isArray(result.rows) || result.rows.length > (testSlugs?.length??100)) {
      throw new Error('TEST_RESULT_RESPONSE_INVALID');
    }
    const allowed = new Set(testSlugs||result.rows.map(row=>row.test_slug).filter(slug=>/^(?:term-test-[1-9]\d*|mini-test-[a-z0-9-]+)$/u.test(slug)));
    return result.rows.map(row => decodeTestResult(row, allowed));
  };
  reader.readStudent=({classId,studentRef})=>reader({classId,studentRef});
  // Chỉ được gọi sau khi service đã xác minh Journey. Không trả token attempt và không tạo/chấm lại bài.
  reader.readWriting=async({classId,studentRef,testSlug,resultRef:expected})=>{
    if(!/^\d{1,19}$/u.test(String(classId))||!isUuid(studentRef)
      ||!/^term-test-[1-9]\d*$/u.test(testSlug)||!/^[0-9a-f]{64}$/u.test(expected||''))throw Error('TEST_RESULT_INPUT_INVALID');
    const query=identitySql+`, selected AS (
      SELECT attempt.* FROM unique_identity AS identity
      JOIN assessment.term_test_attempt AS attempt ON attempt.test_slug=identity.test_slug
        AND attempt.erp_course_class_id=$1::bigint AND attempt.erp_student_contact_id=identity.erp_student_contact_id
      WHERE attempt.completed_at IS NOT NULL AND attempt.writing_submitted_at IS NOT NULL
        AND to_jsonb(attempt)->>'superseded_at' IS NULL
      ORDER BY attempt.completed_at DESC,attempt.id DESC LIMIT 1
    ) SELECT selected.id::text AS attempt_id,selected.test_slug,selected.completed_at,
      run.task_number,run.task_score,run.word_count,run.prompt_text,run.prompt_image_url,run.essay_text,run.result_json
      FROM selected JOIN assessment.term_test_writing_grading_final AS final
        ON final.attempt_id=selected.id AND final.status='ready'
      JOIN assessment.term_test_writing_grading_run AS run ON run.attempt_id=selected.id
        AND run.id=CASE WHEN run.task_number=1 THEN final.task_1_run_id ELSE final.task_2_run_id END
        AND run.status='complete' ORDER BY run.task_number;`;
    const response=await pool.query(query,[String(classId),studentRef,[testSlug]]);
    if(!response.rows.length)return null;
    if(response.rows.length>2||response.rows.some(row=>resultRef(row.attempt_id)!==expected||row.test_slug!==testSlug))return null;
    const seen=new Set();
    const tasks=response.rows.map(row=>{
      const taskNumber=Number(row.task_number),score=Number(row.task_score),raw=row.result_json;
      if(![1,2].includes(taskNumber)||seen.has(taskNumber)||row.task_score==null||!Number.isFinite(score)||score<0||score>9
        ||!raw||typeof raw!=='object')throw Error('TEST_RESULT_ROW_INVALID');seen.add(taskNumber);
      const text=(value,max=180000)=>typeof value==='string'?value.slice(0,max):'';
      const image=text(row.prompt_image_url,900000);
      return {taskNumber,score,wordCount:Number(row.word_count)||0,prompt:text(row.prompt_text),essay:text(row.essay_text),
        imageUrl:/^(?:data:image\/(?:png|jpeg|webp);base64,|https:\/\/)/u.test(image)?image:null,
        gradingMethod:raw.gradingMethod==='blank_rule'?'blank_rule':'rubric',report:text(raw.report),
        criteria:(Array.isArray(raw.criteria)?raw.criteria:[]).slice(0,4).map(item=>({code:text(item.code,20),name:text(item.name,200),
          bandScore:typeof item.bandScore==='number'&&item.bandScore>=0&&item.bandScore<=9?item.bandScore:null,feedback:text(item.feedback),
          components:(Array.isArray(item.components)?item.components:[]).slice(0,30).map(component=>({
            name:text(component.name||component.label||component.title,300),summary:text(component.summary),feedback:text(component.feedback)}))}))};
    });
    return {testSlug,resultRef:expected,completedAt:new Date(response.rows[0].completed_at).toISOString(),tasks};
  };
  // Đọc toàn lớp bằng một round trip. LATERAL dùng cùng phép nối định danh của Journey cá nhân,
  // nên không nối theo tên và không mở một request DB riêng cho mỗi học viên.
  reader.readClass = async ({ classId, studentRefs, testSlugs }) => {
    if (!/^\d{1,19}$/u.test(String(classId)) || !Array.isArray(studentRefs) || studentRefs.length > 500
      || new Set(studentRefs).size !== studentRefs.length
      || studentRefs.some(ref => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(ref))
      || !Array.isArray(testSlugs) || testSlugs.length > 100
      || testSlugs.some(slug => !/^(?:term-test-[1-9]\d*|mini-test-[a-z0-9-]+)$/u.test(slug))) {
      throw new Error('TEST_RESULT_INPUT_INVALID');
    }
    if (!studentRefs.length || !testSlugs.length) return [];
    // Chỉ thay biểu thức cố định trong SQL của hệ thống; mọi dữ liệu vẫn là tham số.
    const scopedSql = resultSql.replaceAll('$2::uuid', 'requested_student.student_ref').replace(/;\s*$/u, '');
    const response = await pool.query(`SELECT requested_student.student_ref::text, result.*
      FROM unnest($2::uuid[]) AS requested_student(student_ref)
      CROSS JOIN LATERAL (${scopedSql}) AS result;`, [String(classId), studentRefs, testSlugs]);
    if (!Array.isArray(response.rows) || response.rows.length > studentRefs.length * testSlugs.length) {
      throw new Error('TEST_RESULT_RESPONSE_INVALID');
    }
    const allowed = new Set(studentRefs), seen = new Set();
    const results = [];
    for (const row of response.rows) {
      const identity = `${row.student_ref}:${row.test_slug}`;
      if (!allowed.has(row.student_ref) || seen.has(identity)) throw new Error('TEST_RESULT_ROW_INVALID');
      seen.add(identity);
      results.push({ studentRef: row.student_ref, result: decodeTestResult(row, new Set(testSlugs)) });
    }
    return results;
  };
  return reader;
}
const isUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
