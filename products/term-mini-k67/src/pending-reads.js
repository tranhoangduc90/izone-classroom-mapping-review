// Nhận khóa và hàm đọc; các yêu cầu trùng chỉ chia sẻ công việc còn đang chạy.
// Không giữ kết quả/quyền sau khi xong; lỗi cũng giải phóng mục để lần sau thử lại.
export function createPendingReads({maxEntries=512}={}) {
  const pending=new Map();
  return function readOnce(key,read) {
    if(pending.has(key))return pending.get(key);
    if(pending.size>=maxEntries)return Promise.resolve().then(read);
    const work=Promise.resolve().then(read).finally(()=>pending.delete(key));
    pending.set(key,work);
    return work;
  };
}

// Dùng lại dữ liệu trong đúng một yêu cầu HTTP; yêu cầu mới luôn đọc nguồn mới.
// WeakMap tự giải phóng khi request kết thúc, không giữ danh tính thành cache dài hạn.
export function createRequestReads() {
  const requests=new WeakMap();
  return function readForRequest(request,key,read) {
    let entries=requests.get(request);
    if(!entries){entries=new Map();requests.set(request,entries);}
    if(!entries.has(key))entries.set(key,Promise.resolve().then(read));
    return entries.get(key);
  };
}
