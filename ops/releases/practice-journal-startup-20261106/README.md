# Reading/Listening thực chiến: startup logger, chưa phát hành

Ngày 06/11/2026. Canonical thêm bridge vào hai `src/server.js`, truyền metadata cho service/Docs, intake cho app và chờ logger trước `pool.end`. Các observer đăng ký callback sau COMMIT/Docs qua hàng nguồn; chỉ dùng fallback cũ khi không có `scheduleSource`, không fallback khi hàng từ chối.

Thư viện chung yêu cầu `tranhoangduc90/izone-AI-team` commit **f531cc070382f33c10ffb2fe93364d304681d21a** (đã nhập main qua PR492). `EXAM_JOURNAL_ENABLED` mặc định khác `1`: không đọc private config hoặc import SDK. Bật bằng `1` cần thư viện ở `EXAM_JOURNAL_LIBRARY_ROOT` (mặc định `/opt/exam-journal`) và `EXAM_JOURNAL_CONFIG_FILE`, dùng product ID cố định từ server. Cấu hình sai chỉ tắt logger và phát mã lỗi cố định. File/mount phải đọc được bởi UID runtime; không dùng thư mục root0700.

SDK phân biệt metadata đã vào producer spool với browser event đã được Collector ghi. Giới hạn nguồn 1.024 callback; shutdown chờ nguồn/transport tối đa20giây. Timeout, nguồn lỗi, hàng đầy/đóng hoặc transport chưa hết trả `shutdown_unknown`, không nhận đã lưu bền vững.

## Native overlay

Runtime hiện hành có overlay ngoài canonical. **Không rebuild API từ canonical để phát logger.** Dùng `overlay-manifest.json` và các patch LF trong thư mục từng sản phẩm, dựa trên đúng image native đã ghim. Mỗi sản phẩm đổi bảy file, giữ coordinator/SSE, shared-login và 24/28 tệp nguồn còn lại. Đã áp patch trên nguồn gốc sạch và đối chiếu đầy đủ hash. Patch CRLF sinh ở thử nghiệm đầu không áp được; bản chuẩn ở Git có `.gitattributes` giữ LF.

Trước phát, chụp lại native và so hash nền; nếu nguồn đã đổi phải ghép delta trên nguồn mới và kiểm phần chịu tác động. Không lấy một manifest cũ làm bằng chứng source đang chạy vẫn giống. Rollback trước mở: cờ0. Sau mở: dừng producer/đóng sản phẩm theo runbook P4, giữ registry/khóa/kho và dữ liệu mới; quay image/code tương thích, không restore SQL cũ hoặc bỏ membership đã công bố. Collector giữ0,50CPU, Agent0,05CPU và quota4GB.

## Kiểm và khoảng trống

Nhóm journal/Docs/HTTP trên PGlite và Supertest của canonical: Reading16, Listening15 ca; native Reading16, Listening14. Ca mới kiểm callback được đăng ký trước phản hồi nghiệp vụ, chỉ đọc trạng thái đã COMMIT và không chạy ngoài hàng khi bị từ chối. Ca Docs mới ban đầu thiếu lease đúng; sửa fixture và kiểm lại ca đó, giữ lịch sử lỗi. Source đã nhận main b0ef511 với shared-login/Lesson3 mới và có lượt kiểm lại riêng trước commit.

Thư viện chung có bảy ca runtime Windows/Linux; runner `practice-native-startup-check.mjs` chạy server.js/bridge/SDK thật: tám native Windows/Linux và sáu canonical Windows. SQL/Google/listen/coordinator và signed RPC là double cô lập, chưa phải startup hạ tầng production. Native shared-login kiểm riêng Reading12/Listening8; một file Listening thiếu helper fixture ở lượt đầu, bổ sung helper rồi ba ca đạt.

Năm sản phẩm P4 chưa mở. Còn hai Homework/script serve, tài nguyên Agent8/128MiB/backup, cấu hình/mount/registry, canary/flag và rollback trước mở từng tuyến ngoài giờ thi. Không đổi API, proxy, DB, khóa hoặc tài nguyên VPS trong gói Git này.

Đích bằng chứng private trên laptop: `E:/Codex-Projects/New project/private-deployments/log-first-release-20261103/homework-p4-practice-startup-r2/README.md`. Tài liệu chung: `tools/exam-journal/optimization/PRACTICE_NATIVE_STARTUP_20261106.md` trong repository izone-AI-team.
