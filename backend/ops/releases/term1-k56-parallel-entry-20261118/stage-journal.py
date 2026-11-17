"""Keep K56 grading linked to the receipt of the actual submitting profile."""
from pathlib import Path
from hashlib import sha256
import shutil,sys

captured,target=map(Path,sys.argv[1:])
source=(captured/'adapters/term-k56-offline.mjs').read_bytes()
assert sha256(source).hexdigest()=='a301a6ab27093afbe15223fe73c5a3ff172780ce356d043f365b6b08c1193905'
text=source.decode('utf-8')
anchor='  try {\n    const { rows: [receipt] } = await query(`SELECT op.operation_id::text AS submission_operation_id,'
assert text.count(anchor)==1
branch='''  if (profile.prefix !== 'mini_k56') {
    try {
      const { rows: [receipt] } = await query(`SELECT op.operation_id::text AS submission_operation_id,
        op.receipt->>'receiptId' AS submission_receipt_id
        FROM ${schema}.term_test_attempt official
        JOIN ${schema}.term_test_writing_grading_run grade ON grade.attempt_id=official.id
        JOIN ${schema}.${profile.prefix}_offline_operation op
          ON coalesce(op.receipt->>'officialAttemptToken',op.attempt_id::text)=official.id::text
        JOIN ${schema}.${profile.prefix}_offline_run run ON run.attempt_id=op.attempt_id
          AND op.operation_id::text=run.state->'writing'->>'operationId'
        JOIN ${schema}.term_test_attempt source_attempt ON source_attempt.id=run.attempt_id
          AND source_attempt.generation=run.generation AND source_attempt.exam_session_id=run.session_id
        JOIN ${schema}.term_test_exam_session source_session ON source_session.id=run.session_id
          AND source_session.generation=run.generation AND source_session.test_slug=source_attempt.test_slug
          AND source_session.erp_course_class_id=source_attempt.erp_course_class_id
          AND source_session.erp_student_contact_id=source_attempt.erp_student_contact_id
        WHERE official.id=$1::uuid AND grade.id=$2::uuid AND grade.task_number=$3
          AND official.test_slug=$4 AND official.superseded_at IS NULL
          AND source_attempt.test_slug=official.test_slug AND source_attempt.definition_version=official.definition_version
          AND source_attempt.generation=official.generation AND source_attempt.attempt_mode=official.attempt_mode
          AND source_attempt.erp_course_class_id=official.erp_course_class_id
          AND source_attempt.erp_student_contact_id=official.erp_student_contact_id
          AND source_attempt.superseded_at IS NULL AND source_session.superseded_at IS NULL
          AND op.section='writing' AND op.kind='seal' AND op.receipt->>'status'='accepted'
          AND op.receipt->>'kind'='seal' AND op.receipt->>'section'='writing'
          AND op.receipt->>'operationId'=op.operation_id::text
          AND op.receipt->>'attemptToken'=source_attempt.id::text
          AND op.receipt->>'examSessionToken'=source_session.id::text
          AND op.receipt->>'generation'=source_session.generation::text
          AND op.payload->'payload'->>($5::text)=grade.essay_text
          AND op.committed_at<=grade.created_at
        ORDER BY op.committed_at,op.operation_id LIMIT 1`,
        [owner.token,owner.run_id,profile.task,owner.test_slug,'task'+profile.task]);
      return UUID.test(receipt?.submission_receipt_id||'') ? receipt : {};
    } catch {
      // Keep the existing behavior on deployments missing the native tables.
      return {};
    }
  }
'''
text=text.replace(anchor,branch+anchor,1)
(target/'adapters').mkdir(parents=True,exist_ok=True)
(target/'src').mkdir(exist_ok=True)
(target/'adapters/term-k56-offline.mjs').write_text(text,encoding='utf-8',newline='\n')
shutil.copyfile(captured/'src/contract.mjs',target/'src/contract.mjs')
print('Staged K56 Term1/2 source receipt linking; Mini and online-hold branches unchanged')
