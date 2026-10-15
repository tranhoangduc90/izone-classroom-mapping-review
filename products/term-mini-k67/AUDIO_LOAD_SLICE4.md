# K67 — kiểm tải và kết luận lát 4

Ngày 15/10/2026. **Chưa sẵn sàng phát hành; không thay production.** Đây là phép đo và chuẩn bị nghiệm thu, không phải chứng nhận khả năng chịu tải production.

## Lỗi cần xử lý trước phát hành

1. **P1 — start đã ghi nhưng trình duyệt nhận 500:** lượt chẩn đoán 120 người có 25 lỗi chờ kết nối PostgreSQL; đọc lại thấy chính 25 phiên đó đã bắt đầu nhưng không mở hold. Thời gian có thể trôi khi học viên chưa vào được màn hình nghe. Kết quả này nghiêm trọng hơn việc mở bài chậm; không dùng số 25 người đạt để bỏ qua lỗi mất ACK/5xx, vì lỗi đó có thể xảy ra ở tải thấp vì nguyên nhân khác.
2. **P1 — nhiều người chung Wi-Fi chạm quota:** 60 học viên cùng IP, 5 giây/progress và 15 giây/draft, có 120 progress bị HTTP429 `RATE_LIMITED`; cùng số người tách IP mô phỏng đạt. Giới hạn global 900/phút/IP đứng trước limiter audio 300/phút/session. Chưa kiểm việc mở incident đúng lúc quota đã cạn; không giả rằng limiter theo session luôn bảo đảm đường giữ bài.
3. **Rủi ro quay lui:** cờ cache tắt làm mất handshake cache cho phiên đang hoạt động. Cờ owner tắt vẫn giữ guard phiên đã có, nhưng điều đó không chứng minh tắt cả ba cờ là rollback đầy đủ. Phải theo [runbook](AUDIO_RELEASE_ROLLBACK.md).

Phạm vi công việc này giữ các lỗi trên **mở**, không âm thầm đổi quota, timeout, thời điểm tính giờ hoặc giao thức khởi động. Trước phát hành cần lát sửa riêng và regression tương ứng; chưa có bản sửa runtime hoặc GREEN cho hai lỗi tải.

## Môi trường và phương pháp

- Windows, Node 24.15.0, PostgreSQL native 16.15 trên 127.0.0.1:55468; role ứng dụng `k67_app`, pool 5, chờ pool 5 giây, statement timeout 15 giây như source cấu hình.
- Server là tiến trình riêng; client sinh tải ở tiến trình khác. Mỗi profile có DB giả mới, server/limiter mới; native helper giữ FK/history trigger/guard thật. Không dùng hàng đợi đơn connection của PGlite làm số đo công suất.
- Host có 8 logical CPU và khoảng 15,74 GiB RAM. **Không ép quota 0,5 CPU/256 MiB của cấu hình tham chiếu production**; Windows/local SSD/cache và loopback khác VPS/Wi-Fi/Nginx. Không suy 60 địa chỉ đạt thành công suất live 60 người.
- Mức 25/60/120 là thăm dò; nhóm lớp giả 25 người chỉ để chia dữ liệu. Chưa có số lớp thi đồng thời hoặc số người chung NAT được xác nhận từ lịch thi thật.
- Ba slug dùng đề/đáp án giả; asset 40 MiB giả, AES-GCM/manifest/SQL thật. Các IP 198.18.x là mô phỏng qua proxy tin cậy loopback, không giả có 120 thiết bị vật lý.
- Nhịp thật 65 giây: progress mỗi 5 giây, draft mỗi 15 giây; thêm nhóm nhập dày mỗi 5 giây, burst xác thực lại và burst 120 start. Không nén quota một phút thành một giây, không tắt limiter để có bảng xanh.
- Mỗi nhóm còn mở incident, thử nộp bị chặn đúng `AUDIO_INCIDENT_OPEN`, prepare/confirm, gửi lại confirm để kiểm không bù lặp, nộp và đọc lại nháp/revision/trạng thái nộp. Các ca này gọi HTTP thật; không chứng minh audio tới tai.

## Số đo chính

| Kịch bản | Số request | Kết quả | p95 start | p95 progress | Peak RSS server |
|---|---:|---|---:|---:|---:|
| 25 người chung IP, draft 15 giây | 530 | Đạt | 1.357 ms | 150 ms | 170 MiB |
| 25 người chung IP, draft 5 giây | 755 | Đạt | 1.517 ms | 88 ms | 161 MiB |
| 60 người chung IP | 1.272 | Không đạt: 120 HTTP429 progress | 3.642 ms | 178 ms | 181 MiB |
| 60 địa chỉ tách mô phỏng | 1.272 | Đạt request/readback; start chậm | 4.193 ms | 161 ms | 176 MiB |
| 60 xác thực lại đồng thời | 432 | Đạt; epoch cũ bị chặn | 3.667 ms | access p95 111 ms | 178 MiB |
| 120 start đồng thời và chạy tiếp phần đã mở | 2.042 | Không đạt: 30 HTTP500 start | 5.579 ms | 201 ms ở phần mở được | 217 MiB |

Hai lượt chẩn đoán burst 120 riêng ghi 30 rồi 25 lỗi `timeout exceeded when trying to connect`; số phụ thuộc lịch chạy, không gọi 30 là hằng số. Lượt có readback đầy đủ xác nhận 25 start đã commit nhưng client không ACK/không hold. Pool từng có 115 lượt chờ; event-loop p99 khoảng 18–33 ms, không có bằng chứng event loop bị đứng dài là nguyên nhân các lỗi này.

Phép đối chứng chỉ giảm asset giả từ 40 xuống 1 MiB, giữ 120 người/pool 5/source runtime: 120 start đều đạt, p95 khoảng 1.057 ms, không có lỗi pool/phiên chạy giờ chưa ACK. Điều này củng cố nguyên nhân công việc hash/file làm giữ pool lâu; **không phải bản sửa**, vì trường hợp 40 MiB vẫn lỗi và chưa kiểm một giải pháp trên cùng đầu vào đó.

Đã kiểm riêng lỗi commit → 500 trên **Chrome mở cửa sổ thật**: backend start thật đã commit rồi phản hồi bị đổi thành 500 ở biên mạng thử. UI còn khóa đề, DB đã có deadline nhưng không incident; học viên bấm lại thì phát được, recovery vẫn 0. Bằng chứng: `start-uncertain-headed.json` và ảnh lỗi trong kho riêng. Đây là hồi quy RED cần giữ cho lát sửa; không giả là đã có GREEN.

8 lượt tải lạnh 40 MiB đồng thời trong profile 120 trả đủ bytes, giải AES-GCM và hash plaintext đều đúng; p95 khoảng 2.248 ms trên loopback. Đây là kiểm 320 MiB dữ liệu giả/stream, **không phải tốc độ Wi-Fi**. Đợt 120 vẫn Không đạt, không bỏ 30 lỗi start khỏi tổng chỉ vì phần đã mở tiếp tục lưu/nộp được.

Đọc lại các nháp đã được ACK và phiên đã nộp đều khớp; confirm lặp không cộng thêm giờ. Những phiên start thất bại được đọc thêm riêng, không bị loại khỏi đánh giá an toàn bằng cách chỉ xét nhóm đã mở thành công.

## Nguyên nhân và hướng sửa sắp tới

- Quota global theo IP được thực thi trước tất cả route. Cần tách ngân sách control audio/giữ bài theo **phiên đã xác thực**, giữ giới hạn chống lạm dụng cho token sai và burst mạng chung. Không chỉ tăng hoặc bỏ global cap tùy ý; kiểm lại 60/120 người chung IP, invalid-token flood và đường incident lúc bị giới hạn.
- `pinAudioManifest` đọc/hash file trong transaction giữ connection; start còn có nhiều lượt lấy pool. Nhiều session mới cùng đọc 40 MiB làm đợi pool quá 5 giây. Cần giảm công việc file trong giao dịch/ghim manifest theo tài nguyên bất biến có version, giữ kiểm file đổi và quyền owner/generation; không tăng pool/timeout mù trên VPS còn tài nguyên chung.
- Start cần trạng thái khởi động an toàn **trước khi commit bắt đầu** hoặc cơ chế tương đương: mất phản hồi sau commit vẫn giữ bài/thời gian và có thể reconcile cùng phiên; chỉ mở làm bài sau phát/confirm hợp lệ. Regression phải gồm actual commit → 5xx/mất ACK → reload/retry → giữ mốc/nháp → bù một lần → nộp. Cần kiểm cả endpoint cũ và hai thứ tự; không chấp nhận chỉ làm nút Retry dễ bấm hơn.

Với file 40 MiB và đường truyền chia sẻ 100 Mbit/s, thời gian tối thiểu lý thuyết để tải đủ 25/60/120 bản lần lượt khoảng 84/201/403 giây, chưa có overhead. Cần tải trước có kiểm đủ file và sắp nhịp mở bài; cache chỉ giảm tải lại file, không thay quyền xác thực hoặc tự giải quyết lỗi start đã commit.

## Chạy lại local

Lệnh nhận cấu hình fixture cố định và tạo artifact trên E. Cần cluster local đúng role/port đã chuẩn bị; không sửa URL sang VPS để dùng runner. Khi gặp lỗi tải, runner trả exit 1 và giữ summary có `outcome=failed`; setup/guard lỗi trả exit 2. Không đổi các trạng thái đó thành pass.

```powershell
# Chỉ xác nhận PostgreSQL giả loopback; chạy bốn mức tải chính theo thời gian thực.
$env:K67_ORDER_NATIVE_URL = 'postgres://k67_fixture_admin@127.0.0.1:55468/postgres'
$env:K67_ORDER_NATIVE_CONFIRM = 'local-synthetic-20261014'
node tools/audio-load-local.mjs --output E:/Codex-Data/k67-audio-slice4-recheck
# Kiểm riêng nhập dày, reconnect và start burst có thống kê lỗi pool.
node tools/audio-load-local.mjs --extra --output E:/Codex-Data/k67-audio-slice4-extra-recheck
# Kiểm CLI từ chối đích ngoài local, thiếu xác nhận, ổ sai và preview quá dài.
node --test test/audio-load-safety.test.js
# Dump/restore DB giả mới, thay runtime tương thích và đọc lại phiên đến nộp; không chạm production.
node tools/audio-release-rehearsal-local.mjs --output E:/Codex-Data/k67-release-recheck --assets E:/Codex-Data/k67-audio-slice4-20261015/load-final/synthetic-assets --pg-bin E:/Codex-Data/k67-two-orders-official-20261014/postgres-local/pgsql/bin
```

4 native safety test đạt. Lượt đầu setup không chạy vì cluster local đang dừng; lượt smoke tiếp theo có kỳ vọng revision chưa tính đúng cách submit truyền revision. Giữ log cũ, sửa harness theo hợp đồng thật rồi mới lấy các số đo chính. Không tính hai lượt đó là lỗi sản phẩm hoặc lượt đạt.

Các test mới bảo vệ tải/quyền/thời gian/đích kết nối thật mà bộ tuần tự trước chưa đo. Dùng HTTP/SQL/crypto native và process riêng; không thêm export/hook vào runtime chỉ để test. Toàn bộ source runtime, DB migration và frontend sản phẩm giữ nguyên byte của lát 3. Chỉ tool, test và tài liệu đổi; không chạy lại toàn bộ 248 backend/168 Pages chỉ để lặp bằng chứng không bị tác động.

## Kiểm lại demo bằng browser đầy đủ

Chạy lại runner `tests/k67-exam-order-browser.mjs` của Pages bằng Chrome và Edge với `headless=false`, UI thật + backend fixture thật: ba slug × hai thứ tự × hai browser = 12 hành trình. Mỗi hành trình chọn/xác nhận tên, thử tiếng, nhập đáp án, báo lỗi, reload giữ đúng incident/nháp, thử tiếng–tiếp tục, kiểm bù, nộp L/R, nhập/nộp Writing nếu có, mở kết quả và reload kết quả. Đọc API kết quả có đúng `orderClientVersion=1`; không bỏ cổng giao thức để làm readback xanh.

Thêm một hành trình Chrome lớp giả IC2200 nghe hết 90 giây rồi nộp/xem kết quả: đạt. Tổng 13 hành trình chính đạt, cùng kiểm landing/kích thước/bàn phím/link. Một ca fault start nói trên vẫn RED; không gọi toàn bộ browser fault coverage xanh. Writing kiểm đến đã nộp/chờ chấm, không gọi AI/n8n hoặc ghi Portal.

Lượt headed đầu có lỗi harness readback thiếu `orderClientVersion` (UI đã đi hết), đã sửa request đúng như client thật và chạy lại cả sáu ca Chrome; log lỗi đầu giữ riêng. Ca fault đầu lấy biến bootstrap chưa khởi tạo cũng được giữ unknown riêng; bản chốt đọc token từ owner đã claim, chứng minh trạng thái thật. Không tính lỗi harness thành lỗi sản phẩm hoặc bằng chứng đạt.

```powershell
# Trong worktree Pages: đi hết sáu hành trình CBT bằng cửa sổ Chrome thật, kể cả hold/reload/phục hồi.
$env:K67_PREVIEW_URL = 'http://127.0.0.1:8899'
$env:K67_BROWSER_CHANNEL = 'chrome'
$env:K67_BROWSER_HEADED = 'true'
$env:K67_CBT_ONLY = 'true'
$env:K67_AUDIO_ACCEPTANCE = 'true'
$env:K67_ORDER_EVIDENCE_DIR = 'E:/Codex-Data/k67-headed-recheck'
node tests/k67-exam-order-browser.mjs
# Đổi browser sang msedge để chạy Edge; dùng fixture riêng để không reset dữ liệu giả của người đang thử.
```

Demo 8899 đã thêm roster **giả** IC2200 để đường thường mở khi xem demo có học viên chọn được; không chép danh sách lớp/học viên thật. Preview 8898 đã kiểm duration 1860 giây và một dòng tiêu đề ở 1440/390 khi phát/giữ; chưa nghe bằng tai hoặc chờ hết 31 phút trên phần cứng thật.

Raw JSON/log và runner thực đã chạy: [kho bằng chứng local](E:/Codex-Data/k67-audio-slice4-20261015/). Bộ [thiết bị thật](AUDIO_DEVICE_ACCEPTANCE.md) còn Chưa chạy; [phát hành/quay lui](AUDIO_RELEASE_ROLLBACK.md) là phương án, không là quyền hoặc biên nhận production.
