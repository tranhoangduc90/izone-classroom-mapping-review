# Listening R2 direct · 07/11/2026

Phạm vi: 5 Listening Homework và 3 Listening thực chiến trong catalog ngày phát hành. Giữ Term/Mini/Substitute, timer, chấm bài, Docs và nháp. Backend cấp descriptor optional sau quyền native; client cũ và lượt thực chiến cũ giữ đường cũ. Lượt mới ghi `audioDeliveryPolicy=r2-direct-v1` trong state JSON hiện có, không migration.

## Cấu hình riêng từng runtime

`AUDIO_R2_DIRECT_ENABLED=true`, `AUDIO_R2_DIRECT_CONFIG_FILE=/run/audio-r2/config.json`. Mount directory read-only. Config private có `enabled`, SHA `assets`, `accountId`, `bucket`, `accessKeyId`, `secretAccessKey`. Mỗi sản phẩm dùng một khóa Object Read only, đúng bucket, không cấp khóa cho client. Config bắt đầu `enabled:false`, allowlist rỗng. Ghi file atomic; giữ UID đọc của container (node/1000). Không đưa config/inspect/dump vào Git.

Client opt-in bằng `X-Izone-Audio-Transport: r2-direct-v1`. GET ký 600 giây, đúng key đã ghim trong catalog (cả `cf-chunks-lab/` và `public-audio/`). CORS chỉ origin Pages, GET/HEAD, Range, expose Content-Length/Content-Range/Accept-Ranges/ETag, max-age 600. Bucket vẫn private.

Tải một GET, xác minh block 512 KiB để giữ prefix và toàn file trước Blob. IDB 128 MiB/24 giờ; IDB lỗi chuyển RAM. Idle 15 giây, tổng 120 giây, tối đa 3 GET, renew native một lần. Native từ chối dừng; lỗi nguồn có thể về đúng public Pages/cùng hash. Cache byte không thay quyền. Không chuyển bearer/cookie tới R2/Pages.

## Bằng chứng trước rollout

Artifact riêng: `E:/Codex-Data/listening-r2-direct-20261107/`. 8 file × R2/Pages đúng hash/byte; decoder và seek cuối file; 27 lượt xen kẽ ba nguồn cùng Chrome, cache byte trống; Slow 4G mô phỏng; 30 lượt giả đồng thời, một Pages fallback. Không dùng tài khoản/bài nộp học viên thật.

Trung vị ms, n=3 mỗi ô (gồm tải/xác minh; không coi là độ trễ mạng học viên):

| File | Chia mảnh hiện hành | R2 | Pages |
|---|---:|---:|---:|
| Paper 0,52 MB | 410 | 399 | 371 |
| Scandinavian 10,34 MB | 1486 | 625 | 731 |
| C21 full 25,84 MB | 3029 | 998 | 1148 |

Slow 4G Natural dyes: legacy 18,79 s (có phần được Pages cứu), R2 11,11 s, Pages 12,31 s. 30 tải giả hoàn tất trong 4,63 s; không phải load test production hay cam kết một lớp thực.

Native Homework 21/21, thực chiến 34/34, chạy lại trên source live đã ghép đúng overlay journal/optimization. Browser Homework state: 8/8 (Scandinavian/Origami × desktop/mobile viewport × HV/GV, ba nhịp nền). Review legacy và direct: mỗi chế độ 11/11; ca hidden native chạy riêng, không tính viewport là iPhone/Safari vật lý. Có native UI → R2 thật ở hai engine, Pause/Resume/reload cùng lượt, và IDB prefix qua reload thật.

## Phát hành và quay lui

VPS `/opt/izone-listening-r2-direct-20261107/operator.py` giữ exact Docker Config/HostConfig/network/mount của từng nền live, thêm đúng overlay và directory private. Dùng lại image hiện hành; không rebuild toàn main làm mất journal. `private/*-before.json`, `*-before.dump`, `*-data-before.json` là backup riêng trên VPS. `*-create.json` và `*-after.json` là cấu hình operator có thể đọc lại, không chỉ thay env tạm.

Thứ tự: backend tương thích/cờ tắt → Pages → Scandinavian → 4 Homework còn lại → lượt mới thực chiến 8 → 10 → C21 full. Mỗi bước kiểm health, quyền từ chối, config/source/hash; đối soát hash bảng nghiệp vụ trước/sau. Không tạo/nộp lượt thật để canary.

Tắt riêng nhóm bằng `operator.py flag homework '[]'` hoặc `flag practice '[]'`; giữ cùng asset, lịch sử và dữ liệu mới. Không thu hồi khóa/CORS đang phục vụ tab mở để quay code. Nếu phải quay container: dừng container mới, đổi tên bảo toàn, trả tên container `*-before-r2-20261107` và start; không restore database. Đọc receipt trước thao tác và kiểm drift nếu có phát hành sau.

Trạng thái production và các giới hạn thực tế được ghi trong `ROLLOUT.md` sau readback; số đo/unit test không tự chứng minh đã phát hành. Chưa có bằng chứng iPhone/Safari vật lý hoặc lượt học tự nhiên thì báo riêng.
