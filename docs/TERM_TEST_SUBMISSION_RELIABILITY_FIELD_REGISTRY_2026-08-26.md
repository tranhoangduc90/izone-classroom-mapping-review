# Đăng ký trường: độ tin cậy khi nộp Term Test

Phạm vi: bản sửa local/dev ngày 26/08/2026. Chưa cấp quyền chạy migration hoặc phát hành production.

## `reading_draft_revision`

| Mục | Nội dung |
| --- | --- |
| Tên nghiệp vụ | Phiên bản bản lưu Reading |
| Bảng/schema | `assessment.term_test_attempt` |
| Vấn đề | Ngăn request autosave cũ đến muộn ghi đè bản mới. |
| Nguồn chuẩn/chủ ghi | API Term Test; trình duyệt gửi số tăng dần, database chỉ nhận số mới hơn. |
| Người đọc | API lưu nháp, nộp bài và nối lại lượt đang dở. |
| Khóa nối | Không phải identity; tuyệt đối không dùng để join học viên/lượt thi. |
| Kiểu/default | `BIGINT NOT NULL DEFAULT 0`; dòng cũ bắt đầu từ 0. |
| Dữ liệu riêng tư | Metadata kỹ thuật, không chứa đáp án hay danh tính; không xuất Lark/AI. |
| Retention/index | Đi cùng vòng đời lượt thi; không tạo index riêng. |
| Tương thích | Client cũ vẫn nộp bài được; autosave thiếu revision bị từ chối để không ghi đè bản mới. |
| Kiểm thử/readback | Gửi revision 3 rồi 2; revision 2 phải bị từ chối và draft giữ nguyên. |
| Rollback | Tắt consumer mới; forward-fix bằng migration mới, không sửa migration đã chạy. |

## `listening_draft_revision`

Giống hợp đồng trên, nhưng thuộc `assessment.term_test_exam_session` và bảo vệ autosave Listening.

## `superseded_at`

| Mục | Nội dung |
| --- | --- |
| Tên nghiệp vụ | Thời điểm lượt trùng được thay thế |
| Bảng/schema | `assessment.term_test_attempt` |
| Vấn đề | Giữ lịch sử nhưng loại các lượt đang dở bị tạo trùng khỏi luồng tiếp tục bài. |
| Nguồn chuẩn/chủ ghi | Migration chuẩn hóa dữ liệu cũ; API chỉ tạo một lượt active nhờ unique index. |
| Người đọc | API tìm/nối lại lượt, lưu nháp và hoàn tất Reading. |
| Khóa nối | Không phải identity; identity vẫn là test/version/class/student. |
| Kiểu/default | `TIMESTAMPTZ NULL`; `NULL` nghĩa là lượt còn hiệu lực. |
| Dữ liệu riêng tư | Metadata vận hành; không xuất Lark/log/AI. |
| Retention | Giữ cùng lượt thi để audit; không xóa bài hay đáp án. |
| Index | Partial unique index trên test/version/class/student khi chưa hoàn tất và chưa bị thay thế. |
| Backfill | Với nhóm trùng, giữ lượt có tiến độ Reading mới nhất; đánh dấu các lượt còn lại. |
| Tương thích | Lượt hoàn tất và API đọc kết quả cũ không đổi. |
| Kiểm thử/readback | Hai mã gửi cho cùng học viên phải trả cùng attempt; chỉ một lượt active. |
| Rollback | Tắt lookup/constraint mới; forward-fix bằng migration mới nếu cần. |

Trường cùng tên trên `assessment.term_test_exam_session` áp dụng hợp đồng tương tự cho phiên Listening: giữ phiên có draft/tiến độ mới nhất, đánh dấu phiên chuẩn bị trùng và cho phép máy khác nối đúng phiên trong 8 giờ. Partial unique index dùng test/version/class/student khi Listening chưa nộp; trường này không phải identity và không được xuất ra Lark/log/AI.
