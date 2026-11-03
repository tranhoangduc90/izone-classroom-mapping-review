# Speaking: nguồn chưa ghép ERP vẫn có CTA

Theo yêu cầu Đức 03/11: giữ nguồn Classroom đầy đủ kể cả chưa ghép ERP, gắn CTA và mở màn chọn tên. Không tự duyệt mapping, không nhận chủ từ tên file. Nguồn chưa có chủ chỉ được pending và không work unit; sau khi mapping đến, CTA được xác minh lại. Chủ/tiến độ xung đột vẫn vào review.

Migration mới `ops/migrations/202611030102_speaking_unmatched_sources.sql`, nguồn chuẩn đồng bộ ở repo mapping-database. [Issue73](https://github.com/tranhoangduc90/izone-mapping-database/issues/73). Không đổi luồng ERP/auto-approval.

File cùng thư mục là exact overlay đang phát, giữ các sửa live chưa nằm trong canonical main, gồm read-only Docs, transaction runtime và phần còn lại của từng hàm. Không rebuild toàn main thay cho image live.

- Base image: `sha256:b098c8a995a81fb49eae28ff892246269315a6abdd9a4a6cd18c861437c261d6`.
- Sau chuyển: `sha256:a3bcdf5d2a6bb2ce0a65e80959c8b243549a117dffafd9add9bed202296bcb28`.
- Chỉ một file source đổi; config, env, mounts, networks và worker được so trước/sau.
- Backup: `speaking67-independent-api-before-cta-unmatched-20261103`; dump riêng trước migration đã kiểm archive list.

Kiểm: ca nguồn chưa ghép RED trên base; 37 backend ca cuối, 35 đạt/2 native skip. Canary worker=false trên PostgreSQL thật nhận 18 nguồn, 15 ghép/3 chưa ghép, verify ba CTA và replay 0 pending. Production event n8n `3140814` success; 18 CTA độc lập đọc lại; ba public `/assignment/open` có unmatched, 19 tên, không chọn sẵn. Không gọi start/check/finish thay học viên trong QA thật.

Rollback runtime bằng exact container cũ, giữ DB hiện tại. Không đặt lại NOT NULL khi còn nguồn chưa ghép, không xóa nguồn/bài làm để quay code. Bằng chứng private ở `E:/Codex-Data/ic2340-homework2-20261103/`, VPS `/opt/izone-cta-unmatched-20261103/`.
