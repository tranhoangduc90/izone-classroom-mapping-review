# Hợp đồng định danh hàng chấm Writing

| Thành phần | Giá trị và quy tắc |
| --- | --- |
| Bản ghi nguồn | `assessment.term_test_writing_grading_job.id` (`jobId`) |
| Bài chấm | `assessment.term_test_writing_grading_run.run_key` (`runKey`), duy nhất cho attempt + task + phiên bản chấm |
| Bên nhận | Một execution webhook n8n, dùng ID execution làm `workerId` |
| Lực lượng | Một execution nhận tối đa một job; toàn hệ thống giữ tối đa bốn lease còn hiệu lực |
| Khóa nối | `job.worker_id = workerId`; mọi complete/fail phải khớp cả `jobId` và `workerId` |
| Chống trùng | Unique `runKey`/idempotency ở database; job đã hoàn tất trả duplicate, không chấm lại |
| Thứ tự | Ưu tiên `collect` để trả suất sớm, rồi theo `next_attempt_at`, `created_at` |
| Bản ghi bị loại | Job chưa đến hạn hoặc khi đủ bốn suất vẫn giữ nguyên `queued`/`retry_wait`; không bị bỏ |
| Lỗi thông báo | Không rollback bài/job đã commit; hẹn lại 30 giây và quét dự phòng năm phút |
| Dữ liệu riêng tư | Envelope webhook không chứa bài, token, tên, email hoặc ID học viên |

Nếu bất kỳ lớp định danh nào không khớp, API dừng fail-closed và workflow không được chốt job thay cho execution khác.
