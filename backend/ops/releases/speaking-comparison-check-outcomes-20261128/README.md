# Lý do kiểm bài Speaking So sánh

Hai bản vá áp dụng riêng cho Speaking độc lập và tuyến cũ của Mapping API. Bộ xử lý đang dùng một mã chung khi không nhận được mã lý do từ bộ kiểm. Sau thay đổi, bộ xử lý nhận được các mã sau.

| Lý do | Mã |
| --- | --- |
| Bản chụp hội thoại sai cấu trúc | SHARE_SNAPSHOT_INVALID |
| Kết quả bộ kiểm sai cấu trúc | AI_CHECK_RESULT_INVALID |
| Kết quả có độ chắc dưới ngưỡng hiện hành | AI_CHECK_OUTCOME_UNCERTAIN |
| Dẫn chứng sai nội dung, vai trò hoặc thứ tự | AI_EVIDENCE_INVALID |

Ngưỡng, cách đếm câu hỏi khác nhau, phần có hướng dẫn/tự do và quy tắc 3+3 giữ theo tệp đang phục vụ. Kết quả đã xác minh còn thiếu vẫn đi theo luồng hướng dẫn hiện hành. Các lỗi trên dùng luồng xử lý lỗi kỹ thuật đã có. Mã lỗi từ nguồn đọc hoặc AI như AI_HTTP_429 tiếp tục được truyền theo quy tắc hiện hành.

| Tệp vá | SHA-256 nguồn đang phục vụ | SHA-256 ứng viên |
| --- | --- | --- |
| speaking67-independent-api.patch | ffff3825d148946396b0105d6cba38a4f21ffff795c8f678d7f33d937e4adaa3 | 991715dc778d4be89ddd464a98a7db08296445baefc113ff29ef1b4f72e45b36 |
| mapping-review-api.patch | 5cce9184694cb0fcb35c9d2f03f7b55ac27de9e868484583e9a2c7d20ff9d00a | b3dea05855daa0b3a6276c24b84518c04f9c8fec73cff09092c98c4b767adcb9 |

## Kiểm và quay lui

- Chuẩn bị backend đúng revision, đặt hai bản nguồn đối chứng cạnh các module backend với tên speaking-comparison-checker.independent-fixture.js và speaking-comparison-checker.legacy-fixture.js. Hướng SPEAKING_FIXTURE_BACKEND tới thư mục backend đó. Chạy comparison-outcomes.test.mjs bằng Node 24 trong lab cô lập. Dữ liệu giả 3+3 gồm câu hỏi, trả lời, giải thích và góp ý. Không cần gọi AI hoặc Google.
- Trên hai tệp trước sửa, ca phân loại lỗi thất bại ở cả hai tuyến, còn ca 3+3 và ca còn thiếu thật đều đạt. Trên hai ứng viên, 8 ca mới và 28 ca liên quan đạt tại lab VPS2, lượt codexdev-root-cef72b8c-7818-49bc-a291-412a0bf10c02.
- Chỉ áp dụng bản vá trên bản sao của tệp có SHA-256 trước sửa khớp bảng. Kiểm git apply --check, đối chiếu SHA-256 ứng viên, chuẩn bị bản sao nguyên gốc và giữ mọi lớp chồng cấu hình hiện hành khi đổi phiên bản. Xác minh trước/sau ở mỗi dịch vụ riêng.
- Nếu phiên bản hoặc bài kiểm đổi, trả module về đúng tệp trước sửa đã lưu rồi kiểm tình trạng dịch vụ và dấu vân tay. Các bản vá chỉ đổi mã xử lý. Dữ liệu, hàng việc, biên nhận và các bản ghi đã lưu giữ theo phiên bản đang có.
