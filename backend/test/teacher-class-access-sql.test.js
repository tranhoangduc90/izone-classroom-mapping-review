import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTeacherClassAccessPredicate } from '../src/teacher-class-access-sql.js';

test('predicate chỉ nhận placeholder và tham chiếu cột an toàn', () => {
  const predicate = buildTeacherClassAccessPredicate({
    reviewerEmailSql: '$3',
    classIdSql: 'assignment.erp_course_class_id'
  });
  assert.match(predicate, /reviewer_class_access/);
  assert.match(predicate, /reviewer_class_assignment/);
  assert.match(predicate, /classroom_course_mapping/);
  assert.match(predicate, /effective_access\.reviewer_email = \$3/);

  assert.throws(() => buildTeacherClassAccessPredicate({
    reviewerEmailSql: '$1; DROP TABLE mapping.reviewer_account',
    classIdSql: 'course.erp_course_class_id'
  }), /tham chiếu cột SQL an toàn/);
  assert.throws(() => buildTeacherClassAccessPredicate({
    reviewerEmailSql: '$1',
    classIdSql: 'course.erp_course_class_id OR true'
  }), /tham chiếu cột SQL an toàn/);
});
