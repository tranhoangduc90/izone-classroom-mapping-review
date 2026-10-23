# Audio Pages K56 và Listening — 23/10/2026

Gói chuyển bytes MP3 sang Pages, giữ API xác thực/điều khiển và tương thích client cũ. Không đưa đề/đáp án/transcript/bài làm hoặc secret lên Pages. Không thay mã hóa của phiên K56 đã bắt đầu và chưa ghim public.

## K56

`patch-k56.py <live-k56-exam-order.js> <overlay-k56-exam-order.js>` chỉ thêm import, cờ hỗ trợ MP3 và metadata vào response chuẩn bị/khôi phục. Chạy trên source lấy từ đúng image K56 thật/demo đang chạy; mọi anchor phải xuất hiện đúng một lần. Không dựng toàn K56 từ main vì còn overlay lịch sử.

Copy `k56-public-audio.mjs` và `k56-public-audio-catalog.json` vào `/app/src/` của image nền tương ứng. Hàm chọn audio chạy sau kiểm quyền hiện hành, khóa attempt/session theo thứ tự K56 và chỉ thêm `publicAudioManifest` vào JSON snapshot sẵn có. Không migration schema, tạo lượt, đổi câu trả lời/điểm, khởi động đồng hồ hoặc gọi Portal. Reading trước chưa nộp, phiếu giấy, lượt đã nộp/reset và generation sai không được ghim.

Giữ bản metadata đã ghim qua reload/bắt đầu. Client cũ tiếp tục dùng endpoint mã hóa; client mới chỉ bỏ giải mã khi Blob MP3 khớp hash. File nghe thử lấy từ cùng Blob, vẫn bị giới hạn bởi giao diện hiện hành.

## Listening

Source chuẩn ở `products/listening-practice/src/app.js`, `public-audio.js` và `public-audio-catalog.json`. Overlay chỉ ba file đó trên image live; không thay service/domain/worker Docs hay dữ liệu. API cũ gửi MP3 cho client cũ; client mới yêu cầu metadata bằng Accept sau đúng kiểm quyền đang làm hoặc xem lại. Catalog được chọn bằng SHA-256 trong định nghĩa bài đã ghim, không bằng tên bài.

## Thứ tự và kiểm

1. Phát hành Pages/file/module tương thích ngược. Kiểm Range, kích thước và SHA-256 trên URL thật của cả năm file trước chuyển API.
2. Sao lưu chỉ mục image/source/config, hash dữ liệu và dump riêng tư; giữ container cũ để quay lại. So mọi source byte ngoài phần dự kiến và giữ nguyên env/mount/port/network.
3. Kiểm SQL pinning bằng `node --test backend/ops/releases/audio-pages-20261023/test.mjs` (dùng dependency PGlite của Listening). Chạy `npm test` ở `products/listening-practice` và test frontend mới/hiện hành bị tác động.
4. Chuyển từng API, kiểm health và endpoint thật; lỗi thì quay image cũ, giữ DB mới. Đọc lại source/public assets và dữ liệu. Không thử nộp/chấm/reset bài thật.

Metadata public chứa URL/hash/size/chunk, không có credential hoặc định danh học viên. Khi thay audio tương lai, tạo tên chứa hash mới, kiểm bytes và cập nhật catalog; không ghi đè file hoặc bản ghim cũ. Các file MP3 hiện tại giữ nguyên chất lượng và mốc clip.

## Gói chuẩn bị chặng 1–3

Pages đã phát hành trước; API chưa phát hành. Source API giữ local đến khi Đức duyệt riêng quyền push/merge và chuyển runtime. K56 vẫn phải ghép từ đúng image đang chạy, không build lại toàn backend từ main.

`release-control.py` là công cụ cho người triển khai sau khi có duyệt. Action `plan` chỉ đọc: đối chiếu container ID, image, cấu hình và SHA-256 source, dừng khi live đổi. `apply` chuyển **một** runtime, giữ env/port/mount/alias/restart policy và giữ container cũ. `rollback` dùng receipt của chính lần chuyển, giữ database hiện tại, không xóa container lỗi. Health fail tự quay API cũ; health thành công vẫn phải kiểm nghiệp vụ riêng trước khi chuyển API tiếp theo. Không chạy `apply` trong lượt chuẩn bị.

Đầu vào là baseline riêng tư có `runtimes`/`sources`, catalog image ứng viên và đường receipt chưa tồn tại. Không ghi credential vào baseline hoặc đầu ra. Thứ tự sau duyệt: K56 demo → K56 thật → Listening. Sao lưu/dump và đọc phiên đang học thực hiện sát giờ phát hành; các bản sao lưu cũ chỉ là lịch sử.

Kiểm cục bộ công cụ vận hành bằng `python backend/ops/releases/audio-pages-20261023/test-release-control.py`. Các kiểm này chứng minh guard/config/quyền quay lại trên fixture; không phải bằng chứng đã thay Docker production. Khi hệ thống dùng Compose, cần ghi image overlay vào đúng cấu hình phát hành sau duyệt để lần `compose up` sau giữ bản mới; không thay tệp cấu hình server trong chặng 1–3.

Ca K56 endpoint dùng toàn app live, SQL PGlite và học viên giả cho ba bài × hai thứ tự × hai profile. Kiểm đồng thời trên PGlite dùng một kết nối tuần tự, không thay thế đo contention của pool PostgreSQL production. Điều kiện Reading đã nộp được thiết lập trong kho thử; phần chấm/ghi điểm giữ suite riêng. Browser Listening phải dùng nguyên bundle thật của Buổi 8/10 nhưng roster/Docs giả, không gửi side effect ra ngoài.
