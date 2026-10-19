// Dữ liệu vào: pool PostgreSQL và schema bài thi đã chọn từ profile triển khai.
// Việc chính: định tuyến mọi SQL bài thi K56 sang schema riêng trong cùng database mapping.
// Kết quả: K67 dùng nguyên pool cũ; K56 chỉ chạm bảng bài thi K56, kể cả trong transaction.
// Khi lỗi: kiểu truy vấn lạ bị từ chối trước khi chạm database để tránh ghi nhầm schema.
const K56_ASSESSMENT_SCHEMA = 'assessment_k56';

export function scopeAssessmentQuery(input) {
  if (typeof input === 'string') {
    return input.replace(/\bassessment\./g, `${K56_ASSESSMENT_SCHEMA}.`);
  }
  if (input && typeof input === 'object' && typeof input.text === 'string') {
    return { ...input, text: scopeAssessmentQuery(input.text) };
  }
  throw new TypeError('K56 chỉ nhận truy vấn PostgreSQL dạng text hoặc query config có text.');
}

function scopedClient(client) {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query') {
        return (input, ...args) => target.query(scopeAssessmentQuery(input), ...args);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export function createAssessmentSchemaPool(pool, profile) {
  if (profile.family !== 'k56') return pool;
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query') {
        return (input, ...args) => target.query(scopeAssessmentQuery(input), ...args);
      }
      if (property === 'connect') {
        return typeof target.connect === 'function'
          ? async (...args) => scopedClient(await target.connect(...args))
          : undefined;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
