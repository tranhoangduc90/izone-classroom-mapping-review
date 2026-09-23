import { createHash } from 'node:crypto';

const text = (name) => ({ name, type: 1 });
const number = (name, formatter = '0') => ({
  name,
  type: 2,
  property: { formatter },
});
const date = (name) => ({
  name,
  type: 5,
  property: { date_formatter: 'yyyy/MM/dd HH:mm' },
});
const checkbox = (name) => ({ name, type: 7 });

export const COMMON_FIELDS = [
  text('Trạng thái nguồn'),
  date('Cập nhật tại PostgreSQL'),
  text('Mã kiểm tra nguồn'),
  date('Đồng bộ lên Lark lúc'),
];

export const DATASETS = [
  {
    key: 'classes',
    tableName: 'Bản sao dữ liệu - Lớp',
    viewName: 'mapping.lark_export_classes',
    fields: [
      text('ERP Class ID'),
      text('Classroom Course ID'),
      text('Tên lớp ERP'),
      text('Tên lớp Classroom'),
      text('Section Classroom'),
      text('Trạng thái mapping'),
      checkbox('Trong danh sách vận hành'),
      checkbox('Nguồn ERP còn hoạt động'),
      checkbox('Nguồn Classroom còn hoạt động'),
    ],
  },
  {
    key: 'students',
    tableName: 'Bản sao dữ liệu - Học viên',
    viewName: 'mapping.lark_export_students',
    fields: [
      text('ERP Student ID'),
      text('Tên ERP'),
      text('Email ERP'),
      text('Google User ID'),
      text('Tên Google'),
      text('Email Google'),
      text('Trạng thái mapping'),
      text('Cách ghép'),
      text('Người duyệt'),
      date('Duyệt lúc'),
    ],
  },
  {
    key: 'memberships',
    tableName: 'Bản sao dữ liệu - Thành viên lớp',
    viewName: 'mapping.lark_export_memberships',
    driftIgnoredFields: ['Thấy gần nhất'],
    fields: [
      text('ERP Class ID'),
      text('Tên lớp'),
      text('ERP Student ID'),
      text('Tên học viên'),
      text('Email ERP'),
      text('Google User ID'),
      text('Trạng thái đăng ký'),
      text('Trạng thái thành viên'),
      date('Vào nguồn lần đầu'),
      date('Thấy gần nhất'),
      date('Rời nguồn lúc'),
    ],
  },
  {
    key: 'reviews',
    tableName: 'Bản sao dữ liệu - Mapping và duyệt',
    viewName: 'mapping.lark_export_reviews',
    fields: [
      text('Mã phiếu duyệt'),
      text('ERP Class ID'),
      text('ERP Student ID'),
      text('Mã học viên ERP'),
      text('Tên học viên ERP'),
      text('Email ERP'),
      text('Classroom Course ID'),
      text('Google User ID ứng viên'),
      text('Tên Google ứng viên'),
      text('Email Google ứng viên'),
      number('Điểm AI', '0.0000'),
      text('Lý do AI'),
      text('Cách ghép'),
      text('Trạng thái duyệt'),
      text('Người duyệt'),
      text('Ghi chú duyệt'),
      date('Quyết định lúc'),
    ],
  },
  {
    key: 'teacher_assignments',
    tableName: 'Bản sao dữ liệu - Phân công giảng viên',
    viewName: 'mapping.lark_export_teacher_assignments',
    fields: [
      text('Email tài khoản'),
      text('Tên hiển thị'),
      text('Vai trò'),
      text('Trạng thái tài khoản'),
      checkbox('Được xem mọi lớp'),
      text('ERP Class ID'),
      text('Tên lớp'),
      text('Nguồn phân quyền'),
    ],
  },
  {
    key: 'results_2026',
    tableName: 'Bản sao dữ liệu - Kết quả 2026',
    viewName: 'mapping.lark_export_results_2026',
    partitionAt: 15_000,
    fields: [
      text('Loại kết quả'),
      text('Mã bài kiểm tra'),
      text('ERP Class ID'),
      text('Tên lớp'),
      text('ERP Student ID'),
      text('Tên học viên'),
      text('Kỹ năng'),
      number('Điểm nghe', '0.0'),
      number('Điểm đọc', '0.0'),
      number('Điểm Writing', '0.0'),
      number('Điểm tổng hợp', '0.0'),
      number('Số câu đúng'),
      number('Tổng số câu'),
      text('Trạng thái kết quả'),
      date('Hoàn thành lúc'),
    ],
  },
  {
    key: 'changes_2026',
    tableName: 'Bản sao dữ liệu - Biến động 2026',
    viewName: 'mapping.lark_export_changes_2026',
    partitionAt: 15_000,
    fields: [
      text('Nhóm biến động'),
      text('Loại biến động'),
      text('ERP Class ID'),
      text('Tên lớp'),
      text('ERP Student ID'),
      text('Google User ID'),
      text('Giá trị trước'),
      text('Giá trị sau'),
      text('Người quyết định'),
      text('Ghi chú'),
      date('Phát hiện lúc'),
    ],
  },
];

export const STATUS_TABLE = {
  key: 'sync_status',
  tableName: 'Bản sao dữ liệu - Tình trạng đồng bộ',
  fields: [
    text('Bảng dữ liệu'),
    text('Trạng thái lần chạy'),
    text('Chế độ'),
    number('Số dòng nguồn'),
    number('Số dòng tạo mới'),
    number('Số dòng cập nhật'),
    number('Số dòng ngừng trong nguồn'),
    number('Số dòng bỏ qua'),
    date('Bắt đầu lúc'),
    date('Kết thúc lúc'),
    text('Mã lỗi gần nhất'),
    text('Thông báo vận hành'),
  ],
};

export function allFields(definition) {
  return [text('Khóa đồng bộ'), ...definition.fields, ...COMMON_FIELDS];
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function checksum(fields) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(fields)), 'utf8')
    .digest('hex');
}

export function normalizeSourceFields(definition, payload) {
  const allowed = new Map(definition.fields.map((field) => [field.name, field]));
  const output = {};
  for (const [name, rawValue] of Object.entries(payload ?? {})) {
    const field = allowed.get(name);
    if (!field || rawValue === null || rawValue === undefined || rawValue === '') continue;
    if (field.type === 5) {
      const timestamp = Date.parse(String(rawValue));
      if (!Number.isFinite(timestamp)) throw new Error(`INVALID_DATE_FIELD:${name}`);
      output[name] = timestamp;
    } else if (field.type === 2) {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) throw new Error(`INVALID_NUMBER_FIELD:${name}`);
      output[name] = value;
    } else if (field.type === 7) {
      output[name] = rawValue === true;
    } else {
      output[name] = String(rawValue);
    }
  }
  return output;
}

function comparableValue(field, value) {
  if (value === null || value === undefined || value === '') return null;
  if (field.type === 5) {
    if (typeof value === 'number') return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : String(value);
  }
  if (field.type === 2) return Number(value);
  if (field.type === 7) return value === true;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value);
}

export function hasFieldDrift(definition, expected, actual) {
  for (const field of definition.fields) {
    const expectedValue = comparableValue(field, expected[field.name]);
    const actualValue = comparableValue(field, actual?.[field.name]);
    if (expectedValue !== actualValue) return true;
  }
  return false;
}

export function safeErrorCode(error) {
  const raw = String(error?.code ?? error?.message ?? 'UNKNOWN_ERROR');
  const code = raw.split(':', 1)[0].replace(/[^A-Z0-9_-]/gi, '_').toUpperCase();
  return code.slice(0, 80) || 'UNKNOWN_ERROR';
}

export function partNumberFromName(baseName, name) {
  if (name === baseName) return 1;
  const match = name.match(new RegExp(`^${escapeRegExp(baseName)} - Phần ([2-9][0-9]*)$`, 'u'));
  return match ? Number(match[1]) : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
