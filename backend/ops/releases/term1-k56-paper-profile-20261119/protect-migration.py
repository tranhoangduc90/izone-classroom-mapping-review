"""Protect the live K56 table rows while installing Term 1 paper profile support."""
from pathlib import Path
import sys


def guarded_sql(data, schema):
    assert schema in ('assessment', 'assessment_k56')
    lines = data.strip().splitlines()
    assert lines[:2] == ['BEGIN;', "SET LOCAL lock_timeout = '5s';"] and lines[-1] == 'COMMIT;'
    body = '\n'.join(lines[2:-1]).replace('assessment.', schema + '.')
    tables = (
        ('sessions', 'term_test_exam_session', ('term1_paper_profile_id', 'term1_paper_legacy_bridge')),
        ('attempts', 'term_test_attempt', ('term1_paper_private_writing',)),
    )

    def signature(remove_new_columns):
        sections = []
        for name, table, columns in tables:
            payload = 'to_jsonb(t)'
            if remove_new_columns:
                payload += ''.join(f" - '{column}'" for column in columns)
            sections.append(f"'{name}', (SELECT jsonb_build_object('count', count(*), "
                            f"'hash', md5(coalesce(string_agg(md5(({payload})::text), '' ORDER BY id), ''))) "
                            f"FROM {schema}.{table} t)")
        return 'SELECT jsonb_build_object(' + ', '.join(sections) + ') AS fingerprint'

    return f"""
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE {schema}.term_test_exam_session, {schema}.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;
CREATE TEMP TABLE term1_paper_before ON COMMIT DROP AS {signature(False)};
{body}
CREATE TEMP TABLE term1_paper_after ON COMMIT DROP AS {signature(True)};
DO $preserve$
BEGIN
  IF (SELECT fingerprint FROM term1_paper_before) IS DISTINCT FROM (SELECT fingerprint FROM term1_paper_after)
    OR NOT EXISTS (SELECT FROM pg_constraint WHERE convalidated
      AND conrelid='{schema}.term_test_attempt'::regclass
      AND conname='term_test_attempt_writing_order_check')
    OR 2 <> (SELECT count(*) FROM pg_constraint WHERE convalidated
      AND conrelid='{schema}.term_test_exam_session'::regclass
      AND conname IN ('term1_paper_profile_scope', 'term1_paper_legacy_bridge_scope'))
    OR NOT EXISTS (SELECT FROM pg_index WHERE indisvalid AND indisunique
      AND indexrelid='{schema}.uq_term1_k56_active_paper_profile'::regclass)
  THEN RAISE EXCEPTION 'TERM1_PAPER_MIGRATION_CHECK_FAILED'; END IF;
END
$preserve$;
SELECT jsonb_build_object('rowsUnchanged', true, 'tables', fingerprint) FROM term1_paper_after;
COMMIT;
"""


if __name__ == '__main__':
    source, schema = sys.argv[1:]
    print(guarded_sql(Path(source).read_text(encoding='utf-8'), schema))
