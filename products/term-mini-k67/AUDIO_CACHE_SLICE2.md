# K67 — quyền phục hồi audio đã lưu

Đã xây và kiểm local, chưa đưa lên production. Lát này kế thừa `AUDIO_INCIDENT_SLICE1.md`, thêm lưu ciphertext qua reload và xác thực lại online; không thêm service worker, quyền thi offline hay khóa dài hạn trong trình duyệt.

## Cấu hình và dữ liệu

`K67_AUDIO_CACHE_ENABLED=false` là mặc định. Bản nghiệm thu mới bật đồng thời `K67_AUDIO_INCIDENT_ENABLED=true` và `K67_AUDIO_CACHE_ENABLED=true` để dùng đủ giữ bài/bù giờ/cache. Chưa thay env hoặc database production.

Migration `db/011-audio-asset-pin.sql` thêm `listening_audio_manifest` JSONB vào session và lý do `reload` vào sự cố. Không sửa migration 010, không đổi bản ghi đã nộp. Áp dụng trong database K67 riêng trước khi bật cờ; migration có giao dịch và giới hạn chờ khóa.

Manifest ghim lần đầu theo session: version bằng SHA-256 nội dung, hash, số byte rõ/mã hóa và envelope `IZTT1`. Không lưu khóa hoặc file rõ trong database. Mỗi download có IV ngẫu nhiên riêng; checksum ciphertext của lần tải khác không được dùng làm chuẩn nội dung.

POST `/api/term-tests/:testSlug/session/audio-access` nhận `examSessionToken` và `generation` bắt buộc. API khóa session, lấy thời gian sau khóa, kiểm slug/generation, superseded/submitted, bài giấy, bound attempt và thứ tự Reading trước. Session chưa bound vẫn giữ hạn chuẩn bị 8 giờ; bound Reading trước giữ chính sách hiện hành. Thành công trả manifest, cache expiry 24 giờ từ server và trạng thái/mốc hiện tại; chỉ phiên Listening đã start còn quyền mới nhận khóa. Response `no-store, private`.

`authorizeAudioSession` cũng bảo vệ `/session/start` cũ khi bật cache, kể cả client bỏ `audioProtocolVersion`. Đã nộp không lấy khóa lại qua endpoint cũ. Sai quyền trả `409 AUDIO_ACCESS_LOCKED`; input thiếu/sai generation của audio-access trả 400. API metadata không đóng sự cố hoặc cộng bù.

Giữ manifest cũ khi file cùng slug bị thay. Nếu còn ciphertext đúng bản ghim, có thể xác thực và giải mã bản đó. Nếu cần tải lại nhưng file server đã đổi thì trả `409 AUDIO_ASSET_CHANGED`; không gán file mới vào phiên cũ. Khi file đổi đúng giữa kiểm hash và streaming, client vẫn buộc so hash plaintext trước phát và từ chối nếu khác.

Hash/mã hóa đọc theo luồng; `write(false)` chờ drain, đóng/lỗi kết nối dừng source/cipher. Guard kiểm response trước/sau await ngăn mở luồng cho client đã rời. Hash đang chạy có thể đọc nốt hữu hạn trước khi trả về; chưa có hủy hash tức thì.

## Kiểm và vận hành

```powershell
# Kiểm quyền/pin/crypto thật với dữ liệu giả; mặc định dùng PostgreSQL nhúng.
node --test test/audio-access.test.js test/term-test-assets.test.js
```

14 ca trong hai file đạt. Có thể dùng fixture native theo hướng dẫn lát 1; không trỏ test vào database production. Toàn backend có 239 ca đạt qua các nhóm không trùng: 204 core, 23 database, 8 integration, 4 live HTTP/server. Native dùng PostgreSQL 16 tại localhost và role thử thật. Lượt cuối đã chụp hash nguồn trước/sau không đổi; log cũ trước sửa streaming giữ riêng.

Review độc lập đã đóng hai P1: đường start cũ cấp khóa sau nộp; client ngắt trong lúc hash làm treo luồng chờ drain. Có RED/GREEN và kiểm lại bằng HTTP/SQL/stream thật hoặc fixture phù hợp. Không sửa tính năng K56, không gọi n8n/Portal production.

Trước phát hành sau này: đối chiếu lại nền, áp 011, bật hai cờ trong runtime K67 được phép, chuyển backend trước frontend và kiểm canary. Bật/tắt feature giữa phiên cần giữ handler/schema và quyền phiên đang hoạt động. Quay lui an toàn là ngừng nhận tính năng mới, giữ bản server hiểu manifest/sự cố cho tới khi xử lý hết phiên; không xóa schema/cache hàng loạt.

Giới hạn còn lại: single-tab/device owner, nghiệm thu trình duyệt/profile/extension/phần cứng, bài đề thật trọn 30 phút và tải cao đồng thời. Không suy 239 ca local thành bảo đảm production hoặc mọi thiết bị đã đạt.
