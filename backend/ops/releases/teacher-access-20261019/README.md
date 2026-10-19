# Giảng viên xem bản đã lưu từ link giao bài

## Phạm vi

Speaking Homework K67, Reading/Listening thực chiến, Term/Mini 56–67 và Làm quen K67 có thêm đường đọc tiến trình trước khi nộp. Handout Writing và Progress Log dùng dashboard giảng viên sẵn có, chỉ nối lối vào/ngữ cảnh ở frontend. Substitute có backend trong repository chung, phát hành riêng.

Giữ tự đăng nhập, đổi người, nháp, đồng hồ, phòng chờ, các lượt cũ và mọi đường nộp/chấm/ghi Docs/Portal của học viên. Đường giảng viên dùng Google + quyền lớp phía máy chủ; không dùng bộ nhớ danh tính học viên để cấp quyền. Đường đọc không tạo phiên hoặc cập nhật đồng hồ học viên, không trả token thao tác hoặc audio.

## Phần ghép theo runtime

| Container hiện hành | Tệp được bổ sung/thay khi ghép |
| --- | --- |
| `mapping-review-api` | `speaking-homework-routes.js`, `speaking-legacy-teacher-progress.js` |
| `speaking67-independent-api` | `speaking-independent-server.js`, `speaking-teacher-progress.js` |
| `izone-reading-practice67` | `app.js`, `service.js`, `teacher-progress.js` của Reading |
| `izone-listening-practice67` | `app.js`, `service.js`, `teacher-progress.js` của Listening |
| `term-mini-k67-api` | App ghép bằng `patch-k67-app.mjs`, `teacher-saved-progress.js`, `readiness-teacher.js` |
| `izone-k56-ic2264-api` | App ghép bằng `patch-k56-app.mjs`, `k56-teacher-saved-progress.js` |

Các helper nhận tệp nguồn live và một đường đích mới. Chúng kiểm hash đã ghim rồi chỉ thêm import/route; nguồn đổi hoặc đích tồn tại thì báo lỗi. Không tự gửi file lên VPS hoặc phát hành. Không dùng toàn bộ app Git để đè các thay đổi live chưa có trong Git.

K56 dùng `assessment_k56` và guard riêng; hai helper `assessment-schema-pool.js`, `teacher-session-scope.js` trong gói được đối chiếu byte với live để test đúng semantics. Không đưa helper/role K67 sang K56. Giữ toàn bộ phần Speaking fairness/lease recovery và bộ gộp context Listening đang chạy.

## Kiểm đã có và giới hạn

- Đường đọc có test SQL/HTTP: chưa nộp, chưa mở, hai thứ tự thi, nhiều lượt/revision, mất quyền/hết phiên, dữ liệu không đổi và không lộ khóa học viên.
- Renderer có test browser: A/B và phản hồi muộn, reload, lỗi mạng rồi hồi phục, mobile, bốn trạng thái Speaking, link cá nhân 0/nhiều lượt và đề R/L đúng cấu trúc hiện hành. Browser dùng Google/API giả.
- PostgreSQL 16.15 cục bộ: 100 học viên giả + 10 cửa sổ giảng viên cho Speaking/R/L/Làm quen và từng Term/Mini K67. Đây không phải đo sức chịu tải VPS. K56 mới là 100 người ghi nháp SQL + giảng viên đọc HTTP; không gọi là toàn hành trình HTTP học viên.
- Có kiểm riêng trên cây ứng viên ghép từ live, gồm cookie giảng viên 90 ngày của API chung. Còn phải kiểm cấu hình image, Google/HTTPS và readback production sau phát hành.

Các test tải chỉ nhận URL loopback và xác nhận fixture riêng. Không đặt URL production vào các biến môi trường fixture, không kiểm tải production và không tải audio thật. Dùng lại biên nhận không bị tác động, chỉ chạy phần thiếu; không cộng các suite trùng thành một suite mới.

## Thứ tự phát hành và quay lại

1. Đối chiếu live source/image với snapshot, cấu hình/mount/mạng và đích điểm danh của API chung. Ghim image cũ làm đường lui.
2. Build từ image live cộng các tệp đã kiểm; kiểm đúng hash toàn cây JS và chỉ thay tệp trong bảng. Chạy kiểm trong image với mạng bị ngắt.
3. Chuyển từng backend, giữ cấu hình runtime và dữ liệu. Readback health, CORS/quyền, cookie và nguồn thực chạy trước nhóm kế tiếp.
4. Phát hành frontend sau khi backend tương ứng sẵn sàng; dùng hồ sơ thử riêng để kiểm đường đọc, so bài/nháp/giờ/hàng việc trước–sau. Không gọi AI, audio hoặc ghi Docs/Portal để tạo bằng chứng giả.
5. Nếu lỗi: quay lại image/giao diện của đúng sản phẩm, giữ database/lượt mới nguyên trạng. Không rollback dữ liệu học viên.

API chung phải giữ `LEARNING_ENABLED`, `LEARNING_DATABASE_URL`, `LEARNING_ATTENDANCE_SYNC_URL`, `ERP_SYNC_SECRET`, consumer `sync_portal_attendance` và guard cấu hình. Chưa có outcome Portal đọc lại được thì ghi rõ `deployed_awaiting_validation`; health tốt không thay bằng chứng điểm danh. Không in secret hoặc ghi dữ liệu học viên vào gói Git.
