# Giải thích đáp án Term 1 và Mini Test khóa 67

Trạng thái: đã xây và kiểm local; chưa phát hành backend/Pages.

## Phạm vi

- Term Test 1: Reading 1–40 và Listening 1–40, Cambridge 16 Test 1.
- Mini Test buổi 5: Reading 14–26, Listening 11–30, Cambridge 20 Test 3. Nguồn Reading và từng phần Listening được ghép riêng, không suy từ tên Term/Mini.
- Bốn trang học viên: Term 1 và Mini, bản nhập đáp án giấy và bản computer-based.
- Dùng bố cục cửa sổ của Reading/Listening thực chiến 67: bài đọc hoặc trích transcript bên trái; đáp án, bài làm, đối chiếu màu và lời giải bên phải; chuyển câu, Escape, nút đóng và trả focus.
- Giữ lời giải phương án sai và trích dẫn nguồn. Câu chọn hai đáp án dùng chung lời giải, giữ kết quả chấm từng câu theo thứ tự bài làm.

Listening hiện dùng **trích transcript từ Docs**, chưa có căn thời gian/nút nghe lại từng đoạn như ứng dụng Listening thực chiến. Không gán thời gian nghe ước lượng.

## Dữ liệu và quyền xem

`src/answer-explanations.js` thêm POST `/api/term-tests/result/explanations`. Nhận mã lượt thi, chỉ SELECT lượt đã hoàn thành L/R; Term cần đã nộp Writing hoặc là phiếu `writing_scope=lr_only`. Mini không yêu cầu Writing. Không gọi chấm lại, AI hoặc ghi Portal.

Đọc `<K67_ASSET_DIR>/<testSlug>/explanations.json` ngoài Git và trả `Cache-Control: no-store, private`. Gói chứa định danh nguồn Docs/tab/bảng/dòng và từng mục theo kỹ năng/số câu. Không trả gói trong roster, phòng chờ hoặc API đề.

Trước khi trả, kiểm slug, phiên bản định nghĩa, SHA-256 của **byte đề gốc**, hash định nghĩa đáp án, số câu, đáp án từng câu, phần chứa câu và nội dung lời giải. File thiếu báo chưa sẵn sàng; lệch phiên bản báo 409; không gửi gói không khớp. File snapshot được định dạng lại có thể khác hash dù JSON giống nhau: builder phải nhận file đề gốc đã tải nguyên byte.

`tools/build-answer-explanations.mjs` nhận bốn đối số: thư mục cache Docs riêng, thư mục xuất riêng, file định nghĩa đề đã đọc lại, thư mục đề gốc theo slug. Công cụ xuất hai gói riêng tư cùng nội dung đề dùng để kiểm local. Không đưa đầu ra vào repo/public Pages. Thiếu nguồn hoặc không tìm đủ câu/dẫn chứng thì công cụ báo lỗi.

Frontend mới ở `term-tests/k67-shared/answer-explanations.js` và `.css` trong repo Pages. `shared/app.js` gọi module tùy chọn sau dựng bảng kết quả; chỉ bốn trang nêu trên nạp module. Bootstrap dùng chung chỉ đổi mã phiên bản tải app. Các consumer khác không có module nên giữ hành vi cũ.

## Nguồn đã đối chiếu

| Phần | Google Docs |
|---|---|
| Term 1, cả hai kỹ năng | [Tổng hợp giải đề Cam 16 – Finalized](https://docs.google.com/document/d/1NhUDePQZ8XXlSDexD2GLFPFbiz22XH8hK7S8COLQDn0/edit) |
| Mini Reading | [GD20 – Coral reefs](https://docs.google.com/document/d/1EK0UQOS3J5JDk2uwmhGbsJjDLfWjrDo0B80AkpriZI0/edit) |
| Mini Listening Part 2 | [GD16 – Community archaeology](https://docs.google.com/document/d/12nxXb6ngqVu9Uy6KPQfQ99W81HIa1EO2dQEub1ayH6I/edit) |
| Mini Listening Part 3 | [GD17 – Theatre programmes](https://docs.google.com/document/d/1pX0_7JTU7ng38P1L7t4GXV9juqQOKVFSdQc69H1-Y7I/edit) |

## Kiểm chứng local

- Đối chiếu đủ 113 câu với đề và đáp án hiện hành, bao gồm spelling variants và nhóm hai đáp án không xét thứ tự. Giữ nội dung và màu văn bản nguồn; kiểm cả các dòng câu hỏi bị ngắt đoạn trong Docs.
- 43 ca liên quan đạt, không skip: API lời giải/SQL PGlite thật, tài nguyên/audio, chấm Term/Mini, quyền giảng viên/xem lại và stream kết quả.
- Ca API mới kiểm mã sai/lượt không tồn tại, chưa nộp đủ, phiếu L/R, Mini không Writing, Term 2 ngoài phạm vi, thiếu file, đổi slug/version/hash/đáp án/phần/số câu.
- Browser dùng màn kết quả thật và bài làm giả: mở đủ 113 câu, so đầy đủ văn bản lời giải với dữ liệu nguồn, đúng đáp án và trạng thái, chỉ tải một lần mỗi lượt; chuyển câu, đóng/Escape/trả focus, retry sau 503. Hai đề đạt trên desktop 1440×1000 và mobile 375×812; không lỗi JavaScript/CSP hoặc tràn khung.
- Bộ test Writing trắng có sẵn: 12 ca lỗi fixture SQL `42P10`, tái hiện khi nạp nguyên `app.js` từ base. Không coi đây là lỗi runtime đã xác minh hoặc lỗi do module này. Stream từng lỗi timing khi chạy song song, đạt khi chạy tuần tự. Chưa chạy toàn bộ suite cần HTTP/database fixture ngoài phạm vi.

Chứng cứ và gói nội dung riêng: `E:/Codex-Data/term-mini67-explanations-20261017/`. Không chứa hồ sơ học viên thật trong các fixture trình duyệt.

## Phát hành và quay lại

Chưa có chấp thuận thay production cho gói này. Chuẩn bị dựa trên image live `sha256:488751a1015c4e84d9ff925875784e7b8846f23feff9f37db632a1f479e323aa`; `src/app.js` live khớp base sau chuẩn hóa xuống dòng, SHA byte live `fbbea427ac1723d3285ffc802cc48083b25cd5a6ab18cd2299af553a4937313e`.

Sau khi được phép: kiểm lại runtime/active exams, sao lưu runtime và file đích riêng; tạo image trên đúng image live với chỉ `app.js` và module mới; thêm hai gói vào asset riêng; kiểm route local/candidate trước khi chuyển. Không migration, không đổi DB/Redis/n8n/API chung/K56. Giữ nguyên cấu hình audio, Writing và tài nguyên container. Pages phát hành gói giao diện sau khi route backend sẵn sàng. Đọc lại đủ câu và quan sát màn kết quả qua Pages.

Quay lại image/container trước đó trên cùng DB và revision Pages trước gói này. Không restore database, không chấm hoặc gửi lại điểm. Chỉ kết luận production hoàn tất sau readback.
