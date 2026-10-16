# Bài làm quen K67: nghiệm thu thiết bị, bật thử và quay lui

Trạng thái ngày 16/10/2026: chuẩn bị và thử trên máy local, **chưa phát hành**. Tài liệu này không cấp quyền production. Các kết quả tải nằm trong hồ sơ riêng; không đưa danh tính, token, khóa hoặc bài thi thật vào Git.

## Phạm vi và điều phải giữ

- Chỉ trang `/term-tests/lam-quen-k67/` và API `/api/k67-readiness/v1`. Không sửa phòng chờ, điều kiện mở, đồng hồ hoặc audio của bài thi thật.
- Nội dung Listening/Reading/Writing làm quen riêng. Chỉ dùng lớp/người giả khi kiểm kỹ thuật; không tải đề thi thật để làm đối chứng.
- Đăng nhập chọn tên và ghi nhớ như Term Test hiện có; không bổ sung cơ chế đăng nhập khác.
- Nút Kiểm thiết bị, lưu/nộp và điều khiển giữ cùng một hàng tiêu đề. Màn nhỏ cuộn bên trong hàng, không kéo rộng toàn trang.
- Học viên xác nhận nghe; web không chứng nhận mute Windows/tab, driver, app gọi/họp hoặc extension. Hỗ trợ qua chat/trực tiếp; không có yêu cầu gửi tự động.
- Reading/Writing tùy chọn; chưa thử giữ “Chưa thử”. Kết quả làm quen không trở thành điều kiện thi thật. Không có ca Windows Sleep theo lựa chọn đã chốt.

## Kiểm tải có thể lặp lại

Runner `tools/readiness-load-local.mjs` chỉ cho kết nối cluster giả `127.0.0.1:55468`, tài khoản fixture và xác nhận riêng; tự tạo/xóa đúng database ngẫu nhiên của lượt kiểm. Không SSH, không dịch vụ ngoài. Không chạy nó với URL production. Cần khởi động cluster fixture đã chuẩn bị trước; runner không cài PostgreSQL hay tạo cluster.

Ví dụ PowerShell trong thư mục sản phẩm:

```powershell
# Nhận cluster local có dữ liệu giả; tạo báo cáo trên E:, không dùng cấu hình thật.
$env:K67_ORDER_NATIVE_URL='postgres://k67_fixture_admin@127.0.0.1:55468/postgres'
$env:K67_ORDER_NATIVE_CONFIRM='local-synthetic-20261014'
$env:K67_LOAD_PAGES='E:/wt/k67-audio-hold-slice1-20261015/pages'
node tools/readiness-load-local.mjs --users 60 --output 'E:/Codex-Data/k67-readiness-load/60'
```

Lệnh tạo 60 học viên giả có định danh riêng, tải/giải mã/kiểm hash audio cho từng người, tải mẫu MP3, lưu 5 giây/lần, báo cáo đủ 13 mục 15 giây/lần, xác thực lại giữa bài, nộp Listening và Reading/Writing. Sau đó gây ngập bằng token lạ để kiểm hạn mức IP vẫn cho phiên hợp lệ đọc bài. Mỗi bước đọc lại đáp án/revision/trạng thái nộp; bản nháp cũ và nộp lặp không tạo dữ liệu sai. Lỗi được giữ trong `load-failure.json` hoặc `load-result.json`, exit khác 0, không đổi limiter để làm xanh. Không có tai nghe nên các client HTTP ghi `heardConfirmed=false` dù mô phỏng mốc phát; đây không phải kết quả nghe thật.

Đổi `--users 120` để kiểm mức tiếp theo, hoặc `--users 3 --smoke` cho lượt nhanh. Hai mức 60/120 là kịch bản thăm dò, chưa phải số học viên đồng thời đã được chốt. Khi cần browser trong lượt tải, `--browser-runner` nhận đường dẫn script Chrome/Edge đã duyệt và `--browser-output` là tên đầu ra mà script đó hiểu; runner tải không tự cài Playwright hay trình duyệt.

Server và client nằm ở hai tiến trình, cùng IP loopback thật; không giả X-Forwarded-For. Pool sản phẩm tối đa 5, chờ connection 5 giây, statement 15 giây; nguồn context giả làm mới 30 giây/lần. Báo cáo có p50/p95/p99, mã HTTP, timeout, bộ nhớ/CPU/độ trễ vòng lặp và hàng chờ pool. Không ghi raw token/audio key. DB fixture/setup có kết nối riêng ngoài pool sản phẩm; không suy số connection toàn PostgreSQL từ giá trị pool này.

Điều đạt về tính đúng: mọi phiên và file đúng người, không mất nháp, không sinh phiên/nộp trùng, không có lỗi HTTP ngoài dự kiến, không có lượt/bài nộp thi thật. HTTP 409 chặn sửa sau nộp và 401/429 của token lạ là phản hồi dự kiến, không phải lỗi tải. Ghi riêng mọi cảnh báo độ trễ trên 2,5 giây; ngưỡng này là ngưỡng báo chú ý của giao diện, không phải SLA đã đo trên lớp.

Máy Windows không bị giới hạn CPU/RAM như máy chủ, không có Nginx/TLS/Wi-Fi. Vì vậy kết quả local **không chứng minh sức chứa production hoặc mạng lớp**. Chỉ đo thêm trên môi trường thử được phép khi cần xác nhận cấu hình triển khai. Không tự gây tải lên server thật.

## Nghiệm thu Windows với tai nghe thật

Người chạy điền: ngày/giờ, mã máy, Windows, phiên bản Chrome/Edge, hồ sơ thường/riêng, loại tai nghe (3,5 mm/USB/Bluetooth), đầu ra Windows, Wi-Fi/LAN và số người cùng mạng. Không cần tên thiết bị chi tiết, ảnh người học, mật khẩu hoặc danh sách app.

Chạy toàn bộ nhóm A trên **cả Chrome và Edge** với hồ sơ thường; chạy lại hành trình cơ bản và ca nghi extension trên hồ sơ riêng không extension. Không tự tắt extension quản lý hoặc công cụ trợ năng. Kết quả hồ sơ sạch không thay bằng chứng của hồ sơ học viên thật. Dùng đúng máy/tai nghe dự định thi, âm lượng an toàn; mở link demo local trên máy này hoặc bản thử HTTPS được cấp quyền sau. Localhost trên một máy không phải link chia sẻ cho điện thoại/máy khác.

| Mã | Thao tác người nghiệm thu | Kết quả cần quan sát |
| --- | --- | --- |
| A1 | Vào link, chọn tên giả, ghi nhớ, xác nhận đúng máy/tai nghe | Đúng danh tính; xác nhận rõ trước vào bài, đổi người không mang nháp người trước |
| A2 | Bấm Kiểm thiết bị rồi phát Listening; vừa nghe vừa nhập | Tiếng rõ qua đúng tai nghe; mốc chạy; lưu chỉ báo thành công sau phản hồi/đọc lại; chưa nghe không ghi đã xác nhận |
| A3 | Nghe hết tự nhiên, xác nhận nghe, nộp; làm Reading/Writing | Kết quả đúng từng phần, chưa thử không thành 0; chữ có dấu/xuống dòng giữ nguyên |
| A4 | Reload khi đang Listening; mạng còn hoạt động | Xác thực trước giải mã cache; đúng nháp/mốc; chỉ phát sau thao tác, không mở hai bản |
| A5 | Ngắt mạng, nhập nháp, reload rồi nối mạng | Không báo đã đồng bộ/nộp khi chưa có bằng chứng; không hứa tải lại offline hoàn toàn; có mạng xác thực và khôi phục phần đã giữ được |
| A6 | Nộp rồi reload → xem lại | Đúng kết quả/bài; không sửa/nộp lặp; không gắn nhãn đang lỗi chỉ vì audio đã kết thúc |
| A7 | Mở tab trùng, thử sửa/phát | Chỉ một tab được điều khiển; tab còn lại báo rõ, không phát song song hoặc ghi đè |
| A8 | Màn 1440 và thu hẹp 390/zoom200%, dùng Tab | Tiêu đề một hàng, cuộn trong hàng; nút còn tiếp cận được, không kéo ngang toàn trang |
| B1 | Mute phần tử rồi bật lại | Web phát hiện mute phần tử, cần xác nhận nghe lại; không tự coi đã nghe |
| B2 | Mute tab, mute Windows/Volume Mixer hoặc chọn sai đầu ra | Có thể mốc vẫn chạy mà web không biết mute; học viên chọn không nghe rõ, nhận hướng dẫn và liên hệ giảng viên nếu không sửa được |
| B3 | Rút/nối lại tai nghe hoặc đổi đầu ra Windows | Không đòi web nhận ra mọi lần rút. Nếu có tín hiệu đổi môi trường phải cảnh báo/xác nhận lại; nếu không có thì xác nhận nghe và nút báo lỗi vẫn sử dụng được |
| B4 | Bluetooth: mất kết nối/kết nối lại, pin yếu nếu an toàn | Ghi tiếng có ra loa ngoài/đứt/quay lại hay không; không gọi pass chỉ vì API không lỗi; đổi tai nghe nếu không ổn |
| B5 | Nhận cuộc gọi thử/âm thanh app họp khi có người phối hợp | Ghi giảm tiếng/đổi chế độ Bluetooth/đổi đầu ra; web không tuyên bố biết app gây lỗi; đóng cuộc gọi thử và xác nhận lại tiếng |
| B6 | Chuyển tab/thu nhỏ rồi quay lại; bấm media pause/play | Không phát hai bản hoặc nhảy mất đoạn; cảnh báo đúng mức quan sát, có thể tiếp tục theo thao tác; nộp đúng trạng thái |
| B7 | Hồ sơ thường nghi xung đột → hồ sơ riêng | So sánh cùng máy/tai nghe/mạng/nội dung. Chỉ hướng dẫn extension cụ thể khi có bằng chứng; không gán chắc nguyên nhân từ một lần thử |
| C1 | Nhiều máy vào cùng Wi-Fi cùng lúc, từ cache trống | Tải audio/mẫu và mở phiên hoàn tất; ghi số máy, thời gian tải, cảnh báo, lỗi; thử lưu/nộp đồng loạt và đọc lại |

Mỗi dòng ghi **Đạt / Lỗi / Chưa kiểm / Không áp dụng**, thời gian, điều quan sát, ảnh lỗi nếu cần và cách phục hồi. “Không áp dụng” phải có lý do (ví dụ không có Bluetooth); không tính thành đã kiểm. A2 và B2 cần người nghe thật; công cụ tự động không thể ký thay. Khi tiếng không rõ kéo dài, dừng thử trên máy đó và báo giảng viên trực tiếp/chat để đổi máy/tai nghe/hình thức; không kéo dài retry vô hạn. Không thêm dashboard tiếp nhận.

Trước kết luận sẵn sàng bật thử, A1–A8 phải đạt trên Chrome/Edge với thiết bị mục tiêu; B1–B7 phải có kết quả hoặc giới hạn được ghi rõ. C1 cần đo trên mạng triển khai nếu muốn xác nhận sức chứa mạng; nếu chưa đo phải ghi còn thiếu, không suy từ load loopback.

## Phương án bật thử — chỉ thực hiện khi có quyền riêng

Đề xuất bắt đầu với 5–10 người một lớp được chọn, trước buổi thi, có người vận hành theo dõi. Đây là mức đề xuất, chưa phải lớp/lịch đã được Đức chốt. Không gửi link hoặc thông báo trong task chuẩn bị này.

1. Chốt lớp được phép, thời gian thử, người vận hành, gói revision frontend/backend thực tế và bản quay lại đã xác minh. Gói hiện đang ở branch task, không mặc định HEAD đang chạy production. Kiểm cấu hình/proxy/resource thật bằng đọc lại trước khi có lệnh phát hành; không suy từ local. Không triển khai giữa buổi thi thật vì readiness dùng chung runtime K67. Không sao chép cả worktree Pages đang có thay đổi của các lát khác; đóng gói đúng file đã duyệt và dependency đã ghim, so phòng chờ với bản production thật trước khi phát hành. Phép so hash local trong lượt chuẩn bị này không thay phép so live đó.
2. Sao lưu DB/cấu hình và snapshot bản đang chạy theo runbook K67 trong phạm vi được phép. Giữ session secret ổn định khi quay lui trong cùng thế hệ; đổi secret làm token hiện có không còn dùng lại được. Không in secret ra log/artifact.
3. Áp dụng migrations **013 → 014 → 015** theo trạng thái hiện có; kiểm ba nhóm cột/quyền bảng readiness, không DROP/khôi phục bảng thi. Backend trước, frontend sau; readiness mặc định tắt trong lúc kiểm gói. Không lặp migration đã áp dụng nếu công cụ/schema không idempotent.
4. Đặt `K67_READINESS_ENABLED=true`, `K67_READINESS_CLASSES` chỉ có lớp đã duyệt theo cấu hình runtime; đây là quyền phía server, query client không mở lớp. Chọn tên/ghi nhớ đúng mẫu hiện tại. Không đổi công tắc exam/audio, CORS, secret hoặc endpoint chấm bài để tiện demo.
5. Đi hết luồng bằng tài khoản thử được phép: login → xác nhận thiết bị → kiểm/nghe → lưu → nộp → reload → R/W → xem lại. Kiểm network không lấy content/preview/key đề thật, chỉ có asset làm quen; đọc đúng bản ghi readiness. Kiểm lobby thật bằng so file/gói và hành trình bảo vệ hiện có trong môi trường thử, không mở/nộp đề của học viên để làm probe.
6. Trong đợt thử ghi 429/5xx/timeout theo route, độ trễ, thời gian tải/cảnh báo, pool/chờ DB/CPU/RAM và số phiên đang hoạt động; tách lỗi mở mới với lỗi của phiên đang làm. Không ghi token/khóa/đáp án hoặc tên học viên vào log đo tải. Không thêm hệ thống telemetry hoặc scheduler chỉ vì runbook này.
7. Chỉ mở rộng sau khi đọc lại đầy đủ bài/phiên, không có sai người/mất nháp/nộp sai, đã nghiệm thu tai nghe và xem lại lỗi thực tế. Không dùng việc “API trả 200” làm bằng chứng nghe được. Đề xuất kiểm thêm 25 rồi 60; số thật phụ thuộc lớp và băng thông đo được, không hứa 120 máy production.

## Khi phải dừng mở rộng

- Bất kỳ dấu hiệu lộ đề, ghi sang bảng thi thật, sai người, mất bài hoặc báo nộp thành công nhưng không có bản ghi: dừng thử, giữ bằng chứng, người vận hành xử lý ngay.
- Lỗi 5xx/timeout hoặc 429 ảnh hưởng phiên hợp lệ; nhiều người cùng không tải/lưu được; CPU/RAM/pool chạm giới hạn: ngừng nhận thêm người và điều tra. Không tắt limiter hoặc tăng quota chỉ để tiếp tục lớp.
- API thường xuyên quá 2,5 giây, tải audio kéo dài, gián đoạn nghe tái diễn hoặc chưa biết nguyên nhân: chưa mở rộng. Ngưỡng đo và số người thực tế cần ghi cùng báo cáo, không chọn phần trăm lỗi tùy ý rồi bỏ qua mất bài.

## Quay lui mà giữ bài

**Giới hạn đã kiểm:** `K67_READINESS_ENABLED=false` làm cả API phiên cũ trả 404. Bỏ lớp khỏi `K67_READINESS_CLASSES` cũng làm phiên cũ bị từ chối. Hai cách đều **không phải đóng mềm**. Chưa có công tắc riêng “ngừng mở mới nhưng cho lượt đang làm kết thúc”.

Với lỗi không khẩn cấp:

1. Ngừng gửi link/nhận thêm người bằng điều phối trực tiếp trong nhóm thử nhỏ; đây chỉ là điều phối, không chặn được người còn giữ link. Giữ backend, allowlist và secret đang phục vụ các phiên cũ. Nếu cần bảo đảm chặn mở mới bằng kỹ thuật trước pilot, phải bổ sung/test riêng công tắc đóng mềm rồi mới sử dụng; runbook không giả định nó đã có.
2. Người vận hành xác nhận từng người trong nhóm đã nộp hoặc đã lưu và chủ động dừng; đọc lại đúng bài/phiên, giữ danh sách phiên đang dở riêng tư. Không dùng `submitted_at IS NULL` đơn thuần để kết luận có người online: phiên bị bỏ có thể còn bảy ngày. Chưa có heartbeat hiện diện đáng tin.
3. Khi không còn người đang làm, tắt readiness và gỡ link khỏi điểm truy cập; quay lại frontend rồi backend tương thích đã ghim nếu cần. Giữ module/migrations/DB sẵn để bật lại; rollback tối thiểu bằng công tắc có thể đủ, không bắt buộc downgrade runtime. Kiểm điều kiện/lobby/audio thi thật không đổi.
4. Không DROP cột/bảng, không restore snapshot cũ đè lượt đã phát sinh, không xóa cache/nháp trình duyệt. Giữ dữ liệu để khi bật lại cùng secret/quyền/schema còn tương thích, học viên reload xác thực và xem/tiếp tục đúng bài. Phiên vẫn hết hạn sau bảy ngày; không hứa phục hồi vô hạn.

Với dấu hiệu lộ đề/ghi sai nghiêm trọng: người vận hành có quyền khẩn cấp có thể tắt toàn bộ readiness để cô lập; phải nói rõ phiên đang dở sẽ tạm không truy cập được, yêu cầu giữ trang/nháp và liên hệ giảng viên, không báo rằng các phiên vẫn hoạt động. Đọc lại DB trước khi bật lại. Quy trình này không tự cấp quyền restart/deploy/đổi cấu hình production cho Codex.

Diễn tập local `test/readiness-rollout.test.js` xác nhận: tắt API không sửa bản ghi, bật lại giữ nháp/báo cáo/bài nộp, bỏ lớp không xóa bài nhưng chặn phiên. Đây là diễn tập module/config trên cùng DB, **chưa phải** đổi image qua Nginx hoặc phục hồi backup production.

## Giới hạn vận hành còn lại

- Expiry logic bảy ngày không đồng nghĩa đã dọn dữ liệu vật lý. Chưa có lịch purge; cần chốt thời hạn giữ/dọn trước triển khai dài hạn, không tự tạo job/xóa dữ liệu trong task này.
- Audio WAV riêng khoảng 3,95 MB/người và MP3 riêng khoảng 0,097 MB/người. Ví dụ 120 lượt cache trống cần khoảng 485 MB truyền xuống. Trên đường chia sẻ 100 Mbps, riêng lượng này cần tối thiểu khoảng 39 giây trong điều kiện lý tưởng; thực tế còn tranh chấp Wi-Fi/TLS/đáp ứng khác. Đây là tính lượng byte, không phải phép đo mạng lớp.
- Bài mẫu public không chứa đề thật. Mã hóa file làm quen không che dữ liệu đã giải mã khỏi chính người đang dùng trình duyệt; bảo vệ đề dựa trên tách nội dung/token/route/quyền, không dựa vào việc giấu URL.
- Các bản duyệt Chrome/Edge tự động dùng hồ sơ riêng; tai nghe, mute OS, Bluetooth, cuộc gọi, extension và mạng lớp phải có người xác nhận riêng. Không gọi là nghiệm thu thiết bị thật khi mới có tín hiệu mô phỏng.
