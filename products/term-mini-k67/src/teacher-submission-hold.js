import {createHash} from 'node:crypto';
import {z} from 'zod';
import {teacherCanReadClass} from './sql.js';

const testSlug = 'term-test-2';
const schema = z.object({
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
  WHERE s.test_slug='term-test-2' AND upper(trim(s.class_name_snapshot))=$1
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

export function mountTeacherSubmissionHoldExport(app,{pool,authenticate,requireContext,limiter,auth,reviewers,logEvent}) {
  if (!reviewers?.size) return;
  app.post('/api/term-tests/teacher/submission-hold/export',limiter,authenticate,requireContext,async(req,res,next)=>{
    res.set('Cache-Control','private, no-store');
    const authorization=auth.readAuthorization(req);
    const email=req.reviewer.email;
    if (!reviewers.has(email)||!['session','google_bearer'].includes(authorization.source)) {
      return res.status(403).json({ok:false,error:'HOLD_EXPORT_DENIED'});
    }
    const parsed=schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ok:false,error:'INVALID_HOLD_SCOPE'});
    const {classCode,studentRef,generation,operationId}=parsed.data;
    try {
      const {rows}=await pool.query(lookup,[classCode,studentRef,generation,operationId,email,authorization]);
      if (rows.length!==1) return res.status(404).json({ok:false,error:'HOLD_NOT_AVAILABLE'});
      const [row]=rows;
      const saved=heldPayload.safeParse(row.payload);
      if (!saved.success) return res.status(503).json({ok:false,error:'HOLD_PAYLOAD_UNAVAILABLE'});
      logEvent('submission_hold_exported',testSlug,row.session_id,{
        section:'writing',operationId,generation,actorFingerprint:createHash('sha256').update(email).digest('hex')
      });
      res.set('Content-Disposition',`attachment; filename="term2-writing-${operationId}.json"`);
      return res.json({version:1,testSlug,classCode,studentRef,generation,operationId,state:'held',
        payloadHash:row.payload_hash,heldAt:row.held_at,expiresAt:row.expires_at,...saved.data});
    } catch(error) { return next(error); }
  });
}
