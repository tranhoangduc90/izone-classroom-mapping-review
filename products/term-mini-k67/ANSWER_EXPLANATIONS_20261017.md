# Giải thích đáp án Term 1 và Mini Test khóa 67

Trạng thái: đã được Đức duyệt và phát hành backend/Pages ngày 17/10/2026; đã đọc lại route công khai và tám file Pages.

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

Đức đã chọn “Phát hành bản đã kiểm”, gồm tích hợp/push hai repo và triển khai backend K67 cùng Pages. Bản phát hành dựa trên image `sha256:488751a1015c4e84d9ff925875784e7b8846f23feff9f37db632a1f479e323aa`; `src/app.js` live khớp base sau chuẩn hóa xuống dòng, SHA byte live `fbbea427ac1723d3285ffc802cc48083b25cd5a6ab18cd2299af553a4937313e`.

Đã sao lưu cấu hình riêng bằng DPAPI và dump; không có lượt đang thi khi chuyển. Image mới `sha256:3a38f916280bf3babea68e714dca9c361b8400b89dbd6565367cce38a0d81bcb`; revision gói `a453be6d1a8b29f3dcd3564e37f312d67bb3e5a000c095532a2ac9ca7defa4b3`. Chỉ hai module thay; các module khác giữ byte. Container quay lại `term-mini-k67-api-before-k67-answer-explanations-20261017`. Chỉ đổi hai nhãn phiên bản env, giữ cấu hình audio/Writing và giới hạn tài nguyên.

Canary HTTP chỉ đọc trên image ứng viên và runtime mới đều đạt hai đề. Đường HTTPS công khai trả 40+40 và 20+13 mục, cache riêng và CORS đúng Pages; roster hai đề trả 200. Hash 16 bảng assessment trước/sau chuyển giống nhau. Không migration hoặc chấm/ghi lại điểm.

Pages PR [#117](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/117) đã merge tại `eee460443d9c01607eaa16bf156bfb8e103c7110`; Pages build `built`, tám file công khai khớp gói đã kiểm sau chuẩn hóa CRLF/LF.

Lượt kiểm toàn runtime ban đầu báo partial vì `mapping-review-api` được thay container/image bên ngoài các lệnh của gói này trong khoảng sao lưu–đối chiếu. Đọc lại thấy dịch vụ healthy, nguồn lớp/quyền K67 vẫn mới và roster trả 200. K56/n8n/Redis/context-sync giữ container/image/thời điểm chạy. Healthcheck context-sync có chuỗi lỗi cũ trỏ localhost:8796, trong khi dữ liệu thực tế vẫn cập nhật; không sửa dịch vụ đó trong task này. Không tuyên bố toàn hạ tầng giữ nguyên hoặc đã audit toàn bộ.

Quay lại image/container trước đó trên cùng DB và revision Pages trước gói này. Không restore database, không chấm hoặc gửi lại điểm. Chỉ kết luận production hoàn tất sau readback.
