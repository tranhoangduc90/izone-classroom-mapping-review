"""Correct the existing Term2 guard without altering payloads or receipts."""
from pathlib import Path
root=Path(__file__).resolve().parent
source=(root.parent/'term2-k56-parallel-entry-20261117/parallel-attempts.sql').read_text(encoding='utf-8')
start=source.index('CREATE FUNCTION assessment.guard_term2_k56_official_submission()')
end=source.index('$$;',start)+len('$$;')
function=source[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
function=function.replace('          AND NEW.listening_interrupted_at IS NULL','')
function=function.replace(' OR OLD.listening_interrupted_at IS NOT NULL','')
function=function.replace(' OR accepted.listening_interrupted_at IS NOT NULL','')
function=function.replace("        OR (OLD.listening_interrupted_at IS NULL AND NEW.listening_interrupted_at IS NOT NULL)\n",'')
text="""BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '5s';
LOCK TABLE ONLY assessment.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;

-- An interruption-only row keeps all history and receipts. It is not a valid
-- first submission and must not occupy the unique official-result slot.
"""+function+"""

UPDATE assessment.term_test_attempt SET term2_official_submission=false
WHERE test_slug='term-test-2-k56' AND attempt_mode='cbt' AND superseded_at IS NULL
  AND term2_official_submission AND listening_submitted_at IS NULL
  AND reading_submitted_at IS NULL AND writing_submitted_at IS NULL;
COMMIT;
"""
(root/'term2-valid-submission-only.sql').write_text(text,encoding='utf-8',newline='\n')
print('Prepared Term2 interruption-only marker correction; content and receipts unchanged')
