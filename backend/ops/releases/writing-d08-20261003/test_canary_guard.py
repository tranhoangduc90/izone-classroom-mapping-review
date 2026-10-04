"""Nhận ledger giả; kiểm chặn sai UUID/đích/ERP và điều kiện cleanup.
Không SSH/Docker/SQL production; assertion giữ fail nếu guard nới lỏng.
"""
import copy
import unittest
import uuid
import canary_remote as c


def fixture():
    run = uuid.uuid4().hex
    return {'run_id': run, 'manifest': {'targets': [{'name': name} for name in c.NAMES]},
            'identities': [{'name': name, 'attempt_id': str(uuid.uuid4()),
                            'marker': 'CODEX_D08_' + run + '_' + str(index),
                            'course_id': -2000000 - index * 2,
                            'student_id': -2000001 - index * 2} for index, name in enumerate(c.NAMES)]}


class CanaryGuards(unittest.TestCase):
    def test_valid_owned_ledger(self):
        value = fixture()
        self.assertEqual(c.validate(value), value['identities'])

    def test_reject_invalid_uuid_or_duplicate(self):
        for duplicate in (False, True):
            value = fixture()
            value['identities'][1]['attempt_id'] = value['identities'][0]['attempt_id'] if duplicate else "1'; DELETE FROM x"
            with self.assertRaises((RuntimeError, ValueError)):
                c.validate(value)

    def test_reject_any_target_change(self):
        for field in ('identities', 'manifest'):
            value = fixture()
            rows = value[field] if field == 'identities' else value[field]['targets']
            rows[0]['name'] = 'another-api'
            with self.assertRaises(RuntimeError):
                c.validate(value)

    def test_reject_foreign_marker_or_sql(self):
        for marker in ('CODEX_D08_' + uuid.uuid4().hex + '_0', "'; DELETE FROM x"):
            value = fixture()
            value['identities'][0]['marker'] = marker
            with self.assertRaises(RuntimeError):
                c.validate(value)

    def test_reject_positive_bool_duplicate_erp_ids(self):
        for identifier in (1, True, -1, -3000000000, -2000001):
            value = fixture()
            value['identities'][0]['course_id'] = identifier
            with self.assertRaises(RuntimeError):
                c.validate(value)

    def test_exact_destination_and_cleanup(self):
        value = fixture()
        c.validate(value)
        for index, item in enumerate(value['identities']):
            schema, _, database = c.destination(item)
            sql = c.cleanup_sql(item)
            self.assertIn('BEGIN READ ONLY;', sql)
            self.assertIn('FOR UPDATE', sql)
            self.assertIn("current_database()<>'" + database + "'", sql)
            self.assertIn('DELETE FROM ' + schema + '.term_test_attempt WHERE id=', sql)
            self.assertIn('writing_submitted_at IS NULL AND exam_session_id IS NULL', sql)
            self.assertIn('erp_student_contact_id=' + str(item['student_id']), sql)
            self.assertIn('erp_course_class_id=' + str(item['course_id']), sql)
            self.assertEqual(sql.count('SELECT count(*) FROM ' + schema + '.term_test_'), 13)
            for table in c.CHILDREN:
                self.assertIn(schema + '.' + table + " WHERE attempt_id='" + item['attempt_id'], sql)


if __name__ == '__main__':
    unittest.main()
