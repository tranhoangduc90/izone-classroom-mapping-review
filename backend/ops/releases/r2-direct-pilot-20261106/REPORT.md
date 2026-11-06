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
