# Speaking Lesson 11 — overlay hẹp trên runtime hiện hành

Đã triển khai ngày 25/10/2026 sau xác nhận của Đức: image `sha256:fa6cc5d1bdf6393b076aa9a1bcd39f6249c8c3c698f853529067789482aab455`, dịch vụ `speaking67-independent-api`. Base live `sha256:05a55461ef47a7f7e360cd31d75baaec520ec76974e0199288515a347ded1798`. Không rebuild toàn main: source main chưa chứa đủ overlay đang chạy.

Ba module: `speaking-story-detail-checker.js` mới; `speaking-checker.js` chỉ thêm import/dispatch `story_detail`; `speaking-classroom-copies.js` chỉ thêm ánh xạ mã Lesson 11. Mọi module cũ khác, OAuth mount đọc Docs, biến môi trường, mạng và quyền dữ liệu phải giữ từ container live đã đối chiếu. Không chuyển API chung/Progress Log hay broker đăng nhập.

Một lượt Diễn biến chi tiết gồm bốn bước cơ bản và bốn bước ghép/phát triển chuỗi năm nhịp trong cùng chủ đề. AI tìm dẫn chứng, máy chủ kiểm nguyên văn/vai trò/thứ tự; lỗi AI giữ chưa xác minh. Kế thừa chính sách chatbot xác nhận hoàn thành toàn bài, snapshot Doctor và chống trùng hiện hành. Không bắt đề mới, thử thách 90 giây hay voice.

Kiểm riêng tư: `E:/Codex-Data/speaking67-lesson11-20261025/`. Các test mới bảo vệ dispatch và dẫn chứng tám bước; service PostgreSQL kiểm bốn phần/receipt/Doctor; CTA kiểm URL độc lập, đúng Doc/lớp/mã và retry. Browser dùng API giả, không chứng minh AI/Docs/Classroom người thật.

Image có 29/29 ca checker kể chuyện và CTA đạt. Đã clone/đọc lại đầy đủ source/config/OAuth mount/network; mọi dịch vụ khác giữ ID/image. API public và catalogue/ledger đã đọc lại đúng Lesson 11, chín bài cũ không đổi. Hai test file cũ còn 10 lỗi fixture/hợp đồng AI đã được tái hiện giống nhau trên exact source live và candidate; không gọi full suite xanh. Browser 30 hành trình Lesson 2–11 với API giả đạt; AI/Docs/Classroom của học viên thật chưa kiểm.

Giữ container `speaking67-independent-api-before-speaking11-20261025` để quay lại, cùng snapshot ở `/opt/backups/speaking11-20261025/independent/`. Giữ bài/receipt mới; không restore database cũ. Catalogue, registry n8n và Pages có trạng thái phát hành riêng.
