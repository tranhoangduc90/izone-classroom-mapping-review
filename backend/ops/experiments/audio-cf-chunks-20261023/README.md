# Thử WebCrypto từng phần và dự phòng Pages

Thí nghiệm cách ly cho chặng 1–2 ngày 23/10/2026. Không được import hoặc mount gói này vào API học viên. Không có kết nối database, start/submit/reset, chấm bài hoặc ghi Portal. Các danh tính và ngữ cảnh đều là fixture. Bucket lab chỉ chứa file đã công khai và file giả.

## Phần đã xây

- `worker.mjs`: Worker lab đọc phần R2, kiểm HMAC/phạm vi, kiểm thu hồi lab rồi mã hóa AES-GCM bằng WebCrypto. Tuyến quản trị chỉ ghi đúng object trong catalog hoặc bản ghi thu hồi lab; có hạn đóng tuyến, không nhận URL/object key tùy ý.
- `protocol.mjs`: phạm vi khóa HKDF và AAD buộc product/class/test/owner/session/generation/purpose/asset/download/phần. Định dạng phần `IZAP1` khác IZTT1 nguyên file. Retry dùng IV ngẫu nhiên mới.
- `client.mjs`: Cloudflare ưu tiên, kiểm giải mã/hash rồi ghép Blob; lỗi nguồn mới dùng Pages, 401/403 dừng, ticket hết hạn chỉ gia hạn một lần dùng chung cho các phần song song. Cache Map trong lab chỉ dành cho MP3 đã công khai; chưa phải cache/quyền production.
- `lab-server.mjs`: fixture HTTP chỉ nghe `127.0.0.1:8898`, key gating và owner giả, không tạo bài học. Đọc `lab.html` từ thư mục bằng chứng riêng, không lưu/phát hành HTML mới trong repo backend. Chọn phần 512 KiB theo đo lab; không tự bắt đầu thi. Có nút phát file thử để kiểm player.
- `lab.test.mjs`: 30 nhóm kiểm public interface; giải mã bằng Node crypto độc lập, sai phạm vi, thu hồi cùng ticket, fallback, hủy, timeout, quota 429, body 200 bị cắt, hash/cache và Range dự phòng.
- `browser-check.mjs`: Chrome cách ly, thật sự tải từ Worker R2/Pages, chặn request riêng của browser để gây lỗi. Không dùng tài khoản học viên.
- `lab-catalog.mjs`: file công khai hoặc fixture, không có khóa/credential. File nghe chính lớn nhất 41.881.391 byte.

## Chạy lại an toàn

Bộ chuẩn bị và bằng chứng riêng ở `E:/Codex-Data/artifacts/r2-audio-migration-20261023/cloudflare-primary-stage12-20261023`; không đưa MP3, secret, raw snapshot hoặc cookie vào Git. Các runner private bên cạnh thư mục đó chuẩn bị file theo SHA, cấp ngữ cảnh giả, triển khai Worker lab và lọc trace trước ghi. Credential Wrangler dùng keyring đã có; không cần đưa OAuth token vào code.

Trước hết đặt `AUDIO_LAB_EVIDENCE_DIR` tới thư mục bằng chứng đã chuẩn bị. Lệnh `node --test lab.test.mjs` đọc MP3 fixture đã kiểm để xác minh đầy đủ giao thức; nếu thiếu đầu vào sẽ báo lỗi thay vì tự dùng kho học viên. `node lab-server.mjs` chỉ phục vụ localhost, kết thúc bằng Ctrl+C. `browser-check.mjs` cần `PLAYWRIGHT_MODULES` tới runtime Playwright có sẵn, rồi chạy bằng Node; kết quả/ảnh ghi vào thư mục bằng chứng riêng.

Đầu vào của các lệnh là source thử, file công khai và secret lab ngoài Git. Đầu ra là TAP/JSON, SHA, kết quả phát/nguồn tải và ảnh; khi HTTP/hash/quyền sai, runner dừng hoặc ghi ca thất bại, không sửa kỳ vọng cho qua. Không chạy lại script deploy/upload ngoài phạm vi tài nguyên thử đã được phép.

## Giới hạn phải giữ khi dùng kết quả

- Worker đang chạy `cf-chunks-lab-20261023-v2`; source/env thử có deadline 48 giờ. Không dùng tên/deadline/secret hay tuyến admin lab như cấu hình production.
- 512 KiB có CPU tốt hơn trong mẫu đã đo; không suy thành bảo đảm luôn dưới 10 ms hoặc mọi POP/tải đỉnh đều đạt. Trace không bao phủ mọi request client; chỉ tính CPU trên mẫu ghép được.
- Phần nhỏ tăng request. Kịch bản 400 thiết bị, file lớn nhất và hai lần tải có thể vượt 100.000 request/ngày ở 512 KiB; vẫn cần Pages dự phòng và quan sát quota, không tự nâng Paid.
- Thu hồi bằng R2 trong lab và cookie fixture không chứng minh native API đã kiểm người/lớp/owner/SSO/generation hoặc thu hồi production. Các adapter thật, TTL/cache/circuit breaker production và ma trận cả 12 bài thuộc chặng sau.
- MP3 Pages công khai. Mã hóa Cloudflare không bảo đảm bí mật khi file rõ vẫn là dự phòng.
- Không đổi content, nháp, điểm, đồng hồ, caller production hoặc phiên IZTT1. Không giả đạt nghe duyệt bằng tai hay thiết bị di động thật từ kiểm Chrome/metadata.

Xem báo cáo chặng 1–2 trong thư mục bằng chứng để biết revision, CPU, coverage, dữ liệu trước/sau, ngoại lệ phiên cũ và bước tiếp theo. Thí nghiệm chưa phải gói phát hành production.
