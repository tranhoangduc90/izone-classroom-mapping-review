# Hợp đồng dữ liệu cho API duyệt mapping

Tài liệu này mô tả dữ liệu giao diện cần. API chạy trong container riêng, không chiếm execution của n8n; giao diện không gọi thẳng Metabase/PostgreSQL.

## Xác thực

Production dùng Google Sign-In. Trình duyệt gửi Google ID token qua header `Authorization: Bearer <token>`; token chỉ giữ trong bộ nhớ tab. Backend xác minh chữ ký, audience, email đã xác thực, rồi kiểm tra email và quyền lớp trong PostgreSQL. Giảng viên có thể dùng tài khoản Google thuộc bất kỳ tên miền nào.

Header `x-review-token` chỉ tồn tại trong chế độ `legacy` ngắn hạn khi chuyển từ API n8n sang API độc lập.

## Tải hàng chờ

`GET /api/mapping/reviews?class_id=<erp_course_class_id>&status=pending_review`

Request phải có Google ID token hợp lệ và tài khoản được cấp quyền cho lớp đang đọc.

Response tối thiểu:

```json
{
  "ok": true,
  "items": [
    {
      "id": "review-uuid-khong-tuan-tu",
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
  "note": "Đã xác nhận với học viên tại lớp."
}
```

Giá trị `decision` là `approve`, `reject`, `choose_another`, `edit_mapping` hoặc `reopen`. Với `choose_another` và `edit_mapping`, request cần thêm `classroomUserId` của ứng viên mới. API lấy danh tính người duyệt từ token, chỉ chấp nhận tài khoản còn nằm trong roster hiện tại của đúng lớp và từ chối nếu Google ID đã gắn cho học viên ERP khác.

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

## Answer sheet Term Test

Các trang GitHub Pages giữ nguyên query `?class=<MÃ_LỚP>` và gọi API công khai theo thứ tự:

1. `GET /api/term-tests/roster?class=<MÃ_LỚP>&test=term-test-1` để lấy tên học viên và UUID ngẫu nhiên. Nếu lớp/test có roster riêng trong `assessment.term_test_roster`, API dùng đúng roster đó; nếu chưa có, API tự lấy học viên không bị supersede từ matching database. Response không chứa ID ERP, email hoặc đáp án.
2. Riêng bản computer-based Term Test 2 gọi `POST /api/term-tests/term-test-2/session/prepare`, tải audio mã hóa và bản nghe thử 30 giây. Response ở bước này chưa có đề hoặc khóa giải mã.
3. `POST /api/term-tests/term-test-2/session/start` ghi thời điểm bắt đầu/deadline Listening trên máy chủ rồi mới trả đề, khóa audio riêng của phiên và thời lượng chính thức. Audio kéo dài 30 phút 44 giây, sau đó có 2 phút kiểm tra; hết hạn tự khóa và thu bài.
4. `POST /api/term-tests/<test-slug>/listening/draft` lưu đáp án trước hạn; `POST /api/term-tests/<test-slug>/listening` chấm Listening độc lập và đồng bộ Band Listening lên Portal. Sau hạn, máy chủ chỉ dùng bản nháp cuối cùng đã nhận trước hạn.
5. `POST /api/term-tests/<test-slug>/reading/start` tạo deadline 60 phút; endpoint `reading/draft` lưu nháp trước hạn và endpoint `reading` chấm/đồng bộ Reading. Sau hạn, máy chủ không nhận thay đổi mới.
6. `POST /api/term-tests/writing` với `attemptToken`, hành động `start`/`draft`/`submit` và nguyên văn hai Task. Deadline 60 phút do máy chủ tạo; bài sau hạn hoặc đã `submit` không thể bị payload gửi lại ghi đè.
7. `POST /api/term-tests/result` với `attemptToken` để mở đúng kết quả và đọc lại hai bài Writing của lượt làm đó. Kết quả chỉ mở sau khi Writing đã nộp hoặc tự thu.
8. `POST /api/term-tests/term-test-2/session/resume-attempt` nối các lượt đã nộp Listening trên giao diện cũ vào giao diện mới mà không tạo lại điểm hoặc khởi động thêm Listening.

`attemptToken` và bản dự phòng cục bộ được giữ trong bộ nhớ trình duyệt của máy đang thi để đóng tab rồi mở lại vẫn tiếp tục được. Nháp Listening, Reading và hai bài Writing đồng thời được lưu trong PostgreSQL; deadline luôn tính bằng giờ máy chủ. Dashboard công khai và luồng xuất Lark/Portal không đọc nguyên văn bài viết. Định nghĩa đáp án nằm trong PostgreSQL production; đề/audio computer-based nằm trong thư mục riêng chỉ mount vào container, không nằm trên GitHub Pages. API áp dụng CORS, giới hạn tần suất, UUID không tuần tự và không ghi payload học viên vào log lỗi.

### Dashboard giảng viên

Trang giảng viên bắt buộc gửi Google ID token trong header `Authorization` và chỉ đọc các lớp có trong `mapping.reviewer_class_access` của tài khoản đó:

1. `GET /api/term-tests/teacher/options` trả danh sách lớp được phép xem và Term Test đang hoạt động.
2. `GET /api/term-tests/teacher/results?class=<MÃ_LỚP>&test=<MÃ_BÀI>` trả toàn bộ roster. Mỗi học viên có trạng thái `completed`, `incomplete` hoặc `not_started`; học viên đã hoàn thành có `combined_result` mới nhất để dựng tổng quan và màn hình cá nhân.

Response không chứa ID ERP, email hay `attemptToken`. Học viên chưa hoàn thành không được trả đáp án hoặc điểm tạm thời.

## Quét thay đổi lớp

Mỗi ngày, workflow đọc toàn bộ lớp còn nằm trong view Lark được cấu hình, đối chiếu với trạng thái đăng ký ERP và roster Classroom, rồi ghi snapshot cùng sự kiện thay đổi vào PostgreSQL. Hệ thống ghi riêng các trường hợp học viên mới vào lớp, rời hoặc quay lại lớp, đổi tên/email Google, và thay đổi trạng thái đăng ký ERP. Một ca chuyển lớp được thể hiện thành hai sự kiện: rời lớp cũ và vào lớp mới. Lượt quét đầu của một lớp chỉ tạo mốc ban đầu để tránh cảnh báo hàng loạt; từ lượt sau mới phát hiện thành viên mới.
