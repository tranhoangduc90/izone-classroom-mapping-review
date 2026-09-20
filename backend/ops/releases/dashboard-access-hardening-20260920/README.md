# Gia cố quyền dashboard giảng viên

Bản phát hành này giữ nguyên image phiên đăng nhập ngày 20/09/2026 và chỉ thay cổng phân quyền, công cụ đối chiếu và canary.

- Một giảng viên được xem lớp khi có `reviewer_class_access` hoặc có phân công trực tiếp theo tên lớp. Quyền admin vẫn được kiểm riêng.
- Mọi cổng Term/Mini, Mapping Review và Progress Log dùng cùng một predicate.
- Tiến trình mỗi giờ chỉ tự bổ sung cặp phân công bị thiếu; không tự xóa quyền dư/thừa.
- Canary dùng account kỹ thuật và hai lớp demo, tạo phiên 15 phút trong RAM/database, kiểm options → roster → bài chi tiết → Progress dashboard/live → lớp ngoài quyền → đăng xuất, sau đó xóa phiên.
- JSON giám sát chỉ chứa số đếm và mã lỗi; không chứa email, cookie, tên lớp hay dữ liệu học viên.

Migration production bắt buộc backup đã xác minh trước khi chạy `202609200001` và `202609200002`. `deploy.sh --deploy` tự rollback về `izone-term-test-backend:20260920.1-teacher-session` nếu health, checker hoặc canary không đạt.

## Readback production ngày 20/09/2026

- Backup trước migration: `dashboard-access-hardening-20260920T070612Z`; bản dump đã qua `pg_restore --list`, SHA-256 `01d2701bad0d98d7f573769683f2315f57d2ef5e78dab5147953282129488c0d`.
- Image đang chạy: `izone-term-test-backend:20260920.2-dashboard-access`; phiên bản `1.10.0-dashboard-access`, health `healthy`, restart `0`.
- Lần deploy đầu đã tự rollback đúng thiết kế khi canary phát hiện dùng sai database role cho Progress Log. Canary được tách thành hai pool theo đúng quyền, build lại và deploy lần hai thành công.
- Checker production: 97 cặp phân công, 0 cặp thiếu, 0 phân công không ánh xạ, 0 quyền Portal quá hạn và 0 tài khoản ngừng hoạt động còn quyền.
- Canary production: khôi phục phiên, Term options/roster/Writing detail/attempt review, chặn lớp ngoài quyền, Progress options/dashboard/live drafts, chặn assignment ngoài quyền và logout đều đạt; sau kiểm tra còn 0 phiên canary.
- `izone-teacher-dashboard-health.timer` active + enabled; lần chạy đầu có `Result=success`, checker và canary đều `healthy`.
- Automation Codex `canh-s-c-kh-e-dashboard-gi-ng-vi-n` chạy mỗi giờ bằng `gpt-5.6-luna`/high, chỉ đọc; khi có bất thường mới gọi một Sol/high để điều tra và tự kiểm chứng.
- Bộ test backend sau sửa: 151/151 đạt. Smoke test trình duyệt thật đã tải đúng màn hình đăng nhập Google của Term Test, Progress Log và Handout Writing; 401 khi chưa có phiên là kết quả bảo vệ dự kiến.
