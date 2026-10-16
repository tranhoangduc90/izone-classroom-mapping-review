# Writing trắng và phiếu dự phòng — 17/10/2026

Nguồn hiện hành cho Term Test 1/2 khóa 67, đủ `lis_first` và `read_first`. Đọc tài liệu này trước snapshot [khôi phục Writing trước đó](WRITING_RESULT_RELEASE_20261017.md). Không dùng lại luật ưu tiên mọi bài có nội dung: bài **chính thức** mới nhất có thể hợp lệ ở Band 0.

## Hành vi

- Task bắt buộc đã được máy chủ xác nhận nộp, nội dung chỉ rỗng/khoảng trắng: ghi 0 theo `blank-writing-v1`, lưu nguồn và thời điểm nộp, hoàn tất chấm tại backend. Không gửi AI, không tạo bốn nhận xét tiêu chí giả.
- Bản đang làm chưa được chốt không nhận 0. Thu hết giờ dùng nội dung canonical đã lưu, không lấy payload rỗng đến muộn để thay bài.
- Term 1 chỉ Task 2: điểm Writing bằng Task 2, Task 1 không tham gia. Term 2 tính `(Task 1 + 2 × Task 2) / 3`, giữ quy tắc làm tròn hiện có; Task trắng vẫn tham gia với 0.
- `writing_scope=exam` là bài thi; `lr_only` là phiếu chỉ nhập L/R. Phiếu L/R bị chặn lưu/chấm Writing và liên kết lượt chính bằng `writing_source_attempt_id`. Hai luồng thứ tự dùng cùng bất biến. Tổng quan và chi tiết giảng viên cùng chọn bài chính thức đã nộp mới nhất.
- Giữ nguyên các bài đã chấm trước đợt này, kể cả bài trắng lịch sử. Chỉ phân loại đúng một phiếu dự phòng đã điều tra; không chạy cập nhật hàng loạt.
- Bài toàn trắng tạo một việc gửi điểm bền vững trong hàng hiện có. Backend xử lý việc này nội bộ khi cấp việc, không trả sang AI; lỗi gửi điểm được thử lại. Bài có một Task trắng chờ AI của Task còn lại rồi tổng hợp như trước.
- Số 0 được giữ qua API, giao diện và gói Portal. Writer Portal hiện hành đọc lại đúng học viên/cột Phase và bảo vệ điểm chính thức đã có. Nếu đích có điểm khác, không ghi đè; việc gửi điểm báo lỗi/thử lại để kiểm tra.

## Bản production đã đối chiếu

| Thành phần | Giá trị |
|---|---|
| Runtime / database | `term-mini-k67-api` / `term_mini_k67` |
| App version | `k67-blank-writing-zero-20261017` |
| Image | `sha256:488751a1015c4e84d9ff925875784e7b8846f23feff9f37db632a1f479e323aa` |
| Image nền | `sha256:674229a76d9b90a07404150cfd5bfdb30a8da8046b267c74f71e1e99f72cff3e` |
| `K67_BUILD_SHA` | `f926008c649cc1e602eda13103c77a17dbb12fe6cdc400c5a878134ab7efd2e6` — hash gói năm module |
| Module thay | `app.js`, `exam-order.js`, `sql.js`, `term-test-writing-grading.js`, `term-test-writing-notifier.js` |
| Migration | `db/017-writing-scope.sql`, bổ sung hai cột; không thay bài/điểm |
| Quay lui runtime | Container `term-mini-k67-api-before-k67-blank-writing-zero-20261017` trên cùng DB hiện hành |

Các module nguồn khác khớp từng byte image nền. Chỉ hai nhãn phiên bản env đổi; mount, cờ audio, giới hạn tài nguyên và cấu hình còn lại giữ nguyên. API chung, K56, n8n, Redis và context sync không đổi container/image/thời điểm chạy. Source có thêm hai cột trong schema dựng mới; kho đang chạy dùng migration 017 trước khi chuyển runtime.

Không restore dump vào kho đã có bài mới. Khi quay runtime, vẫn giữ hai cột tương thích ngược và bản ghi hiện hành; bản nền cũ có luật lựa chọn Writing khác, cần kiểm lại hiển thị. Không quay về ảnh trước thay đổi MP3 Pages.

## Bằng chứng và giới hạn

- 12 ca lỗi hành vi RED trên base; sau sửa 80 ca tập trung GREEN, gồm đủ bốn tổ hợp, bài trắng, retry điểm 0, Task hỗn hợp, nháp, thu hết giờ giữ bài đã lưu, phiếu L/R và chọn bài chính thức mới nhất. Không tính lần fixture khởi tạo thiếu constraint là RED.
- Full backend ghép đủ 349 ca: 80 tập trung + 234 core + 23 database/quyền + 8 HTTP integration + 4 HTTP runtime, không skip. Nhóm core bị giới hạn thời gian sau 158 ca đạt; chạy phần còn thiếu 76 ca, không chạy/đếm lại 158 ca đó. Fixture queue cũ dùng endpoint L/R đã được sửa để tạo đúng bài thi chính thức, rồi 23 ca database đạt.
- Canary HTTP production dùng bốn lượt giả, đủ hai Term × hai thứ tự: đã nộp nhận 0, đúng Task cần có, không tạo dispatch AI; notifier và bước cấp việc thực sự hoàn tất việc gửi điểm nội bộ. Lớp thử `CODEXDEMO806` bỏ qua Portal, bốn lượt được đóng sau kiểm và giữ lịch sử.
- SQL nền/ứng viên/production so 544 kết quả trên 33 tổ hợp lớp–test, tất cả hiển thị giữ nguyên. Bài gốc, toàn bộ bài chấm 6.0 và số từ của lượt cần khôi phục khớp; L/R và lịch sử Portal giữ nguyên. Sau migration, hash toàn bộ dữ liệu cũ của 16 bảng khớp khi bỏ đúng hai cột mới. Ngay sau chuyển runtime, cả 16 bảng khớp nguyên trạng.
- Pages: sáu ca browser mới đạt, phủ bốn hành trình học viên và hai trang chi tiết giảng viên. Đã chạy toàn bộ inventory Term Test; các lỗi fixture khởi động và timeout khi chạy song song được giữ log rồi kiểm lại đúng nhóm lỗi. 47 ca sự cố âm thanh và ca chủ tab còn lỗi đều đạt khi kiểm lại; luồng K56 dùng chung cũng đạt.
- Chạy nguyên hai Code node lập kế hoạch/đọc lại của writer Portal live với dữ liệu giả: 32 kiểm tra, số 0 đúng, thiếu điểm/khác học viên bị từ chối, điểm 6 hiện có được bảo vệ. Không ghi thử số 0 vào hồ sơ học viên thật; không thay workflow n8n. Đăng nhập Google giảng viên được mô phỏng trong browser fixture, chưa kiểm lại bằng tài khoản thật.

Chứng cứ riêng tư: `E:/Codex-Data/k67-blank-writing-zero-20261017/` (backup DPAPI/dump, hash, TAP, snapshot SQL/Portal, canary và log lỗi). Không đưa hồ sơ học viên hoặc khóa truy cập vào Git. Hai lần dựng dữ liệu canary đầu bị constraint chặn trước INSERT vì thiếu thời điểm cập nhật Writing; fixture đã sửa rồi bốn ca HTTP đạt. Không coi các lần lỗi đó là đạt.
