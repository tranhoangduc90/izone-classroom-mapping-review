# Hợp đồng dữ liệu cho API duyệt mapping

Tài liệu này mô tả dữ liệu giao diện cần. API trung gian có thể được viết bằng Apps Script, n8n hoặc một dịch vụ nhỏ khác; giao diện không gọi thẳng Metabase/PostgreSQL.

## Tải hàng chờ

`GET /api/mapping/reviews?class_id=<erp_course_class_id>&status=pending_review`

Request phải có header `x-review-token`. Mã này do quản trị viên cấp, chỉ giữ trong `sessionStorage` của tab đang mở và không được ghi vào repo.

Response tối thiểu:

```json
{
  "ok": true,
  "items": [
    {
      "id": "review-id",
      "classId": "erp-course-class-id",
      "className": "Tên lớp tại thời điểm tạo đề xuất",
      "erpStudentId": "contact-id",
      "erpStudentName": "Tên lấy từ ERP",
      "classroomUserId": "Google user ID",
      "classroomName": "Tên hiển thị trên Classroom",
      "classroomEmail": "email@example.com",
      "confidence": 0.98,
      "reason": "Lý do AI đề xuất",
      "status": "pending_review",
      "candidates": [
        {
          "userId": "google-user-id",
          "fullName": "Tên hiển thị trong Classroom",
          "email": "email@example.com"
        }
      ]
    }
  ]
}
```

`erpStudentId` là mã kỹ thuật ổn định dùng để nối với ERP. Không suy ra tên học viên từ email khi chưa có quyết định của giảng viên.

## Ghi quyết định

`POST /api/mapping/reviews/decision`

Request:

```json
{
  "reviewId": "review-id",
  "decision": "approve",
  "note": "Đã xác nhận với học viên tại lớp.",
  "reviewerName": "Tên giảng viên"
}
```

Giá trị `decision` là `approve`, `reject` hoặc `choose_another`. Với `choose_another`, request cần thêm `classroomUserId` của ứng viên mới. API chỉ chấp nhận tài khoản còn nằm trong roster hiện tại của đúng lớp và từ chối nếu Google ID đã được duyệt cho học viên ERP khác.

Response:

```json
{
  "ok": true,
  "reviewId": "review-id",
  "status": "approved",
  "mappingId": "mapping-id",
  "decidedAt": "2026-08-05T00:00:00Z"
}
```

API phải kiểm tra người duyệt trước khi ghi. Không coi việc ẩn nút trên giao diện là cơ chế phân quyền.

## Luồng dữ liệu

1. Apps Script dùng tài khoản chủ lớp đọc course/roster Classroom.
2. Backend dùng Metabase để đọc danh sách học viên ERP; query phải đi qua danh sách tham số được cho phép.
3. Thuật toán chạy cục bộ trong n8n tạo ứng viên, điểm tin cậy và lý do; không gửi tên/email học viên sang mô hình AI bên ngoài. Email ERP trùng chính xác email Classroom được ghi thẳng vào mapping `approved`, trừ khi xung đột với mapping đã duyệt trước đó.
4. Các trường hợp còn lại vào `mapping.student_mapping_review` với trạng thái `pending_review`; giảng viên duyệt trên GitHub Pages và backend mới ghi mapping chính thức.
5. Các workflow khác chỉ đọc mapping đã `approved`, không tự lấy lại tên để ghép lần nữa.

Sau khi duyệt, giảng viên có thể dùng `Sửa mapping` để chuyển sang một tài khoản khác trong roster hiện tại. `Mở lại duyệt` đưa phiếu về `pending_review` và tạm ngừng mapping chính thức. Tên/email hiển thị của cùng một Google ID được làm mới từ roster mỗi ngày, nên học viên chỉ đổi tên tài khoản thì không cần mapping lại.

## Quét thay đổi lớp

Mỗi ngày, workflow đọc toàn bộ lớp còn nằm trong view Lark được cấu hình, đối chiếu với trạng thái đăng ký ERP và roster Classroom, rồi ghi snapshot cùng sự kiện thay đổi vào PostgreSQL. Hệ thống ghi riêng các trường hợp học viên mới vào lớp, rời hoặc quay lại lớp, đổi tên/email Google, và thay đổi trạng thái đăng ký ERP. Một ca chuyển lớp được thể hiện thành hai sự kiện: rời lớp cũ và vào lớp mới. Lượt quét đầu của một lớp chỉ tạo mốc ban đầu để tránh cảnh báo hàng loạt; từ lượt sau mới phát hiện thành viên mới.
