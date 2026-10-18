// Kiểm hợp đồng HTTP/định danh qua handler công khai; không cấp sẵn session hoặc gọi production.
// SQL sẽ còn phải kiểm với PostgreSQL và quyền thật, các ca này không thay bằng chứng đó.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStudentIdentityRequest, resolvedStudentIdentity, createStudentIdentityHandler,
  normalizeContactIdentity } from '../src/student-identity.js';

const refA = '11111111-1111-4111-8111-111111111111';
const refB = '22222222-2222-4222-8222-222222222222';
const alice = { authority: 'erp-contact', id: '12345' };
const row = { person_id: '12345', student_ref: refA, class_id: '111', class_code: 'LOPTHU', student_name: 'Học viên thử' };
const request = (extra = {}) => parseStudentIdentityRequest({ identity: alice, ...extra });
function response() {
  return { code: 200, headers: {}, body: null,
    status(value) { this.code = value; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = value; return this; } };
}

test('Cùng người có nhiều UUID theo lớp vẫn trả một danh tính và giữ đủ lớp để caller chọn ngữ cảnh', () => {
  const result = resolvedStudentIdentity([row, { ...row, student_ref: refB, class_id: '222', class_code: 'LOPKHAC' }], request());
  assert.equal(result.status, 'unique');
  assert.deepEqual(result.identity, alice);
  assert.deepEqual(result.aliases.map(item => item.studentRef), [refA, refB]);
  assert.deepEqual(result.aliases.map(item => item.classCode), ['LOPTHU', 'LOPKHAC']);
});

test('UUID từ sản phẩm đầu tiên đổi về đúng mã ERP, không dựa vào tên', () => {
  const input = parseStudentIdentityRequest({ studentRef: refA, classCode: ' lopthu ' });
  assert.equal(input.classCode, 'LOPTHU');
  assert.deepEqual(resolvedStudentIdentity([row], input).identity, alice);
});

test('Hai người cùng khớp một UUID trả ambiguous, không lấy dòng đầu', () => {
  const input = parseStudentIdentityRequest({ studentRef: refA });
  const result = resolvedStudentIdentity([row, { ...row, person_id: '67890', class_id: '222' }], input);
  assert.deepEqual(result, { status: 'ambiguous', identity: null, aliases: [] });
});

test('Không tìm thấy giữ trạng thái missing riêng với lỗi nguồn', () => {
  assert.deepEqual(resolvedStudentIdentity([], request()), { status: 'missing', identity: null, aliases: [] });
  assert.throws(() => resolvedStudentIdentity(null, request()), /IDENTITY_SOURCE_INVALID/);
});

test('Không gộp bigint lớn, không nhận mã tạm hoặc mã số theo nguồn khác', () => {
  assert.deepEqual(normalizeContactIdentity({ authority: 'erp-contact', id: '9007199254740993' }),
    { authority: 'erp-contact', id: '9007199254740993' });
  for (const id of ['0', '-1', '0001', '9223372036854775808', 12345])
    assert.equal(normalizeContactIdentity({ authority: 'erp-contact', id }), null);
  assert.equal(normalizeContactIdentity({ authority: 'class-roster', id: '12345' }), null);
});

test('Request phải có đúng một loại mã, không nhận trường quyền hoặc mã phiên tự gửi', () => {
  for (const value of [null, [], {}, { identity: alice, studentRef: refA }, { identity: alice, accessToken: 'forged' },
    { studentRef: '12345' }, { identity: alice, classCode: 123 }, { identity: alice, classCode: '<bad>' }])
    assert.equal(parseStudentIdentityRequest(value), null);
});

test('Nguồn trả sai người, sai lớp hoặc sai ref phải bị chặn', () => {
  assert.throws(() => resolvedStudentIdentity([{ ...row, person_id: '67890' }], request()), /IDENTITY_SOURCE_MISMATCH/);
  assert.throws(() => resolvedStudentIdentity([row], request({ classCode: 'LOPKHAC' })), /IDENTITY_SOURCE_MISMATCH/);
  assert.throws(() => resolvedStudentIdentity([row], parseStudentIdentityRequest({ studentRef: refB })), /IDENTITY_SOURCE_MISMATCH/);
});

test('Một dòng nguồn lỗi không bị bỏ qua để nhận các dòng còn lại là hợp lệ', () => {
  assert.throws(() => resolvedStudentIdentity([row, { ...row, person_id: '-5' }], request()), /IDENTITY_SOURCE_INVALID/);
  assert.throws(() => resolvedStudentIdentity([{ ...row, class_id: '-5' }], request()), /IDENTITY_SOURCE_INVALID/);
});

test('Handler chỉ trả danh tính và aliases, không trả token Google hoặc token bài làm', async () => {
  let calls = 0;
  const handler = createStudentIdentityHandler({ resolve: async () => {
    calls++; return [{ ...row, access_token: 'not-returned', google_user_id: 'not-returned' }];
  } });
  const res = response();
  await handler({ body: { identity: alice } }, res, error => { throw error; });
  assert.equal(calls, 1);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(Object.keys(res.body).sort(), ['aliases', 'identity', 'ok', 'status']);
  assert.deepEqual(Object.keys(res.body.aliases[0]).sort(), ['classCode', 'classId', 'studentName', 'studentRef']);
});

test('Input sai không chạm nguồn; lỗi nguồn không biến thành đăng nhập thành công', async () => {
  let calls = 0, passedError;
  const sourceError = new Error('database unavailable');
  const handler = createStudentIdentityHandler({ resolve: async () => { calls++; throw sourceError; } });
  const bad = response();
  await handler({ body: { identity: alice, studentRef: refA } }, bad, () => assert.fail('unexpected next'));
  assert.equal(bad.code, 400); assert.equal(calls, 0);
  const failed = response();
  await handler({ body: { identity: alice } }, failed, error => { passedError = error; });
  assert.equal(passedError, sourceError); assert.equal(failed.body, null);
});

test('Sai danh tính trong nguồn trả HTTP 503, không tự chuyển sang người khác', async () => {
  const handler = createStudentIdentityHandler({ resolve: async () => [{ ...row, person_id: '67890' }] });
  const res = response();
  await handler({ body: { identity: alice } }, res, () => assert.fail('must handle mismatch'));
  assert.equal(res.code, 503); assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'IDENTITY_SOURCE_MISMATCH');
});
