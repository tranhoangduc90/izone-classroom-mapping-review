// Nhận bản chụp lớp thử riêng và lớp hiện hành; kiểm nguồn và các bộ nhận cùng hiểu phạm vi.
// Không kết nối production. Sai quyền lớp hoặc sai liên kết người phải bị từ chối trong test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as term from '../src/context-contract.js';
import * as reading from '../../reading-practice/src/context-contract.js';
import * as listening from '../../listening-practice/src/context-contract.js';

const trial = '990018067';
const oldClasses = ['-8062028', '1124', '1131', '1135', '1157', '1166', '1187', '1199', '1226', '1250', '1293'];
const now = Date.parse('2026-10-18T07:00:00.000Z');
function payload(classId = trial) {
  return { apiVersion: 1, productId: term.CONTEXT_PRODUCT,
    classes: [{ erp_course_class_id: classId, erp_class_name_snapshot: 'CODEXID261018' }],
    students: [{ public_id: '9c261018-0000-4000-8000-000000000001', erp_course_class_id: classId,
      erp_student_contact_id: '990018101', erp_student_name_snapshot: '[THỬ] Nhận diện A', status: 'approved' }],
    memberships: [{ erp_course_class_id: classId, erp_student_contact_id: '990018101',
      erp_student_name_snapshot: '[THỬ] Nhận diện A', source_state: 'active' }], accounts: [], access: [] };
}

for (const [name, module] of [['Term/Mini', term], ['Reading', reading], ['Listening', listening]]) {
  test(`${name}: lớp thử riêng được nhận nhưng không cấp quyền lớp khác`, () => {
    const snapshot = module.createContextSnapshot(payload(), now);
    assert.equal(module.parseContextSnapshot(snapshot, now).students[0].erp_student_contact_id, '990018101');
    assert.throws(() => module.createContextSnapshot(payload('990018068'), now), { code: 'CONTEXT_OUTSIDE_SCOPE' });
  });
  test(`${name}: giữ nguyên toàn bộ phạm vi lớp cũ`, () => {
    assert.deepEqual(module.CONTEXT_CLASS_IDS.filter(id => id !== trial), oldClasses);
    for (const id of oldClasses) assert.equal(module.createContextSnapshot(payload(id), now).classes[0].erp_course_class_id, id);
  });
}

test('Bản chụp nguồn được cả ba bên đọc; người ở ngoài lớp vẫn bị từ chối', () => {
  const snapshot = term.createContextSnapshot(payload(), now);
  for (const module of [term, reading, listening]) assert.equal(module.parseContextSnapshot(snapshot, now).classes.length, 1);
  const invalid = payload(); invalid.students[0].erp_course_class_id = '1293';
  assert.throws(() => term.createContextSnapshot(invalid, now), { code: 'CONTEXT_OUTSIDE_SCOPE' });
});
