# Term Test 1 K56 · Viết dự phòng và ràng buộc lưu bài

Viết dự phòng được mở bằng quyền riêng cho một kỹ năng. Khi lượt chính chưa hoàn tất, ràng buộc Writing của bảng attempt từ chối mốc bắt đầu với SQLSTATE `23514`. Hai ca bài trắng và bài có nội dung tái hiện trên module đang phục vụ và định nghĩa ràng buộc đọc từ production.

## Gói thử

- `migration.sql` giữ nguyên các nhánh của ràng buộc đang chạy. Nhánh bổ sung cần quyền Viết đã gắn đúng lượt, phiên, thế hệ và lớp. Thu hồi quyền giữ bản nộp và nguồn gốc đã lưu. Khi mất mạng hoặc phản hồi nộp, đọc lại mã biên nhận bằng hợp đồng hiện hành.
- `overlay.patch` chỉ đổi `src/term1-skill-offline-core.mjs`. Mã chỉ ghi dấu quyền khi nhận Writing dự phòng của Term 1 K56 trong giao dịch đã xác minh. Giữ contract với bài chính, phiếu, Term 2 và Mini.
- File nguồn live trước khi ghép có SHA-256 `335ba2f0ea18de57c7ab042b498af2c56a87257e0413286ef4368f7322c411f3`. SHA-256 ứng viên đã kiểm là `40a10643b0d041e0ef24542b533254fa13012f7c2afa0634895ea4a8e188c147`.
- `native-receipt-overlay.patch` bổ sung nhận diện biên nhận của ba kỹ năng dự phòng. Đối chiếu trạng thái đã chốt và quyền đã gắn đúng kỹ năng, lượt, phiên, lớp và thế hệ. Giữ mã sự kiện khi gửi lại và giữ các điều kiện loại trừ phiếu khỏi CBT. SHA-256 của file live là `51dcb17f80c20ac9783fbe85acfa1833a23d01a2fe333bca8a959b69e5f0b814`. Ứng viên là `65929fe86f446952905aa2929aa54ce3315f191edaec3054204563deca09e993`.

## Kiểm và phát hành

Dùng dữ liệu giả trong PostgreSQL cách ly với đúng nội dung ràng buộc, trigger khóa bản chính thức và overlay live. Kiểm cấp sai quyền, nộp lần đầu, bài trắng 0, đúng một job Task 2 có nội dung, đọc lại biên nhận sau mất phản hồi và giữ đầu điểm khác. Kiểm riêng vai trò của giảng viên, tuyến thu hồi và hai đầu điểm đã có hoặc còn trống. Áp dụng ràng buộc bổ sung trước overlay và tách bước kiểm dữ liệu cũ ra khỏi khóa ngắn. Đối chiếu schema thực sự sau ghép, vì module nguồn dùng `assessment` còn đích K56 hiện là `assessment_k56`.

Khi cần quay lại, dùng chính overlay đã lưu và giữ bản bài đã nhận. Để nguyên cột nguồn gốc và ràng buộc mở rộng cho tới khi đã kiểm được toàn bộ lượt dự phòng đã ghi bằng cấu hình mới. Gói này đang ở môi trường thử.
