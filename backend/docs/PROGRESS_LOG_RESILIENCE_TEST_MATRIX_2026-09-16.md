# Ma trận kiểm thử chống chịu Progress Log — 16/09/2026

Phạm vi: phiên bản backend cùng nhánh với release IC2305 ngày 16/09/2026 và frontend Pages commit `212b09c`. Toàn bộ dữ liệu tự động là giả lập; kiểm thử trình duyệt chặn API thật. Không tạo bài làm, điểm danh hoặc thay đổi Portal production. “Đạt” ở đây chỉ có nghĩa ca đã thực sự chạy trên môi trường được ghi rõ; không suy ra mọi thiết bị, mọi tải và Portal thật đều đạt.

Kết quả lượt này: 144/144 ca backend hiện hành đạt ở lần chạy cuối; `npm run check` đạt. Frontend tĩnh đạt 7/7 và ba kịch bản trình duyệt (học viên, giảng viên, ghi nhớ người học) đều đạt. Ca tải 20 học viên là kết quả của lượt kiểm trước, không phải được chạy lại trong lượt này.

## Cách chạy lại

Trong thư mục `backend` của gói phát hành:

```powershell
$learningTests = Get-ChildItem -LiteralPath test -Filter 'learning-*.test.js' | ForEach-Object FullName
node --test $learningTests
```

Trong worktree Pages `E:/Codex-Projects/release-staging/progress-log-ui-20260916`, mở một terminal phục vụ file tĩnh rồi terminal khác chạy:

```powershell
http-server . -a 127.0.0.1 -p 4187 -c-1
node --test tests/progress-log-static.mjs
node tests/run-memory-browser.cjs tests/progress-log-resilience-ui.cjs http://127.0.0.1:4187/writing-handouts/config.json
node tests/run-memory-browser.cjs tests/progress-log-teacher-resilience-ui.cjs http://127.0.0.1:4187/writing-handouts/config.json
```

Browser fixture chỉ cho tải file từ localhost; mọi endpoint Learning và đăng nhập Google là giả lập. Nếu API lạ xuất hiện, ca sẽ thất bại thay vì truy cập production.

## Ca đã tự động hóa và chạy đạt

| Mã | Tình huống | Kết quả bắt buộc | Bằng chứng |
| --- | --- | --- | --- |
| I01 | Link thiếu/sai token; form chưa mở hoặc đóng | Không bắt đầu attempt, báo rõ lỗi | routes + UI |
| I02 | Hai học viên trùng tên, chọn đúng UUID | Bài và điểm danh chỉ gắn UUID được xác nhận | database + memory UI |
| I03 | Chưa xác nhận tên; hồ sơ tạm; đổi người; hai tab | Không tự mở bài hoặc đổi đích ghi dữ liệu | memory UI đã cập nhật fixture checkpoint |
| I04 | Người không thuộc roster; GV không có quyền lớp | Không đọc/ghi dữ liệu lớp khác | database |
| F01 | Definition, version/hash, đáp án riêng tư | Khóa version; public API không lộ đáp án | domain + database + static |
| F02 | Quiz 40 câu | Đủ response/grading item; transaction nộp có bốn lượt DB | database |
| F03 | Text, lựa chọn, chọn TWO, Writing pending, ô điền nhiều phần | Đúng contract chấm và completeness | domain + template |
| F04 | Writing 1: bốn câu có tám ô điền; text dài | Câu văn còn nguyên; ô nở theo nội dung; không tràn ngang mobile | static + browser |
| F05 | Trường lạ, ID câu sai, hash/revision sai, text quá dài | HTTP 400 trước khi truy vấn DB | routes |
| D01 | Draft cũ đến sau; cùng revision khác nội dung | Bị từ chối, không ghi đè bản mới | database |
| D02 | Autosave lỗi mạng; dữ liệu còn trong tab | Không mất nội dung, hiện lỗi thật | browser |
| D03 | Nhiều học viên dùng một IP | Quota start/draft phân theo học viên/attempt, không chặn chéo | routes |
| C01 | Phần chưa mở/đã đóng | Không nhận checkpoint mới | database + browser |
| C02 | Checkpoint gửi lại cùng khóa/nội dung sau khi phần đóng hoặc phiếu cuối đã nộp | Trả checkpoint đã lưu; không tạo bản trùng | database, đã phát hiện và sửa cục bộ |
| C03 | Cùng khóa checkpoint nhưng nội dung khác | HTTP 409, không sửa checkpoint cũ | database |
| C04 | Chỉ nộp checkpoint | Không tự điểm danh | database |
| S01 | Bài đủ; bài thiếu | Đủ được tự xác nhận; thiếu chờ GV; không phụ thuộc điểm AI | domain + database |
| S02 | Nộp lại cùng nội dung, kể cả submission ID mới | Trả biên nhận cũ; chỉ một submission | database |
| S03 | Nộp lại nội dung khác | Bị chặn; bản đã nộp bất biến | database |
| S04 | Lỗi HTTP lúc nộp trên màn học viên | Không hiện điểm danh giả; có thể thử lại | browser |
| S05 | 20 học viên nộp trong 60 giây và dồn 1 giây | 20/20 biên nhận, không sai người; Portal giả lập được xếp hàng | báo cáo tải riêng |
| T01 | Dashboard mở tab Theo dõi lớp trước; xem nháp/đã nộp | Đúng người và từng phần; không trả token attempt/đáp án kín | database + browser |
| T02 | Bản nháp thay đổi khi dashboard đang mở | Tự đọc lại trong chu kỳ 8 giây | browser |
| T03 | Giảng viên mở phần, đổi điểm danh có lý do | Đúng assignment, block, học viên và operation ID | database + browser |
| T04 | API override lỗi rồi thử lại | Dialog giữ dữ liệu; retry giữ cùng operation ID | browser |
| T05 | Nội dung học viên chứa HTML độc hại | Hiện như chữ, không thực thi | browser + static |
| P01 | Bài đủ tạo job Portal; bài thiếu không tạo | Không gọi Portal trong request nộp | database |
| P02 | Override “Có mặt” tạo một job; trạng thái khác không tạo | Job gắn attendance event đúng người | database |
| P03 | Payload hoặc phản hồi sai student/class/session/operation/key | Dừng fail-closed, không đánh dấu hoàn tất | attendance-sync |
| P04 | Portal trả 429/500/503, timeout, JSON lỗi | Phân loại rõ; job chờ retry, biên nhận bài vẫn tồn tại | attendance-sync + database |
| P05 | Portal báo already present hoặc conflict | Hoàn tất idempotent hoặc chuyển cần GV kiểm tra | attendance-sync |
| P06 | Retry sau 503 | Cùng job, đúng người, hoàn tất; dashboard đọc lại trạng thái | database |
| R01 | Báo cáo hệ thống và lời nhắn người thật | Không gán lời AI thành lời GV; khóa nguồn evidence | reports + domain |

## Ca còn cần môi trường/thiết bị riêng trước khi cam kết toàn trung tâm

| Mã | Ca phải làm | Điều kiện/tiêu chí nghiệm thu |
| --- | --- | --- |
| X01 | 20 ô điểm danh thật ghi Portal cùng phút | Lớp thử Portal có tài khoản giả và quyền dọn; đọc lại từng ô, xác nhận không ghi đè trạng thái đã có |
| X02 | 1.000 học viên cùng mở/autosave/nộp; 110 GV xem dashboard | Môi trường staging cùng cấu hình production dự kiến; đo p95, lỗi HTTP, pool, queue age và 0 sai định danh |
| X03 | Mất mạng, đổi Wi-Fi, refresh và hai tab trên điện thoại thật | Android/iOS phổ biến; kiểm khả năng khôi phục nháp và lỗi hiển thị rõ |
| X04 | Portal hoặc database mất kết nối lâu hơn lease/retry tối đa | Staging có fault injection; đối soát job chờ, job failed và quy trình xử lý thủ công |
| X05 | Backup/restore, migration từ schema production, roll-forward/rollback | Database thử clone đã khử định danh; readback đầy đủ submission, attendance, outbox |
| X06 | Trình duyệt bị đóng đúng lúc server lưu xong nhưng response mất | Replay đúng checkpoint/submission và không tạo job/điểm danh trùng trên PostgreSQL thật |
| X07 | Khả năng dùng bằng bàn phím, screen reader, phóng to 200–400% | QA thiết bị hỗ trợ tiếp cận; không chỉ dựa vào test DOM |

## Phát hiện và trạng thái

1. **Lỗi đã tái hiện và sửa trong source cục bộ:** retry checkpoint sau khi GV đóng phần bị trả `BLOCK_NOT_OPEN`, dù lần đầu đã lưu. Service nay tra bản nộp theo khóa chống trùng và so hash trước; chỉ checkpoint mới chịu điều kiện phần đang mở. Test chứng minh cả retry đúng và xung đột nội dung. Chưa phát hành bản sửa lên production.
2. **Bộ kiểm cũ bị lệch hành trình:** test ghi nhớ học viên chưa giả lập endpoint checkpoint, nên báo lỗi mạng giả khi giao diện nộp phần. Fixture đã được cập nhật và chạy lại đạt.
3. **Độ lệch source:** checkout backend phát triển cũ chưa có toàn bộ Portal attendance; ca mới được đặt trong nhánh release đúng phiên bản production. Cần đưa thay đổi trở lại nhánh phát triển theo quy trình review, tránh phát hành nhầm source cũ.
4. **Lệnh `npm test` quét cả test của gói lưu trữ:** một fixture trong `ops/releases/term-test-listening-retake-20260911` mặc định đường dẫn `/app`, chỉ chạy được trong container release cũ. Script test đã được giới hạn vào `test/*.test.js` để kiểm đúng bộ test hoạt động, giữ nguyên archive.
5. **Giới hạn kết luận:** bài tải 20 học viên trước đó dùng Portal giả 250 ms/request và 2 lỗi 503; chưa chứng minh Portal thật nhận 20 ghi cùng lúc. Hệ thống có thể trả biên nhận nhanh nhưng hàng đợi Portal vẫn cần giám sát đến khi từng job hoàn tất.

Nguồn đo tải trước đó: `docs/PROGRESS_LOG_LOAD_20_2026-09-16.md`. Không ghi tên, mã số hay câu trả lời thật của học viên trong báo cáo này.
