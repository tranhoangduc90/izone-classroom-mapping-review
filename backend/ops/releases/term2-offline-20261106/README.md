# Term Test 2 K56 — bảo toàn bài và Writing trống

Gói này chỉ cấp cơ chế mới cho lượt CBT Term Test 2 K56 chưa bắt đầu. Giữ nguyên bảng bài thi, đề đã ghim, lớp/học viên, cách tính điểm và tuyến Portal hiện hành. Lượt đang làm theo cơ chế cũ tiếp tục được phục vụ; không reset, đổi bài hoặc chấm lại lịch sử.

## Thành phần

- `term2-offline.mjs`: quyền offline HMAC gắn attempt/session/generation/thiết bị; operation start/draft/seal; biên nhận có hash và revision; transaction chứa bài, điểm L/R, receipt và outbox. Cửa sổ 24 giờ cho truyền bài đã khóa, không cấp thêm giờ làm. Thời gian hoặc quyền không khớp giữ payload để đối soát.
- `term2-blank.mjs`: đọc Task 1 canonical đã nộp của v2. Chỉ chuỗi thực sự trắng mới có `blank_rule`, 0 điểm, kết quả ready và outbox Writing 0. Không tạo job dispatch AI. Thiếu field hoặc có kết quả khác được giữ để đối soát. Bài ngắn có chữ vẫn dùng luồng AI hiện hành.
- `patch-live.py` + `baseline.json`: kiểm đúng nguồn rồi ghép bốn file hiện hành và thêm hai module. Không dựng lại toàn bộ source Git lên image đang chạy. Giữ các overlay sản phẩm khác.
- `print-migration.py`: in migration từ cùng schema được test, chỉ thêm hai bảng và index trong `assessment_k56`, cấp SELECT/INSERT/UPDATE cho `k56_shared_api`. Role API không có quyền CREATE schema; chạy migration bằng role quản trị đã dùng cho backup.
- `test.mjs`, `preflight.test.mjs`: HTTP/SQL, rollback, quyền, Unicode trắng, thiếu field, bài ngắn, đồng thời 30/50 người giả, mất ACK, crash sau commit, CORS và journal. Không gọi AI/Portal thật hoặc dùng học viên làm fixture.

## Hợp đồng của trình duyệt

Frontend thuộc repo Pages, route `term-tests/term-test-2-k56-computer-based/`. Sẵn sàng nghĩa là đã có quyền, nội dung cả ba kỹ năng, hình/font/module đã kiểm hash và toàn bộ MP3 đọc lại được từ IndexedDB. Audio GitHub Pages mặc định; Cloudinary dự phòng chỉ trong bước chuẩn bị. Trong lúc thi dùng một Blob đã kiểm, không đổi nguồn theo request mạng.

Listening v2 không có hạn thu bài dựa trên đồng hồ chạy ngoài audio. Chỉ natural ended hợp lệ mới tự khóa; lỗi media hoặc đứng tiến độ giữ mốc và cho phục hồi. Nộp thủ công vẫn cần hành động/xác nhận của học viên như giao diện hiện hành.

`/offline/status` chỉ trả kết quả đã commit. Trình duyệt chỉ gỡ pending khi operation/hash/attempt/session/generation/revision khớp biên nhận accepted. HTTP 200 đơn thuần không phải biên nhận. Bài có `review_required` không được tự chấm/ghi Portal.

Operation Writing đã commit là outbox bền để quét bù tạo grading khi process dừng trước bước đó. Native notifier tiếp tục đánh thức worker theo bảng job; bài trắng không tạo job. Điểm đi qua native Portal Hub đang chạy, có kiểm danh tính, thang điểm và xác nhận đích; không đổi n8n hoặc cấu hình Hub.

## Ghép và kiểm

Chụp `src`, package và image/mount thực tế vào thư mục riêng. Image nền được ghi ở `baseline.json`. Chạy `python patch-live.py <thu-muc-source-da-chup>`; hash khác thì dừng để đọc lại nguồn. Đóng image bằng bản nền có tag cục bộ theo image ID, COPY đúng sáu file trong manifest; không COPY secrets/private assets hoặc toàn main.

Chạy `node --test test.mjs preflight.test.mjs` với `TERM2_RUNTIME_ROOT` trỏ source đã ghép và `TERM2_DEPS_PACKAGE` trỏ package có dependencies. Không đặt `TERM2_TEST_PG_URL` thì dùng PGlite. Bộ PostgreSQL có tên database/container fixture cố định và từ chối URL khác để tránh dùng nhầm dữ liệu thật.

Trước phát: backup schema K56 bằng role có quyền đọc cả sequence, kiểm `pg_restore --list`, so lại live image/config/mount. Áp migration trước API; giữ toàn bộ cấu hình cũ, chỉ thay image, `BUILD_SHA` và mount adapter journal riêng K56. Không sửa file adapter host đang dùng chung K67. Đọc `/ready`, CORS, hash sáu file và quyền hai bảng, rồi mới phát Pages.

## Quay lui và đối soát

Trước khi có lượt v2, có thể quay container cũ; không xóa hai bảng mới hoặc restore đè database. Khi đã có v2 pending, phải giữ adapter nhận v2, biên nhận, secret và hai bảng. Đặt `TERM2_OFFLINE_NEW_ENABLED=false` để ngừng cấp mới; các lượt đã cấp vẫn gửi/đọc được. Frontend mới nhận mã này sẽ dùng cơ chế tương thích cho lượt chưa được cấp v2. Không quay trần về backend không có `/offline/*` khi còn bài v2.

Giữ cache build và dữ liệu trình duyệt của lượt đang làm. Không phát worker mới cưỡng bức giữa lượt, không xóa kho IndexedDB/localStorage, receipt hoặc payload review để quay code. File HTML học viên tải có đáp án/bài viết và biên nhận đã lọc, không có permit, token truy cập hoặc khóa audio; file bảo toàn nội dung, không tự chứng nhận nộp đúng hạn.

Khi hỗ trợ: nối requestId → operationId → receiptId; đọc `term2_offline_operation.receipt` và payload đúng attempt, generation. `review_required` là dữ liệu đã giữ nhưng chưa được công nhận nộp. Không sửa receipt/payload hoặc suy bài thiếu thành 0. Đối chiếu file tải và nháp trước mọi thao tác nghiệp vụ có thay đổi kết quả.

## Bằng chứng chuẩn bị 06/11/2026

Image ứng viên `izone-term2-offline:20261106-rc3` ghép từ đúng nền live; 20 ca PostgreSQL/CORS/journal đã đạt, gồm role API tối thiểu, quét bù sau crash và đồng thời 30/50 người giả. Đây là bằng chứng môi trường cách ly; chưa thay kết quả học viên hoặc ghi thử Portal thật. Trạng thái phát hành và hai lượt đủ thời lượng được bổ sung sau đọc lại production.
