// Chỉ dùng chung lượt đọc cùng lớp/bài đang chờ; không giữ kết quả hoặc quyền cũ.
// Nguồn lỗi giải phóng mục để lần gọi sau đọc lại, quá giới hạn vẫn đọc bình thường.
export function createPendingRoster({maxEntries=512}={}) {
  const pending=new Map();
  return function readRoster(key,read) {
    if(pending.has(key))return pending.get(key);
    if(pending.size>=maxEntries)return Promise.resolve().then(read);
    const work=Promise.resolve().then(read).finally(()=>pending.delete(key));
    pending.set(key,work);
    return work;
  };
}
