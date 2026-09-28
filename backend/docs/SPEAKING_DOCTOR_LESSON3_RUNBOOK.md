# Phân tích bài Speaking Lesson 3 và cập nhật Bác sĩ AI

Ngày chuẩn bị: 29/09/2026. Phạm vi: Homework Lesson 3 lớp IC2304, mã bài `67-speaking-lam_ro`. Phần này đang ở nhánh thử; chưa áp dụng migration hoặc bản API mới lên production.

## Học viên và giảng viên sẽ thấy gì

Học viên dán và xác nhận bốn link ChatGPT Share. Sau khi cả bốn link đạt, webapp tạo biên nhận và ghi trạng thái về đúng file Docs theo Doc ID. Trang Lesson 3 vẫn chỉ có bốn phần nộp bài; danh sách Bác sĩ AI không hiện ở đây. Ở phía sau, hệ thống đọc bốn hội thoại, tìm lỗi đã được ChatGPT góp ý, ghép với bài luyện khóa 67 và cập nhật danh sách riêng của học viên trong database mapping. Danh sách dùng quy tắc hiện hành: ưu tiên bài còn “Chờ luyện”, rồi “Số lần đề xuất” giảm dần.

## Luồng xử lý

1. `finish()` chỉ tạo biên nhận khi đủ bốn link đã kiểm và chưa trùng hội thoại trong khóa. Cùng giao dịch này tạo việc `doctor_analyze` nếu bài có `doctor_course_key='67'`.
2. Worker nhận việc trong tối đa khoảng 5 giây khi rảnh; xử lý tối đa hai biên nhận đồng thời. Mỗi biên nhận đọc bốn Share song song, đối chiếu dấu vân tay với lần xác nhận link để ngăn hội thoại bị đổi sau khi kiểm.
3. AI đọc phần góp ý trong từng hội thoại và danh mục bài đang bật. AI trả số thứ tự bài, vị trí lời góp ý và lý do. Backend chuyển số thứ tự thành ID bài thật; chỉ giữ bài có vị trí lời ChatGPT và trích dẫn có thể đối chiếu với nội dung thật. Tối đa năm bài mỗi hội thoại.
4. Một giao dịch database kiểm lại phiên bản danh mục, lưu bằng chứng vào `doctor_analysis`, tạo/tăng `doctor_recommendation` và `doctor_event`, rồi đánh dấu việc `done`. Một bài được đề xuất từ hai phần trong cùng biên nhận vẫn chỉ tăng một lần. Khi không có lỗi đủ bằng chứng, lưu kết quả rỗng và vẫn hoàn tất việc.
5. Nếu đọc Share, gọi AI, kiểm bằng chứng hoặc ghi database lỗi, việc chuyển `failed` và được thử lại tối đa năm lượt. Giao dịch chưa hoàn tất không tạo đề xuất nửa chừng. Khóa nguồn chứa biên nhận và bài luyện để tránh tăng trùng sau retry.

## Dữ liệu và giới hạn

- Nguồn danh mục: `speaking_homework.doctor_exercise`, khóa `67`, chỉ bài `active=true`. Kiểm production ngày 29/09 thấy 60 bài đang bật.
- Đích: `doctor_analysis` (bằng chứng ngắn theo biên nhận), `doctor_recommendation` (danh sách/đếm ưu tiên) và `doctor_event` (dấu chống trùng). Không lưu toàn bộ hội thoại mới trong bảng phân tích.
- Lớp pilot có 15 học viên; nếu tất cả nộp đủ bốn link, tối đa 60 lượt đọc Share và 60 lượt gọi AI cho phân tích Bác sĩ AI, ngoài bộ kiểm link lúc dán. Hai biên nhận xử lý đồng thời, tức tối đa tám lượt gọi AI cùng lúc. Thử bốn link thật ở máy local mất khoảng 15 giây; lúc dịch vụ chậm, mỗi biên nhận có thể cần tới khoảng 135 giây.
- Hàng việc có lease 5 phút; quá hạn có thể nhận lại. Đề xuất được ghi nguyên tử và khóa nguồn chống đếm lặp. Công việc hết năm lượt phải được điều tra từ mã lỗi, không tự tuyên bố đã cập nhật danh sách.
- Quy tắc Lark cũ được giữ trong database: mỗi lần đề xuất tăng `recommendation_count`; bài mới chờ luyện; bài đã luyện chỉ mở lại khi lần luyện cuối cách thời điểm đề xuất cũ hơn năm ngày.

## Kiểm tra và phát hành

Trước phát hành: backup database và image API; kiểm bảng điểm danh Progress Log, worker `sync_portal_attendance` và hàng chờ như bản live; chạy migration `202609290001_speaking_doctor_lesson3.sql` có ledger; kiểm `doctor_course_key='67'` cho đúng một assignment; build image bằng Dockerfile gói phát hành đã khóa hash image nền; triển khai API từ nhánh đã review; đọc lại các worker đang chạy. Không thay n8n hoặc trang Lesson 3 ngoài sửa câu hướng dẫn đã audit. Image nền production đọc ngày 29/09 là `izone-term-test-backend:20260929.speaking-cross-doc-v1`; nếu đã đổi trước lúc triển khai phải đối chiếu lại và dựng lại gói phát hành.

Canary: dùng một biên nhận thử có bốn Share hợp lệ nhưng không làm thay đổi học viên thật, hoặc nộp thật đầu tiên khi có quyền; đối chiếu bốn lớp kết quả: API nhận việc, `doctor_analysis` có bằng chứng, `doctor_event`/`doctor_recommendation` tăng đúng một lần, và danh sách đọc lại đúng học viên. Kiểm thêm Docs nhận biên nhận và Progress Log attendance không lệch. Nếu không có biên nhận thật, trạng thái production tối đa là `deployed_awaiting_validation`.

Theo dõi: đếm `doctor_analyze` theo `pending/processing/failed/done`, đặc biệt việc `attempts>=5`; so số biên nhận Lesson 3 với số `doctor_analysis`; kiểm danh sách và thứ tự ưu tiên trên một học viên mẫu có quyền. Lỗi AI hoặc thay đổi danh mục phải được giữ để thử lại; không chạy lại cả bài nộp hoặc tăng đề xuất bằng tay khi chưa đối chiếu `doctor_event`.

Quay lại: dùng image API trước phát hành; tạm đưa `doctor_course_key` của đúng assignment về `NULL` để không tạo việc mới, giữ nguyên việc/bằng chứng đã có để điều tra. Migration tạo bảng có thể để nguyên khi rollback ứng dụng; không xóa đề xuất đã ghi nếu chưa có quyết định xử lý dữ liệu.

## Bằng chứng hiện có

- Bộ test Speaking trên PGlite: gồm ghép bốn link, backfill biên nhận cũ, rollback khi danh mục đổi, idempotency, kiểm trích dẫn và Share đổi sau xác nhận.
- Bộ test backend đầy đủ trên bản ứng viên cuối: 219/219 đạt; `npm run check` đạt.
- Bốn ChatGPT Share được Đức cung cấp đều đọc trực tiếp được; lần thử AI gần nhất ghép thành công cả bốn phần với danh mục thật, không ghi database. Kết quả AI có thể thay đổi giữa các lượt nên canary production vẫn bắt buộc.
