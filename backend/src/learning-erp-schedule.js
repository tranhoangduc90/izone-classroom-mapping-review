// Dữ liệu nhận vào: mã lớp ERP và cấu hình Metabase chỉ nằm trên máy chủ.
// Việc chính: đọc danh sách dòng lịch của đúng lớp bằng một câu SELECT cố định.
// Kết quả: ID dòng ERP, ngày giờ và trạng thái thô để giảng viên xác nhận thứ tự buổi.
// Khi lỗi: ném mã lỗi chung, không ghi mật khẩu, session token hay SQL trả về vào log.
const dateTimePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

// Chỉ kiểm ngày/giờ trên lịch địa phương có tồn tại; không đổi timezone dữ liệu ERP.
function validCalendarDateTime(value) {
  if(!dateTimePattern.test(value))return false;
  const [year,month,day,hour,minute,second]=value.split(/[- :]/u).map(Number);
  if(year<1000||month<1||month>12||hour>23||minute>59||second>59)return false;
  const calendar=new Date(Date.UTC(year,month-1,day));
  return calendar.getUTCFullYear()===year&&calendar.getUTCMonth()===month-1&&calendar.getUTCDate()===day;
}

function assertScheduleRows(payload, classId) {
  const data = payload?.data;
  const columns = data?.cols?.map(column => column?.name);
  const expected = ['class_session_id', 'course_class_id', 'starts_at', 'ends_at', 'status'];
  if (!Array.isArray(columns) || JSON.stringify(columns) !== JSON.stringify(expected)
    || !Array.isArray(data.rows) || data.rows.length > 200) {
    throw new Error('ERP_SCHEDULE_RESPONSE_INVALID');
  }
  return data.rows.map(row => {
    if (!Array.isArray(row) || row.length !== expected.length
      || !/^\d+$/u.test(String(row[0]))
      || String(row[1]) !== classId
      || !validCalendarDateTime(String(row[2]))
      || !validCalendarDateTime(String(row[3]))
      || (row[4] !== null && (!Number.isInteger(Number(row[4]))
        || Number(row[4]) < 0))) {
      throw new Error('ERP_SCHEDULE_ROW_INVALID');
    }
    const day = String(row[2]).slice(0, 10);
    if (!Number.isFinite(Date.parse(day + 'T00:00:00Z'))
      || new Date(day + 'T00:00:00Z').toISOString().slice(0,10) !== day
      || String(row[3]) <= String(row[2])) throw new Error('ERP_SCHEDULE_ROW_INVALID');
    return {
      erpSessionId: String(row[0]),
      startsAt: String(row[2]),
      endsAt: String(row[3]),
      date: String(row[2]).slice(0, 10),
      statusCode: row[4] === null ? null : Number(row[4])
    };
  });
}

function createErpDatasetReader({
  url, username, password, timeoutMs = 7000, fetchImpl = fetch
}) {
  if (!url || !username || !password) return null;
  const baseUrl = new URL(url);
  if (baseUrl.protocol !== 'https:') throw new Error('ERP_SCHEDULE_HTTPS_REQUIRED');
  const timeout = Math.min(15000, Math.max(2000, Number(timeoutMs) || 7000));

  async function postJson(path, body, token = '', deadline) {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Metabase-Session': token } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeout), deadline])
    });
    if (!response.ok) throw new Error('ERP_SCHEDULE_UPSTREAM_FAILED');
    return response.json();
  }

  return async query => {
    const deadline = AbortSignal.timeout(18_000);
    const session = await postJson('/api/session', { username, password }, '', deadline);
    if (typeof session?.id !== 'string' || !session.id) {
      throw new Error('ERP_SCHEDULE_LOGIN_FAILED');
    }
    return postJson('/api/dataset', {
      database: 2, native: { query }, type: 'native'
    }, session.id, deadline);
  };
}

export function createLearningErpScheduleReader(options) {
  const dataset = createErpDatasetReader(options);
  if (!dataset) return null;
  const pending = new Map();
  async function read(classId) {
    const query = `SELECT cs.class_session_id, cs.course_class_id,
  DATE_FORMAT(cs.session_start_datetime, '%Y-%m-%d %H:%i:%s') AS starts_at,
  DATE_FORMAT(cs.session_end_datetime, '%Y-%m-%d %H:%i:%s') AS ends_at,
  cs.status
FROM class_sessions AS cs
WHERE cs.course_class_id = ${classId}
ORDER BY cs.session_start_datetime, cs.class_session_id
LIMIT 201`;
    const payload = await dataset(query);
    return { sessions: assertScheduleRows(payload, classId), fetchedAt: new Date().toISOString() };
  }
  return async classIdInput => {
    const classId = String(classIdInput);
    if (!/^\d{1,18}$/u.test(classId)) throw new Error('ERP_SCHEDULE_CLASS_INVALID');
    if (pending.has(classId)) return pending.get(classId);
    const request = read(classId).finally(() => pending.delete(classId));
    pending.set(classId, request);
    return request;
  };
}

export function createLearningErpClassDirectoryReader(options) {
  const dataset = createErpDatasetReader(options);
  if (!dataset) return null;
  return async () => {
    const payload = await dataset(`SELECT CAST(id AS CHAR) AS class_id, name AS class_name, CAST(course_id AS CHAR) AS course_id, status,
      DATE_FORMAT(started_at, '%Y-%m-%d') AS started_at FROM course_classes ORDER BY id LIMIT 2501`);
    const data = payload?.data;
    const fields = ['class_id', 'class_name', 'course_id', 'status', 'started_at'];
    if (JSON.stringify(data?.cols?.map(column => column.name)) !== JSON.stringify(fields)
      || !Array.isArray(data?.rows) || !data.rows.length || data.rows.length > 2500) {
      throw Error('ERP_CLASS_DIRECTORY_INVALID');
    }
    const ids = new Set();
    return data.rows.map(row => {
      const [classId, className, courseId, status, startedAt] = row;
      const id = String(classId);
      if (!/^[1-9]\d{0,17}$/u.test(id) || ids.has(id) || typeof className !== 'string' || !className.trim()
        || !/^[1-9]\d{0,17}$/u.test(String(courseId)) || !['pending','on_going','completed','cancelled'].includes(status)
        || (startedAt !== null && !validCalendarDateTime(String(startedAt)+' 00:00:00'))) {
        throw Error('ERP_CLASS_DIRECTORY_ROW_INVALID');
      }
      ids.add(id);
      return {class_id:id,class_name:className,course_id:String(courseId),class_status:status,class_started_at:startedAt};
    });
  };
}
