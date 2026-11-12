import {createHash} from 'node:crypto';
import {z} from 'zod';
import {teacherCanReadClass} from './sql.js';

const schema = z.object({
  testSlug: z.enum(['term-test-1','term-test-2']).default('term-test-2'),
  classCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  studentRef: z.uuid(),
  generation: z.number().int().nonnegative(),
  operationId: z.uuid()
}).strict();

// Quyền tài khoản và lớp được đọc lại cùng hàng payload, kể cả khi phiên GV còn hiệu lực.
const lookup = `
  SELECT held.session_id, held.payload_hash, held.held_at, held.expires_at, held.payload
  FROM assessment.term_k67_writing_submission_hold held
  JOIN assessment.term_test_exam_session s ON s.id=held.session_id
  JOIN assessment.term_k67_cbt_journey j ON j.session_id=s.id AND j.generation=held.generation
  WHERE s.test_slug=$7 AND upper(trim(s.class_name_snapshot))=$1
    AND j.student_ref=$2::uuid AND held.generation=$3 AND held.operation_id=$4::uuid
    AND held.payload IS NOT NULL AND held.expires_at>statement_timestamp()
    AND ${teacherCanReadClass('$5','$6','s.erp_course_class_id')}
    AND EXISTS (
      SELECT 1 FROM mapping.reviewer_account AS exporter
      WHERE exporter.email=$5 AND exporter.role='admin'
    )
  LIMIT 2`;

const heldPayload = z.object({
  section:z.literal('writing'),
  previousOperationId:z.uuid().nullable(),
  startedAt:z.number().int().nonnegative(),
  capturedAt:z.number().int().nonnegative(),
  revision:z.number().int().nonnegative(),
  automatic:z.boolean(),
  answers:z.object({task1:z.string(),task2:z.string()})
});

const lrScope = schema.extend({
  testSlug:z.enum(['term-test-1','term-test-2','mini-test-lesson-5']),
  section:z.enum(['listening','reading']),
  delivery:z.enum(['cbt','paper'])
});

const lrAnswers = z.record(z.string().regex(/^\d{1,2}$/),z.string().max(120));
const lrIdentity = z.object({
  generation:lrScope.shape.generation,operationId:lrScope.shape.operationId,section:lrScope.shape.section
});
const lrJourneyPayload = lrIdentity.extend({
  previousOperationId:z.uuid().nullable(),
  startedAt:z.number().int().nonnegative(),
  capturedAt:z.number().int().nonnegative(),
  revision:z.number().int().nonnegative(),
  automatic:z.boolean(),
  eofAt:z.number().int().nonnegative().nullable(),
  heardSeconds:z.number().min(0).max(7200),
  answers:lrAnswers
});
const lrMiniPaperPayload = lrIdentity.extend({
  kind:z.literal('seal'),
  revision:z.number().int().nonnegative(),
  dependency:z.uuid().nullable(),
  occurredAt:z.iso.datetime(),
  payload:z.object({
    startedAt:z.iso.datetime(),
    deadlineAt:z.null(),
    timeValid:z.boolean(),
    reason:z.literal('manual').optional(),
    audioEnded:z.literal(false).optional(),
    heardSeconds:z.literal(0).optional(),
    answers:lrAnswers
  })
});

function lrHoldQuery(testSlug, delivery) {
  const mini = testSlug === 'mini-test-lesson-5';
  const miniPaper = mini && delivery === 'paper';
  const table = miniPaper ? 'mini_k67_paper_offline_run' : mini ? 'mini_k67_cbt_journey' : 'term_k67_cbt_journey';
  const deliveryGuard = miniPaper ? '' : "AND (j.audio_hash='paper')=($7='paper')";
  return `
    SELECT held.session_id,held.payload_hash,held.held_at,held.expires_at,held.payload,held.review_only
    FROM assessment.term_k67_lr_submission_hold held
    JOIN assessment.term_test_exam_session s ON s.id=held.session_id
    JOIN assessment.${table} j ON j.session_id=s.id AND j.generation=held.generation
    WHERE s.test_slug=$1 AND upper(trim(s.class_name_snapshot))=$2
      AND j.student_ref=$3::uuid AND held.generation=$4 AND held.operation_id=$5::uuid
      AND held.section=$6 AND held.delivery=$7 ${deliveryGuard}
      AND held.payload IS NOT NULL AND held.expires_at>statement_timestamp()
      AND ${teacherCanReadClass('$8','$9','s.erp_course_class_id')}
      AND EXISTS (SELECT 1 FROM mapping.reviewer_account exporter WHERE exporter.email=$8 AND exporter.role='admin')
    LIMIT 2`;
}

function readLrPayload(raw, scope) {
  const miniPaper = scope.testSlug === 'mini-test-lesson-5' && scope.delivery === 'paper';
  const parsed = (miniPaper ? lrMiniPaperPayload : lrJourneyPayload).safeParse(raw);
  if (!parsed.success) return null;
  const {generation,operationId,section,...value} = parsed.data;
  if (generation !== scope.generation || operationId !== scope.operationId || section !== scope.section) return null;
  if (!miniPaper) return value;
  const {kind,payload,...timing} = value;
  return {...timing,...payload};
}

export function mountTeacherSubmissionHoldExport(app,{pool,authenticate,requireContext,limiter,auth,reviewersByTest,logEvent}) {
  if (!Object.values(reviewersByTest).some(reviewers=>reviewers?.size)) return;
  app.post('/api/term-tests/teacher/submission-hold/export',limiter,authenticate,requireContext,async(req,res,next)=>{
    res.set('Cache-Control','private, no-store');
    const authorization=auth.readAuthorization(req);
    const email=req.reviewer.email;
    if (!Object.values(reviewersByTest).some(reviewers=>reviewers?.has(email))||!['session','google_bearer'].includes(authorization.source)) {
      return res.status(403).json({ok:false,error:'HOLD_EXPORT_DENIED'});
    }
    const parsed=schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ok:false,error:'INVALID_HOLD_SCOPE'});
    const {testSlug,classCode,studentRef,generation,operationId}=parsed.data;
    if (!reviewersByTest[testSlug]?.has(email)) return res.status(403).json({ok:false,error:'HOLD_EXPORT_DENIED'});
    try {
      const {rows}=await pool.query(lookup,[classCode,studentRef,generation,operationId,email,authorization,testSlug]);
      if (rows.length!==1) return res.status(404).json({ok:false,error:'HOLD_NOT_AVAILABLE'});
      const [row]=rows;
      const saved=heldPayload.safeParse(row.payload);
      if (!saved.success||testSlug==='term-test-1'&&saved.data.answers.task1!=='') {
        return res.status(503).json({ok:false,error:'HOLD_PAYLOAD_UNAVAILABLE'});
      }
      logEvent('submission_hold_exported',testSlug,row.session_id,{
        section:'writing',operationId,generation,actorFingerprint:createHash('sha256').update(email).digest('hex')
      });
      const name=testSlug==='term-test-1'?'term1':'term2';
      res.set('Content-Disposition',`attachment; filename="${name}-writing-${operationId}.json"`);
      return res.json({version:1,testSlug,classCode,studentRef,generation,operationId,state:'held',
        payloadHash:row.payload_hash,heldAt:row.held_at,expiresAt:row.expires_at,...saved.data});
    } catch(error) { return next(error); }
  });
}

export function mountTeacherLrSubmissionHoldExport(app,{pool,authenticate,requireContext,limiter,auth,reviewers,logEvent}) {
  if (!reviewers?.size) return;
  app.post('/api/term-tests/teacher/lr-submission-hold/export',limiter,authenticate,requireContext,async(req,res,next)=>{
    res.set('Cache-Control','private, no-store');
    const authorization = auth.readAuthorization(req);
    const email = req.reviewer.email;
    if (!reviewers.has(email) || !['session','google_bearer'].includes(authorization.source)) {
      return res.status(403).json({ok:false,error:'HOLD_EXPORT_DENIED'});
    }
    const parsed = lrScope.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ok:false,error:'INVALID_HOLD_SCOPE'});
    const scope = parsed.data;
    const {testSlug,classCode,studentRef,generation,operationId,section,delivery} = scope;
    try {
      const {rows} = await pool.query(lrHoldQuery(testSlug,delivery),
        [testSlug,classCode,studentRef,generation,operationId,section,delivery,email,authorization]);
      if (rows.length!==1) return res.status(404).json({ok:false,error:'HOLD_NOT_AVAILABLE'});
      const [row] = rows;
      const saved = readLrPayload(row.payload,scope);
      if (!saved) return res.status(503).json({ok:false,error:'HOLD_PAYLOAD_UNAVAILABLE'});
      logEvent('submission_hold_exported',testSlug,row.session_id,{
        section,delivery,operationId,generation,actorFingerprint:createHash('sha256').update(email).digest('hex')
      });
      res.set('Content-Disposition',`attachment; filename="${testSlug}-${delivery}-${section}-${operationId}.json"`);
      return res.json({version:1,...scope,state:'held',reviewOnly:row.review_only,payloadHash:row.payload_hash,
        heldAt:row.held_at,expiresAt:row.expires_at,...saved});
    } catch(error) { return next(error); }
  });
}
