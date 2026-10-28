# Speaking: ba lỗi nền và kiểm Portal

Ba lỗi đã tái hiện trên `f1f2b73`: CTA ôn tập Lesson 9 rơi về Lesson 3; source legacy Docs trong Git từ chối ô đã có nội dung dù bản đang phát hành đã sửa vùng trạng thái bằng revision; fixture how-to thêm câu bịa sau bốn câu hợp lệ nên vẫn đủ ngưỡng đạt.

- Bổ sung route Lesson 9, giữ các route Lesson 2–15 đã có.
- Nhập lại đúng planner legacy Docs từ image đang phát hành: giới hạn đúng ô, giữ newline cấu trúc, khóa revision, sửa link receipt và no-op khi nội dung/link đã đúng. Luồng Docs tiến độ có kiểm manual conflict vẫn thuộc planner riêng.
- Fixture how-to thay một câu hợp lệ bằng dẫn chứng bịa, kiểm thiếu câu và đúng stage count; ca bổ sung xác nhận thêm dẫn chứng bịa không tăng số câu và không làm mất câu hợp lệ.

RED: 22 ca, ba lỗi đúng ba triệu chứng. GREEN tập trung: 23/23. Bộ Speaking: 257 ca, 255 qua, không lỗi, hai ca dành cho fixture PostgreSQL riêng không được chạy trong nhóm PGlite này. `npm run check` và `git diff --check` qua.

## Portal đầu cuối bằng dữ liệu giả

`test/learning-portal-http-readback.test.js` bổ sung đường checkpoint trống bằng role ứng dụng → attendance event → outbox → worker → HTTP thật qua loopback → mã xác thực/quyết định/readback của workflow → bảng Portal giả được lưu trong PostgreSQL → kết quả job. Ca ghi mới, mất ACK sau ghi rồi retry và xung đột có sẵn kiểm việc chỉ ghi đúng người/buổi, giữ homework/note và không tăng event/job khi retry. Không gọi Portal production trong fixture.

Chạy cùng fixture native hiện có, chỉ dùng database thử riêng ở `127.0.0.1:16547/progress_log_fixture` qua `PROGRESS_LOG_FIXTURE_URL`. Runner dùng database ngắn hạn và role `learning_api`; không dùng URL production.

```powershell
node --test --test-concurrency=1 test/learning-checkpoint-portal-contract.test.js test/learning-early-attendance-postgres.test.js test/learning-portal-http-readback.test.js
```

13/13 qua trên nguồn trích từ exact image shared đang chạy và workflow live đã khóa đúng ID/host. Bao gồm 20 học viên đồng thời, rollback thiếu quyền, replay, quyết định GV trước/trong khi gửi, mất phản hồi, đọc lại và không ghi trùng. Với snapshot canonical, cùng runner có thể chạy lại bằng database fixture.

Nguồn runtime/workflow và dữ liệu đối chiếu production nằm riêng trên máy vận hành, không đưa vào Git. Phép thử loopback chứng minh đường nghiệp vụ trước và sau HTTP, không tự chứng minh n8n production hoặc Portal thật đã ghi. Kết luận production phải dựa thêm readback nhánh chỉ đọc của đúng workflow đang vận hành và đúng identity/target, tách khỏi kết quả fixture. Không tự nộp/chấm, replay job lịch sử hoặc ghi điểm danh thật để tạo bằng chứng.

Hai sửa đổi hành vi Lesson 9 và planner legacy đã có trong runtime trước task này; lượt này đồng bộ lại nguồn Git. Không rebuild/restart API chỉ để đồng bộ Git, không sửa workflow production, không backfill Docs/Portal.
