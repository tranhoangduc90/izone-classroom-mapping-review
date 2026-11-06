# Nguồn lớp tự mở cho Reading/Listening khóa 67

Thêm endpoint nội bộ có khóa `/v1/homework/class-scope`, đọc view metadata `k67_context_api_v1.homework_class_scope` bằng role chỉ đọc hiện có. Payload phiên bản 1, ERP course 5, danh sách classId/classCode/courseId, capturedAt và SHA256. Không chứa học viên. Sai khóa dừng trước DB; lỗi nguồn trả 503. Không đổi schema hoặc logic `/v1/snapshot` của Term/Mini.

Đã phát hành image `da83097fa97dbaca12be03301930db9492dea72fd2214ba063c97b7d5a9217dc`, ghép đúng một route vào image đang chạy; giữ endpoint ERP Homework cũ và toàn bộ config/env/mount/mạng. Đọc lại health, metadata 13 lớp và snapshot 108 lớp đều HTTP 200. Hai kiểm thử route/auth/failure đạt. Migration và quyền reader: [Issue 80](https://github.com/tranhoangduc90/izone-mapping-database/issues/80).

Backup container: `term-mini-k67-context-source-before-rl67-auto-scope-20261106`. Quay runtime dùng container/image cũ, giữ database hiện hành. Source metadata chỉ phục vụ Homework; Reading/Listening thực chiến vẫn dùng snapshot động hiện có, không đổi image hoặc CTA của hai sản phẩm đó.
