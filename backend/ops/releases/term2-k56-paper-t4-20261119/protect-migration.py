"""Wrap the additive migration in a row-preservation check before commit."""
from pathlib import Path
import sys


def row_signature(schema, exclusions=None):
    exclusions = exclusions or {}
    tables = {
        'sessions': 'term_test_exam_session',
        'attempts': 'term_test_attempt',
    }
    sections = []
    for label, table in tables.items():
        payload = 'to_jsonb(t)'
        if label in exclusions:
            payload += f" - '{exclusions[label]}'"
        sections.append(f"'{label}', (SELECT jsonb_build_object('count', count(*), "
                        f"'hash', md5(coalesce(string_agg(md5(({payload})::text), '' ORDER BY id), ''))) "
                        f"FROM {schema}.{table} t)")
    return 'SELECT jsonb_build_object(' + ', '.join(sections) + ') AS fingerprint'


def guarded_sql(data, schema, phase='profiles'):
    assert schema in ('assessment', 'assessment_k56')
    assert phase in ('profiles', 'legacy-bridge')
    lines = data.strip().splitlines()
    assert lines[:2] == ['BEGIN;', "SET LOCAL lock_timeout = '5s';"] and lines[-1] == 'COMMIT;'
    body = '\n'.join(lines[2:-1]).replace('assessment.', schema + '.')
    exclusions = {'sessions': 'term2_paper_profile_id', 'attempts': 'term2_paper_private_writing'}
    if phase == 'legacy-bridge':
        exclusions = {'sessions': 'term2_paper_legacy_bridge'}
    extra_check = f"""OR NOT EXISTS (SELECT FROM pg_constraint WHERE convalidated
      AND conrelid='{schema}.term_test_exam_session'::regclass
      AND conname='term2_paper_legacy_bridge_scope')""" if phase == 'legacy-bridge' else ''
    return f"""
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE {schema}.term_test_exam_session, {schema}.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;
CREATE TEMP TABLE term2_paper_before ON COMMIT DROP AS {row_signature(schema)};
{body}
CREATE TEMP TABLE term2_paper_after ON COMMIT DROP AS {row_signature(schema, exclusions)};
DO $preserve$
BEGIN
  IF (SELECT fingerprint FROM term2_paper_before) IS DISTINCT FROM (SELECT fingerprint FROM term2_paper_after)
    OR NOT EXISTS (SELECT FROM pg_constraint WHERE convalidated
      AND conrelid='{schema}.term_test_attempt'::regclass
      AND conname='term_test_attempt_writing_order_check')
    OR NOT EXISTS (SELECT FROM pg_constraint WHERE convalidated
      AND conrelid='{schema}.term_test_exam_session'::regclass
      AND conname='term2_paper_profile_scope')
    OR NOT EXISTS (SELECT FROM pg_index WHERE indisvalid AND indisunique
      AND indexrelid='{schema}.uq_term2_k56_active_paper_profile'::regclass)
    {extra_check}
  THEN RAISE EXCEPTION 'TERM2_PAPER_MIGRATION_CHECK_FAILED'; END IF;
END
$preserve$;
SELECT jsonb_build_object('rowsUnchanged', true, 'tables', fingerprint) FROM term2_paper_after;
COMMIT;
"""


if __name__ == '__main__':
    source, target_schema, *phase = sys.argv[1:]
    print(guarded_sql(Path(source).read_text(encoding='utf-8'), target_schema, *phase))
