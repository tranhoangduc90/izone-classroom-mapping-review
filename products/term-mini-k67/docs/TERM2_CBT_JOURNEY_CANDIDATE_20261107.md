# Term 2 K67 CBT offline candidate (07/11/2026)

Candidate này dựa trên Term 1 API `1106272` và Pages `978624b`; chưa nhập main hoặc bật production.

| Hợp đồng | Term 1 | Term 2 |
|---|---|---|
| `slug` và version | `term-test-1`, `term1-k67-cbt-journey-v1` | `term-test-2`, `term2-k67-cbt-journey-v1` |
| Kho trình duyệt | `izone-term1-k67-journey-v1` | `izone-term2-k67-journey-v1` |
| Listening và rà bài | 1.735 + 120 giây | 1.844 + 120 giây |
| Reading / Writing | 60 / 40 phút | 60 / 60 phút |
| Writing | Chỉ Task 2 | Task 1 và Task 2, giữ nguyên nội dung đã nhập |
| Thứ tự | Listening trước hoặc Reading trước | Cả hai thứ tự |
| Chấm bài trắng | Quy tắc native `blank_rule` | Cùng quy tắc native; mỗi Task trống nhận 0, không dispatch AI cho Task đó |
| Audio | SHA riêng, signed R2 khi có cấu hình, Pages fallback | SHA `656921…219e`, 22.119.070 byte, catalog R2 512 KiB riêng, Pages fallback |

API Term 2 chỉ mount khi `K67_TERM2_CBT_JOURNEY_MODE=on` hoặc `drain`; mặc định `off`. Migration 024 mở guard của bảng journey cho Term 2 và giữ Term 1. R2 chỉ ký khi có config riêng `K67_TERM2_R2_CONFIG_FILE` chứa đúng SHA và object; không lấy khóa vào source hoặc bản export. Quyền học viên gắn với lượt/lớp, generation, device proof và permit HMAC. Mỗi phần có operation ID, receipt và lần retry đồng nhất. Browser lưu audio đã xác minh, đề, nháp, đồng hồ và hàng đợi trong IndexedDB riêng; tải bài HTML không chứa permit/device proof.

Kiểm ngắn: SQL/API Term 1+Term 2 hai thứ tự 4/4; browser Term 2 hai thứ tự gồm mất mạng, reload, EOF, Writing hai Task, tải HTML và sync receipt 2/2. Hai ca audio thật và đủ giờ đã xếp chạy nền; chỉ coi gate đủ giờ đạt khi từng log kết thúc `passed`. R2 browser riêng cần xác nhận tải và hash qua config candidate; cấu hình/kiểm chỉ dùng local.

Trước khi bật Term 2 cần ghép EOF guard của native Term 1 vào nền candidate này, kiểm chống tự thu sớm trên đúng route native, kiểm full-time hai thứ tự và R2/Pages fallback, đối chiếu đề/key và quyền lớp thật, rồi triển khai migration 024 + Pages/API cùng phiên bản. Không bật Term 2 chỉ nhờ ca ngắn.
