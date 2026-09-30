# Phát hành Speaking Homework buổi 2 IC2304

Học viên mở [webapp buổi 2](https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/), chọn tên thật của lớp IC2304, luyện Paraphrase và Full Speaking, rồi xác nhận hai link ChatGPT Share. Khi cả hai hội thoại đạt, trang cấp biên nhận. File Docs và trạng thái bài Classroom cũ giữ nguyên. Bác sĩ AI nhận lỗi từ hai hội thoại, xếp lại bài cần luyện và nhận các lượt luyện thêm sau biên nhận.

## Thứ tự phát hành

1. Chụp lại image/container API live, sao lưu database mapping và đọc trạng thái hàng điểm danh Progress Log. Ghi lại sự hiện diện và đích của cấu hình điểm danh mà không in secret.
2. Chạy migration `202609300001_speaking_direct_homework.sql`. Các bài cũ mặc định vẫn ở chế độ `docs_cta`.
3. Dùng `Dockerfile` phủ đúng hai module Speaking đã kiểm lên image `izone-progress-log-journey:20260930-rc3`; chạy `deploy-api.sh` sau khi đối chiếu digest image live. Script giữ container cũ để quay lại, tự phục hồi nếu health check thất bại. Kiểm `/ready`, đăng nhập giảng viên, Progress Log và consumer điểm danh.
4. Chạy `register-ic2304.sql`: đổi **chính hàng cũ** từ `67-speaking-lesson2-legacy` sang `67-speaking-paraphrase`, giữ tối thiểu 21 hội thoại đã nhận diện và để bài ở trạng thái `draft`.
5. Đọc snapshot đầy đủ 15 bài nộp Classroom, trích chính xác một Doc ID từ mỗi attachment; gửi endpoint nội bộ `/internal/classroom-copies/sync`. Chỉ ghi mapping bản sao; không gọi `plan`/`verify` CTA, không sửa Docs.
6. Đối chiếu 15 cặp Classroom user ID → học viên đã duyệt → Doc ID và chạy `activate-ic2304.sql`. SQL tự chặn nếu số lượng, tính duy nhất hoặc lịch sử link không đạt.
7. Phát hành Pages, mở trang công khai và kiểm roster 15 người, bài từ chối link `/c/`, `/s/t_`, hai link đạt, biên nhận, bài Bác sĩ AI và ô luyện thêm. Kiểm từ trình duyệt máy tính và điện thoại.

## Khi lỗi

- Lỗi trước bước 6: bài vẫn `draft`, trang không nhận bài. Sửa mapping hoặc API rồi chạy lại bước liên quan.
- Lỗi sau khi mở bài: đóng riêng hàng buổi 2 (`status='closed'`) để dừng phiên mới; giữ biên nhận, claim và lượt luyện đã có để đối soát. Quay API về image/container cũ nếu lỗi thuộc API; migration chỉ thêm cột và có mặc định an toàn.
- AI tạm lỗi: link giữ trạng thái chờ/lỗi, học viên chưa nhận biên nhận; kiểm hàng `speaking_homework.check_job`, `outbox`, `practice_check_job` và `practice_analysis_job` bằng ID công việc trước khi thử lại.
- Điểm danh Progress Log lệch: quay API về image cũ theo snapshot, đối chiếu hàng chờ và outcome Portal. Không xóa migration hay dữ liệu học viên để quay lui.

Nghiệm thu sản phẩm cần bằng chứng readback production cho registry, 15 Docs, webapp, một hành trình nộp thật và kết quả phân tích. Nếu chưa có hội thoại mới đủ điều kiện, ghi `deployed_awaiting_validation` cho nhánh AI/biên nhận.

## Kết quả phát hành ngày 30/09/2026

- Đã sao lưu toàn bộ database trước đổi vào vùng riêng tư trên VPS: `/opt/backups/speaking-lesson2-20260930/mapping-before.dump`, 314.789.418 byte, SHA-256 `dcb610032be8a684fbb3e186403b924747ef2f8abfea6a1cae889c0593611f5e`. Container API cũ được giữ với tên `mapping-review-api-before-speaking-lesson2-20260930`.
- Migration thêm `delivery_mode` chạy thành công. Image `izone-speaking-lesson2:20260930-v1` khởi động khỏe sau bốn lượt health check. Ba module `auth.js`, `learning-attendance-worker.js`, `learning-outbox.js` có hash không đổi; bốn cấu hình điểm danh giữ dấu băm; 102 việc `sync_portal_attendance` vẫn `complete`.
- Registry bài Classroom `873394669810` đọc lại: `67-speaking-paraphrase`, `open`, `direct`, hai phần, 15 bản Docs thuộc 15 học viên và 21 hội thoại lịch sử. Chưa có biên nhận mới tại thời điểm kiểm; không sửa Docs cũ.
- Pages [trang học viên](https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/) đã deploy thành công tại commit `212408de38abb8a96afe02d0714a99cb9e3b5b9b`. Browser thật ở 1280 px và 390 px đều tải 15 tên và đủ chín ảnh, không tràn ngang hay lỗi JavaScript. Phép thử mô phỏng qua hai link, biên nhận, luyện thêm và ghi nhớ tên đạt cả hai kích thước.
- Quality gate có cấu trúc hợp lệ, trạng thái `deployed_awaiting_validation`: chưa có học viên nộp hội thoại mới sau khi mở bài để đọc lại biên nhận và thay đổi danh sách Bác sĩ AI trên production. Không dùng link cũ của học viên để tạo bài nộp giả trên hồ sơ của họ.
