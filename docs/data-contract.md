# Hợp đồng dữ liệu cho API duyệt mapping

Tài liệu này mô tả dữ liệu giao diện cần. API trung gian có thể được viết bằng Apps Script, n8n hoặc một dịch vụ nhỏ khác; giao diện không gọi thẳng Metabase/PostgreSQL.

## Tải hàng chờ

`GET /api/mapping/reviews?class_id=<erp_course_class_id>&status=pending_review`

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
      "status": "pending_review"
    }
  ]
}
```

`erpStudentId` là mã kỹ thuật ổn định dùng để nối với ERP. Không suy ra tên học viên từ email khi chưa có quyết định của giảng viên.

## Ghi quyết định

`POST /api/mapping/reviews/<review_id>/decision`

Request:

```json
{
  "decision": "approve",
  "note": "Đã xác nhận với học viên tại lớp."
}
```

Giá trị `decision` là `approve`, `reject` hoặc `choose_another`. Với `choose_another`, request cần thêm `classroomUserId` của ứng viên mới.

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
3. AI tạo ứng viên, điểm tin cậy và lý do; ứng viên vào `mapping_review_queue` với trạng thái `pending_review`.
4. Giảng viên duyệt trên GitHub Pages; backend ghi mapping chính thức và lịch sử quyết định vào PostgreSQL.
5. Các workflow khác chỉ đọc mapping đã `approved`, không tự lấy lại tên để ghép lần nữa.
