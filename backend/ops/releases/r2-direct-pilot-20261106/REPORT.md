# Thử tải audio R2 bằng link tạm — 06/11/2026

## Kết luận

Tải trực tiếp có lợi rõ trong mẫu đo, nhưng **chưa đủ bằng chứng để đổi production**. Không thay code/cờ của runtime học viên. CORS được thêm tạm cho phép đo rồi đã đưa về không có policy. Bucket giữ private, không bật r2.dev/custom domain. Khóa thử chỉ đọc một bucket, TTL 24 giờ, đã xóa sau thử; request ký lại bằng khóa đó bị R2 từ chối HTTP 401. Worker cuối lượt vẫn enabled, 18 audio, 512 KiB, đúng revision ban đầu.

Hai việc còn thiếu trước rollout: tích hợp signer sau phép kiểm quyền native của từng runtime và cập nhật CSP chính xác endpoint R2 trong các entry chịu tác động. Chưa có end-to-end phiên thi dùng signer mới, chưa kiểm điện thoại vật lý hoặc tải lớp đông. Test backend hiện hành không thay bằng chứng tích hợp này.

## Phép đo

Máy Windows của Đức, cùng đường mạng; ba vòng đổi thứ tự đường tải. Cả hai tải đủ file, kiểm SHA-256 rồi trả Blob. Luôn tạo parts Map mới; không dùng cache audio của ứng dụng. Cache mạng/CDN và DNS/TLS tự nhiên không bị xóa, nên đây không phải phép đo cold connection tuyệt đối. Baseline tải từ năm module public live tại thời điểm thử, không lấy loader cũ trong main local.

| File | Cách hiện tại, trung vị | Link R2, trung vị | Request GET ở bộ tải |
|---|---:|---:|---:|
| Mini K56, 2.228.297 byte | 428 ms | 467 ms | 6 → 1 |
| Term 1 K67, 27.757.131 byte | 2.918 ms | 1.074 ms | 54 → 1 |
| Substitute 2 K67, 41.881.391 byte | 4.027 ms | 1.845 ms | 81 → 1 |

Đây là 18 lượt Node: 9 mỗi cách, tất cả đúng hash. Không kết luận file nhỏ luôn nhanh hơn; trung vị Mini trong Node chậm hơn 39 ms.

Chrome harness cùng origin Pages, file Term 1, ba lượt mỗi cách: hiện tại 3.930/4.568/5.016 ms, link R2 1.429/1.457/1.325 ms. Trung vị 4.568 → 1.429 ms, giảm 69%. Hiện tại có 53 phần Cloudflare mỗi lượt, không Pages; đường mới một GET mỗi lượt. Số request trong bảng là fetch ứng dụng, không đếm OPTIONS tự động của trình duyệt. Cả hai đều kiểm hash, không phát audio khi chưa xác minh.

Chrome Slow 4G mô phỏng, một cặp Mini 2,2 MB: 19.631 → 13.001 ms. Cách hiện tại có 1 phần Cloudflare/4 phần Pages, 10 fetch; đường mới 1 fetch. Đây là một cặp minh họa timeout, chưa là thống kê độ tin cậy. Thời gian cấp link ở backend chưa tích hợp nên không có trong thời gian R2; baseline gồm request lấy vé Worker. Không suy các số này thành tốc độ mọi học viên.

## Quyền và cấu hình thực

- GET link hợp lệ trả 206 đúng range. Không chữ ký: 400; sai chữ ký, thay object và link hết hạn: 403.
- Link tạm là bearer: người cầm link dùng được đến khi hết hạn. Không gắn tuyệt đối với một thiết bị/chủ phiên; thu hồi quyền trong ứng dụng không tự hủy link đã phát. Cấp lại phải kiểm quyền native; URL và khóa không vào báo cáo/Git.
- Trước thử bucket không có CORS. Thêm tạm chỉ `https://tranhoangduc90.github.io`, GET/HEAD, header Range, expose metadata/range, preflight TTL 60 giây. Không đổi public access. Sau đo đã đọc lại không còn CORS policy.
- CSP trang Term Test 1 live có Worker trong connect-src nhưng không có R2. Trang danh mục cũng không cho Worker nên kết quả thử trên trang danh mục bị chặn CSP và fallback Pages; đã loại khỏi so sánh Cloudflare. Các lượt Chrome hợp lệ dùng trang văn bản public cùng origin làm harness, không phải end-to-end entry thi đã chuyển.
- MP3 trong catalog đã có bản public Pages từ trước; private R2 không làm bản Pages cũ thành private.

## Khôi phục và kiểm thử

- R2 thật, file Term 1: ngắt luồng sau khoảng 800 KB, giữ phần đã xác minh và tải tiếp `bytes=524288-`; đúng hash sau 2 request, 1.704 ms trong lượt đo này.
- Hủy rồi tạo lượt tải mới với cache parts: tải tiếp từ 512 KiB. Chrome xác minh đủ 27.757.131 byte và đọc metadata duration 1.734,765714 giây. Cache trong phép thử này là Map được giữ và chuyển cho lượt mới; chưa là kiểm reload trang với IndexedDB persistent.
- Cách hiện tại cũng hoàn tất khi chèn lỗi một phần; lượt fault Node có 160 request. Không dùng lượt này làm benchmark tốc độ hay quy toàn bộ request cho Cloudflare vì chưa ghi phân bố nguồn của lượt fault.
- 11 ca prototype: ngắt mạng/resume, cache hỏng, hết hạn/cấp lại một lần, quyền bị thu hồi dừng, 403 lặp dừng, lỗi CORS hữu hạn, hủy khi đổi danh tính, hash hỏng, range sai, manifest ghim sai bị từ chối. Đã phát hiện RED ở ca native từ chối renewal: lỗi bị nuốt rồi thử lại; sửa thành dừng ngay, GREEN 11/11.
- Backend K67 trên PGlite giả cách ly: audio-access + audio-incidents 33/33; audio-owner 15/15. Giữ metadata trước start, hai thứ tự thi, slug/generation/token, deadline, pin legacy, mất ACK, bù một lần, nháp, chủ tab và thu hồi chủ. Đây là baseline backend trên revision thử; chưa cắm signer vào endpoint native.
- Loader hiện tại: part-rescue + clock-skew 16/16. Không tạo/nộp bài thật hoặc ghi Portal/Docs.

## Source và bằng chứng

Worktree `E:/wt/r2-presigned-pilot-20261106/classroom-mapping-review`, nền `3862bea9f457a1e98056b3a79e5e6829ee284ad5`. Ba file `.mjs` tại đây chỉ là prototype, chưa nối app hoặc entry production. Signer nhận manifest đã được cấp quyền; bộ tải giữ hash/chunk cache nhưng tải nguyên file khi mạng tốt. Lỗi quyền/range/hash dừng; lỗi mạng thử hữu hạn và có thể cấp lại qua callback kiểm quyền.

Kho local riêng: `E:/Codex-Data/r2-presigned-pilot-20261106/`: `benchmark.json`, `browser-benchmark.json`, `slow4g.json`, `access-results.json`, `fault-results.json`, `browser-recovery.json`, các log native/owner/direct/baseline và baseline modules. Credential chỉ ở kho riêng dưới dạng RSA ciphertext; private key không vào Git. Không dùng `run.mjs --grant` trong log rộng vì lệnh trả link tạm.

Đường quay lui: gói này không được import bởi production. Nếu làm lát triển khai sau, dùng cờ mặc định tắt, giữ loader cũ/fallback và quyền native; không thay timer/pin/owner/deadline hoặc database để chuyển transport. Cần kiểm grant refresh qua native trên đủ consumer rồi mới chọn rollout, không chỉ đổi URL trong manifest.

## Bổ sung: so sánh GitHub Pages — 06/11/2026

Yêu cầu tiếp theo của Đức: đo cả nguồn GitHub Pages. Không cấp lại khóa R2, không đổi CORS/bucket/runtime. R2 trong bảng là tham chiếu từ lượt thử trước, **không phải phép đo bốn phương án xen kẽ trong cùng đợt**. Không dùng chênh lệch giữa hai đợt để khẳng định Pages luôn nhanh hơn R2.

Ba phương án mới được đo xen kẽ ba vòng trong Chrome cách ly, cùng origin Pages, cùng file Term 1 27.757.131 byte. Bộ tải nguyên file Pages là bản thử của cùng thuật toán direct: chỉ thay allowlist origin sang đúng Pages và dùng URL asset public; giữ hash từng phần, hash toàn file, timeout, cache Map mới và điều kiện trả Blob. Mọi fetch ở cả ba phương án đều ép `cache: no-store`, tránh ưu thế HTTP cache ở bộ tải fallback Pages vốn dùng `cache: default`. Không thêm cache-busting query: CDN, DNS/TLS và điều kiện mạng vẫn tự nhiên, không phải cache lạnh toàn cầu. Nguồn hiện tại ghi nhận đủ 53 phần Cloudflare mỗi lượt; ép Pages ghi nhận đủ 53 phần Pages.

| Phương án | 27,8 MB, trung vị 3 lượt | Mini 2,2 MB, Slow 4G, 1 lượt | Fetch ứng dụng, mạng thường |
|---|---:|---:|---:|
| Cloudflare chia phần hiện tại | 3.744 ms | 20.227 ms | 54 |
| Pages chia phần qua bộ tải hiện tại | 1.406 ms | 14.122 ms | 54 |
| Pages nguyên file bằng bộ tải thử | 757 ms | 13.051 ms | 1 |
| R2 link tạm, lượt trước | 1.429 ms | 13.001 ms | 1 |

Chi tiết mạng thường: Cloudflare 3.872/3.744/3.442 ms; Pages nguyên file 757/845/748 ms; Pages chia phần 1.488/1.360/1.406 ms. Chín lượt đều đúng hash, không fallback lẫn nguồn trong phép đo thường. Slow 4G: Cloudflare có 1 phần Cloudflare/4 Pages, 10 fetch; ép Pages có 5 phần Pages/6 fetch; Pages nguyên file 1 fetch. Fetch ép Pages vẫn có một request lấy vé Worker trước khi tùy chọn preferFallback được áp dụng; không nhận 54 request đều là GET Pages. Các số không đếm OPTIONS tự động.

Lượt thăm dò trước khi ép no-store có Pages nguyên file 4.420/668/967 ms và Pages chia phần 3.842/3.523/529 ms. Đã giữ ở `pages-uncontrolled-cache.json` nhưng không trộn vào trung vị trong bảng: cache HTTP và độ ấm kết nối/CDN làm thay đổi kết quả đáng kể. Ba lượt thành công không chứng minh xác suất sẵn sàng dài hạn; một cặp Slow 4G chỉ là minh họa.

### Tải tiếp và quyền

- Ngắt luồng Pages thật sau ngưỡng khoảng 800 KB: packet đến lớn nên đã xác minh được 1.572.864 byte; retry gửi `bytes=1572864-`, nhận 206 và Content-Range đúng `bytes 1572864-27757130/27757131`, ghép đủ file đúng hash sau hai request, 986 ms trong lượt này.
- Hủy sau phần đầu rồi gọi bộ tải mới với cùng Map: giữ một phần, tải tiếp `bytes=524288-` và đúng hash. Đây là hai lượt tải trong harness, không phải reload browser với IndexedDB và không phải chạy lại end-to-end bài thi.
- Pages public không có link ký/hết hạn hoặc kiểm danh tính ở nguồn file. Ai biết URL đều tải được; quyền vào bài thi vẫn nằm ở API. Đó là tính chất của các MP3 đã public hiện hành, không mở thêm file riêng trong phép thử.
- R2 private có thể kiểm quyền khi cấp link, nhưng link đã cấp vẫn dùng được đến hết hạn. Nếu còn bản Pages public của cùng audio, không được tuyên bố toàn bộ audio đã riêng tư.

### Đánh giá sử dụng

Trong mẫu này, Pages tải nguyên file nhanh và đơn giản; việc chia nhiều request và mã hóa lại lúc tải là chi phí đáng kể của tuyến hiện tại. Không có bằng chứng Pages kém hơn R2 về tốc độ trong mọi trường hợp. Tuy nhiên, tốc độ chưa đủ để chọn Pages làm kho audio chính khi mở rộng: GitHub Pages có soft bandwidth limit 100 GB/tháng và có thể rate-limit. Khoảng 3.600 lượt tải đầy đủ file 27,8 MB đã xấp xỉ 100 GB, chưa tính bài khác, HTML/JS/ảnh hoặc tải lại. Đây là phép tính dung lượng minh họa, không phải số đo sử dụng thực tế hoặc ngưỡng cắt cứng. Nguồn chính thức: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits

Kết luận cho lát triển khai sau: R2 tải trực tiếp vẫn đáng thử làm nguồn chính cho nhu cầu quy mô/quyền, Pages có thể giữ dự phòng. Nếu nhu cầu nhỏ và audio vốn public, Pages nguyên file là phương án đơn giản và đã thể hiện tốc độ tốt trong thử nghiệm này; cần đối chiếu lưu lượng tháng thực tế trước khi chọn. Không đổi production chỉ vì bảng tốc độ.

Bằng chứng bổ sung cùng kho local: `pages-network-benchmark.json`, `pages-slow4g.json`, `pages-recovery.json`, `pages-uncontrolled-cache.json`. Không thay đổi code đã đo của production, native timer/owner/deadline hoặc dữ liệu bài làm.
