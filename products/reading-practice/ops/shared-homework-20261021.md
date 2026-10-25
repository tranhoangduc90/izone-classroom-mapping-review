# Reading buổi 9: trạng thái Homework từ link chung

Yêu cầu ngày 21/10/2026: giữ link chung `?lesson=9`, tự cập nhật Homework cá nhân và chạy bù cho học viên đã hoàn thành. Bản cũ lưu kết quả nhưng không tạo job Docs cho binding shared.

## Luồng và giới hạn

- Khi bắt đầu/reset/nộp buổi 9, trạng thái và job Docs cùng giao dịch. Không thêm Google vào thời gian chờ lưu/nộp bài. Điểm, nội dung, thời gian và lượt cũ giữ nguyên.
- Worker nối UUID + lớp qua owner source chỉ đọc đã có, lấy đúng Google user/course. Duyệt Homework Lesson 9/BTVN buổi 9 có bản sao riêng `STUDENT_COPY`, phân trang đầy đủ, kiểm submission và đúng một mã bài/tab. Không nối bằng tên, không ghi bản mẫu hoặc chọn đích đầu tiên khi có nhiều kết quả.
- Lưu đích trong `owner_proof.homework`, giữ `mode=shared` và `document_id=null`; phiên, link chung và lịch sử không đổi. Lần ghi sau vẫn kiểm lại mapping/submission/mã bài; không tin đích lưu cũ vô điều kiện.
- Chỉ quản lý dòng `Reading thực chiến (tự động): …` trong ô trạng thái. Giữ chữ/link thủ công và toàn bộ phần khác; dùng revision Docs để tránh ghi đè thay đổi đồng thời. Dòng tự động bị sửa tay hoặc đích mơ hồ thì blocked, không ghi liều.
- Dùng hàng Docs hiện có, xử lý lần lượt từng binding, lease 180 giây. Tìm đích giới hạn 40 giây cho các request Classroom, tối đa 10 trang; request nguồn 5 giây, Google 10 giây. Retry có backoff hiện hành tối đa 8 lần rồi blocked; `tools/operate.mjs status/retry` dùng để theo dõi/phục hồi. Lỗi Google không làm mất bài đã lưu.
- Quy mô quan sát ban đầu: 11 binding buổi 9 tại IC2304, 8 đã hoàn thành. Không gọi AI hoặc phát sinh phí AI. Mỗi binding tìm đích một lần, sau đó chỉ xác minh lại; không đổi lịch/n8n hoặc backend chung.

## Chạy bù và kiểm

`tools/backfill-shared-homework.mjs` mặc định chỉ xem số lượng; `--commit` xếp lại đúng sự kiện cuối cho những hồ sơ đã có lần hoàn thành. `--binding=<UUID>` giới hạn ca đầu. Giữ nguyên sequence, chống trùng bằng khóa binding/sequence, khóa hàng bài làm cùng giao dịch; không sửa bài hay chấm lại. Chưa hoàn thành không chạy bù.

`tools/inspect-shared-homework.mjs` chỉ đọc đích và hash bài; `--documents` xuất Docs đầy đủ vào kho riêng tư để backup/readback. Không commit đầu ra có học viên. Chạy công cụ bằng cấu hình của riêng Reading; lỗi/partial phải được giữ nguyên khi tổng hợp.

Regression chủ: hai ca trong `test/shared-entry.test.js` (nộp và chạy bù), `test/docs.test.js` (giữ chữ, retry/mất ACK, sai UUID), `test/shared-homework.test.js` (mapping/submission/tab/phân trang/đích trùng). Suite đầy đủ là `npm test` trong sản phẩm. Test SQL cục bộ dùng PGlite; bằng chứng Google thật phải đọc lại riêng.

## Phát hành và quay lại

Chỉ overlay module Reading lên image live đã chụp, giữ toàn bộ env/mạng/volume/phiên và container nguồn chỉ đọc. Backup DB Reading cùng nguồn image trước thay. Canary một hồ sơ, đọc lại đúng chữ/link và các vùng không đổi rồi mới chạy phần còn lại. Retry cùng gói phải xếp 0 job mới; đối chiếu hash bài trước/sau.

Runtime quan sát dùng cổng host **127.0.0.1:18808 → 8808**, khác compose gốc. Khi chuyển phải override toàn bộ danh sách cổng, không dùng compose gốc một mình. Sau chuyển so env bằng hash, cổng, mạng, volume, lệnh chạy và restart policy; nguồn owner và DB phải giữ nguyên container/thời điểm khởi động. Health public là `/reading-practice-api/api/health`.

Quay lại image Reading cũ, giữ DB và Docs mới, không restore dump cũ. Trước chuyển về worker cũ, nếu còn job shared pending/processing thì đợi xử lý xong hoặc chuyển riêng chúng sang blocked có lưu trạng thái trước đó; không để worker cũ đọc job không có Docs. Không phát hành lại các sản phẩm khác. Quyền Git/push/tích hợp vẫn riêng với quyền sửa vận hành.

## Kết quả thực tế ngày 21/10/2026

- Base source `784381a8b535e243264f93b817da71de8ec8854c` khớp toàn bộ module live sau chuẩn hóa xuống dòng. Image trước là `3a28c9c819e5…`; bản overlay mới là `73938fe6b699…`. Không migration hoặc thay schema.
- Hai regression chủ RED trên base: shared không xếp hàng Docs, ô có chữ nhập tay bị từ chối. Bản cuối **45/45** test native đạt, không skip, gồm 100 học viên và 10 cửa sổ GV cục bộ; Google thật được kiểm riêng.
- Discovery Google thật phát hiện bài chỉ giao riêng cho học viên khác trả 404 khi lọc sai người. Đã có regression RED/GREEN và bỏ qua theo `individualStudentsOptions`, không nuốt mọi lỗi 404. Một request Google quá thời gian đã được đọc lại thành công trước khi chuyển.
- Sau chuyển lần đầu phát hiện cổng compose gốc lệch runtime; đã sửa override và kiểm lại trước chạy bù phần còn lại. Health và catalog buổi 9 public đạt; env/mạng/volume/lệnh/restart giữ nguyên, owner/DB không khởi động lại.
- Ca đầu là hồ sơ được người dùng báo. Docs đọc lại giữ nguyên chữ/link thủ công và toàn cấu trúc ngoài ô trạng thái. Sau ca đầu, xếp bù 7 hồ sơ còn lại; kết quả cuối và bằng chứng chi tiết nằm trong kho riêng tư `E:/Codex-Data/artifacts/reading9-homework-status-20261021/`, không commit dữ liệu học viên vào Git.
