# Kế hoạch áp dụng Cloudflare R2 cho Listening Homework và Listening thực chiến

Phiên bản đề xuất 1.0 · ngày 06/11/2026 · người thực hiện dự kiến: Codex.

Đầu ra của lượt này là kế hoạch, chưa phải lệnh triển khai. Không đổi production, lớp đang mở, bài làm hay cấu hình Cloudflare trong lúc lập kế hoạch. Quyền Git/phát hành thường trực vẫn giữ; yêu cầu chỉ lập plan không tự trở thành yêu cầu chạy các bước bên dưới.

## 1. Kết quả cần đạt và giới hạn phạm vi

Học viên mở đúng bài và tải một file MP3 từ R2, kiểm file đầy đủ rồi phát. Khi mạng gián đoạn, lấy tiếp phần thiếu; khi R2 lỗi, dùng Pages cho audio đã được phép công khai. Giữ cách học, nháp, quyền, chấm và Docs của từng sản phẩm.

- Áp dụng 5 bài Listening Homework và 3 bài Listening thực chiến đã tìm thấy trong catalog; xây adapter để bài mới trên đúng hai engine có thể kế thừa sau khi đăng ký asset/quyền.
- Dùng R2 Standard private hiện có, ký link GET tại backend sản phẩm; dữ liệu MP3 không đi qua VPS/n8n/Worker mã hóa theo phần.
- Không thay audio, bitrate, nội dung/key, số lớp hoặc quyền học đang mở. Không xóa bản Pages, không đưa thêm file riêng lên nơi công khai.
- Không đổi Reading, Speaking, Writing, Term/Mini/Substitute. Đặc biệt giữ policy Pages → Cloudinary mới của Term 2 K56; không sửa transport toàn cục để kéo sản phẩm khác sang R2.
- Không nâng Workers Paid, không mua domain, không thêm CDN/cache service hoặc thay luồng AI/Docs. Giữ phiên native hiện hành; đây không phải dự án chống tải file tuyệt đối hoặc học offline hoàn toàn.

Mức triển khai dự kiến: chia theo từng sản phẩm và bài, kiểm có kiểm soát vì đụng quyền và phục hồi. Kế hoạch có điểm kết thúc ở mục 11, không mở rộng thành audit toàn hệ thống.

## 2. Căn cứ và hiện trạng đã đọc

### 2.1. Những gì đã xác minh

- Catalog công khai và Worker `/health` đọc lại ngày 06/11: Worker enabled, revision `audio-cf-public-parts-20261023-v1`, 18 asset toàn hệ thống, kích thước phần 524.288 byte. Trong đó 8 asset dưới thuộc phạm vi plan.
- Các lượt thử R2/Pages trước được giữ trong [REPORT.md](REPORT.md). File 27,8 MB của phép thử là Term 1, chỉ là bằng chứng transport, không phải nghiệm thu hai sản phẩm Listening.
- Chrome: R2 nguyên file 1,43 giây ở lượt trước; Pages nguyên file 0,76 giây trong đợt sau; hai đợt không đủ để kết luận R2 luôn nhanh hơn Pages. Vì vậy chọn R2 vì giảm request, quyền cấp link và khả năng mở rộng; không đặt điều kiện phải thắng Pages về tốc độ.
- Đã thử Range, ngắt/hủy rồi tải tiếp và kiểm hash thật. Prototype chưa có tích hợp native của hai engine, chưa kiểm reload trang với IndexedDB bền và chưa là bộ tải production.
- Khóa thử trước đã thu hồi, CORS thử đã hoàn tác. Không tái sử dụng khóa đó cho bản phát hành.

| Nhóm | Bài | Asset ID | Dung lượng xấp xỉ |
|---|---|---|---:|
| Homework | Scandinavian Studies | homework-listening-02-scandinavian | 10,34 MB |
| Homework | Horton Castle | homework-listening-horton-castle | 6,45 MB |
| Homework | Origami | homework-listening-origami | 1,70 MB |
| Homework | Natural dyes | homework-listening-natural-dyes | 2,15 MB |
| Homework | Paper on public libraries | homework-listening-paper-on-public-libraries | 0,52 MB |
| Thực chiến | Buổi 8 · Science experiment | listening-8 | 7,35 MB |
| Thực chiến | Buổi 10 · Inclusive design | listening-10 | 7,78 MB |
| Thực chiến | Buổi 15 · C21 T1 full | listening-15-c21-t1-full | 25,84 MB |

Tổng đúng theo catalog: 62.119.530 byte. Danh sách này là mốc kiểm, không phải allowlist vĩnh viễn. Trước build/rollout phải rà bài mới thêm sau mốc này và nguồn cấu hình thực sự đang chạy; không mở lớp mới từ việc bật transport.

### 2.2. Nguồn và phần còn cần kiểm khi bắt đầu build

Đã fetch và đọc source remote main: Pages `406291b886fe16bdf4de3b02b13b03df8cfa8654`; Homework/backend Writing `ec9a22faad42d20f30a46eab31bf4fe40609e9a3`; backend Listening thực chiến `06e39383f2105cd6a0954033091734e623496f4b`.

Đây là revision nguồn để lập plan, không chứng nhận image live khớp main. Lát đầu phải đọc đúng image/config live, overlay, mount, cờ và asset từng service; giữ các vá tối ưu, CTA/owner và Docs mới hơn. Chưa kiểm lại session học viên, SSO Google thật, danh sách lớp active, thiết bị vật lý hoặc tải lớp đông trong lượt lập plan.

Nguồn nghiệp vụ: skill `izone-audio-delivery`; `ielts-build-listening-homework-webapp` và các reference runtime/production-inheritance; `ielts-build-listening-practice-webapp` và audio-delivery/audio-reuse/tab-recovery. Các yêu cầu 512 KiB/Worker cũ là baseline vận hành; phương án direct mới thay riêng đường tải sau khi kiểm, không thay quyền/timer native.

## 3. Kiến trúc được đề xuất

Luồng chính: **học viên/giảng viên → API của đúng sản phẩm kiểm quyền → cấp link GET R2 tạm → trình duyệt tải đủ/kiểm hash → Blob → player hiện hành**.

| Thành phần | Trách nhiệm | Ranh giới phải giữ |
|---|---|---|
| Kho R2 và catalog | Một MP3 bất biến theo SHA-256; giữ đúng byte, kích thước, MIME | Bucket private; không bật r2.dev/custom domain; không re-encode file đã ghim |
| Bộ ký link dùng lại | Ký SigV4 bằng thời gian server, chỉ GET và object trong catalog của sản phẩm | Chạy bên trong từng backend, không tạo dịch vụ cấp link công khai; không nhận object key/URL tùy ý từ client |
| Adapter Homework | Kiểm đúng native identity/lớp/lesson và quyền GV, sau đó mới gọi signer | Giữ lối CTA/Doc và link độc lập hiện hành; không tự bắt Google học viên hoặc siết owner ngoài contract đang có |
| Adapter thực chiến | Kiểm native session/binding/attempt hoặc quyền review/GV, chọn hash đã ghim | Không dùng token/lease của Term Test; không cấp quyền từ cache hoặc chỉ từ asset ID |
| Bộ tải direct chung | Một GET bình thường; Range khi khôi phục; hash; cache; hủy; fallback có điều kiện | Chỉ hai adapter mới import; không đổi mặc định của `shared/audio/transport.mjs` cho mọi consumer |
| Player và vòng đời | Đón Blob đã kiểm và tiếp tục hành vi nghe/seek/clock native | Transport không tự phát, start/reset/submit, cộng thời gian hoặc đổi người |

Giữ các database, role, worker/queue, cấu hình và đơn vị phát hành riêng của Homework và thực chiến. Dùng chung mã đã ghim phiên bản, không ghép server Homework vào runtime thực chiến hoặc ngược lại.

## 4. Hợp đồng cấp quyền và tương thích

### 4.1. Hai API có sẵn là cửa cấp link

**Homework:** giữ route `/api/listening-homework67/audio` bên trong lesson router và public prefix hiện hành. Với học viên, thực hiện `studentsOpen`, `identity.authenticate` và owner-entry predicate hiện có; với GV, `identity.authorizeTeacher` theo lớp. Không coi thiếu Doc của lối độc lập hợp lệ là lý do tự chặn học. Chỉ khi `audio.id` khớp `lesson.audioId` mới được ký.

**Thực chiến:** route `/api/audio/:attemptId` gọi `service.audioAccess`, giữ binding/session/attempt và hash từ definition đã ghim. Hai route review `/api/review-audio/:attemptId` và `/api/teacher/review-audio/:submissionId` tiếp tục kiểm result đã nộp, lớp/GV và matching review trước khi cấp link. GV xem nháp không có player/review grant. Không thay logic lease chỉ để tải file.

Client mới đề nghị `r2-direct-v1` qua header riêng `X-Izone-Audio-Transport`; thêm đúng header vào CORS của hai API. Client cũ không đề nghị vẫn nhận hợp đồng cũ. Giữ nguyên trường `audio` của Homework và `audioManifest` của thực chiến; link tạm là trường `audioDownload` riêng, không nhét vào definition/snapshot/pin hoặc lưu cùng nháp.

Descriptor mới gồm phiên bản transport, GET URL, hash/kích thước, thời hạn theo server và policy nguồn dự phòng. Client đối chiếu descriptor với manifest native theo hash + byteLength + assetVersion/URL catalog trước tải. Không dùng tên bài, đuôi MP3 hay ETag để thay SHA-256.

### 4.2. Thời hạn, khóa và giới hạn quyền

- TTL khởi đầu **600 giây**, tổng ngân sách một lượt tải **120 giây**. Client dùng thời gian nhận + đồng hồ monotonic và thời hạn tương đối do server trả; không bác link chỉ vì giờ Windows lệch ±1 ngày.
- Nếu cần link mới, gọi lại chính API native trong cùng ngữ cảnh; được ký lại không có nghĩa được reset lượt/clock. Cùng một lần chuẩn bị dùng chung promise, không xin link cho từng clip/câu.
- Khóa production mới chỉ đọc R2, tách theo runtime để quay/thu hồi riêng; lưu secret phía server, không ở Pages, browser, Git hoặc log. Không dùng khóa admin/upload cho đường phát audio.
- Ưu tiên dùng bucket hiện có để tránh di chuyển 18 asset. Với khóa bucket-scoped, quyền R2 có thể rộng hơn 8 object của plan: đây là giới hạn thực, không gọi là cách ly object tuyệt đối. Bắt buộc catalog allowlist đúng sản phẩm; nếu cần quyền object chặt hơn, dùng credentials giới hạn object của R2 và kiểm khả năng xoay trước rollout, không tự mở kho public.
- Link đã cấp là vé cho người cầm link đến khi hết hạn; logout/chuyển chủ chỉ hủy sử dụng trong app và chặn cấp lại, không thu hồi tức thì link đã phát. CORS không thay quyền. Không thêm cơ chế một link/một thiết bị trong task này.
- Các MP3 hiện tại đã có bản Pages public. R2 private không làm cả kho thành nội dung bí mật; thay đổi chính sách công khai/xóa URL cũ là phạm vi khác.

### 4.3. Client và lượt đang tồn tại

- Hai cờ dự kiến mới, không phải cờ đã có: `AUDIO_R2_DIRECT_ENABLED` mặc định false; `AUDIO_R2_DIRECT_ASSETS` là SHA allowlist, rỗng nghĩa là không bật asset nào. Cấu hình riêng mỗi runtime.
- Homework: áp cho lần chuẩn bị player mới sau khi tải bản frontend mới; không ngắt Blob đang dùng hoặc ép reload bài đang nhập. Mã code/alias/nháp/lịch sử không đổi.
- Thực chiến: server ghim nhãn policy nhỏ `audioDeliveryPolicy` cho **lượt mới** khi bắt đầu áp dụng; lượt cũ thiếu nhãn mặc định legacy. Không ghi URL/key/TTL vào state. Dùng metadata JSON tương thích hiện hành nếu phù hợp; nếu cần thay schema phải ghi delta/migration cụ thể trước lát đó, không di chuyển dữ liệu để chỉ đổi CDN.
- Request có nhãn direct vẫn chỉ được dùng khi client opt-in, cờ đang bật và asset khớp; tắt cờ cho phép lui về loader cũ cùng file. Các response/request cũ, bản pin legacy, client đã mở và bài nộp cũ vẫn đọc được.

## 5. Bộ tải, cache và xử lý lỗi

### 5.1. Đường bình thường

Tải nguyên file bằng một GET, đọc stream để hiển thị tiến độ và xác minh block 512 KiB. Đây là block kiểm/cache trong máy, **không phải 53 request mạng**. Chỉ gắn Blob khi đủ byte và đúng SHA-256 toàn file. Không đổi sang vừa tải vừa nghe trong lượt triển khai này.

Thông số khởi đầu để kiểm: timeout chờ phản hồi/không có byte mới **15 giây**; deadline tổng **120 giây**, tối đa **3 lần GET MP3** cho cả một lượt R2 + retry/fallback. Tải đều trong 20–60 giây không bị cắt chỉ vì vượt 15 giây tổng. Backoff ngắn, hữu hạn, nằm trong deadline chung; không nhân timeout thành nhiều lượt 120 giây.

Giữ một Blob hoàn chỉnh cho đúng hash/version trong mỗi player/tab. Đề xuất cache direct riêng, TTL 24 giờ, tối đa 128 MiB trong namespace của bộ tải; chỉ dọn dữ liệu của namespace này. Hash/kích thước quyết định cache byte, không có người/token/link tạm trong cache. Đổi người/logout hủy controller, tăng generation, giải phóng media URL; response cũ không được lấp lại player mới.

Thêm IndexedDB thật cho phần đã xác minh: sau reload chỉ tải tiếp từ dải liên tục đã ghi bền và hash lại đúng. Chưa ghi bền hoặc cache hỏng thì tải lại phần cần thiết. IDB hỏng/hết quota/chặn dùng RAM và báo đúng mức giữ cục bộ; không xóa toàn bộ storage hoặc bài làm để chữa cache. Không hứa reload offline sẽ vào được bài nếu ứng dụng hiện hành chưa hỗ trợ.

### 5.2. Thứ tự xử lý khi lỗi

| Tình huống | Xử lý bắt buộc |
|---|---|
| Native API trả 401/403, lớp đóng, sai Doc/binding/attempt | Dừng, giữ bài và báo quyền; không dùng R2/Pages/cache để đi vòng |
| Link R2 hết hạn hoặc lỗi R2 có thể liên quan hạn | Xin lại qua native **tối đa một lần**, cùng ngữ cảnh; native từ chối thì dừng ngay |
| R2 network/timeout/429/5xx hoặc vẫn không dùng được sau cấp lại | Với asset đã public và native vừa cho phép: Pages nguyên file/Range trong ngân sách còn lại; không lặp sang Worker chia phần trước Pages |
| R2 trả 403 bị trình duyệt che bởi CORS | Không đoán là native từ chối hay hết hạn chỉ từ `TypeError`; kiểm lại qua native một lần, phân loại nguồn lỗi. Nếu vẫn lỗi, chỉ dùng Pages theo public policy; log lỗi cấu hình để không che sự cố lâu dài |
| Asset riêng tư không có public fallback | Không chuyển sang Pages; giữ bài và báo nguồn tải chưa sẵn sàng |
| Range 206 sai offset/tổng, descriptor lệch hash/version | Dừng dữ liệu sai, không gắn player. Không lấy object khác cho đủ file |
| Nguồn trả 200 khi xin Range | Chấp nhận tải lại toàn file trong deadline, bỏ prefix ghép trùng rồi kiểm toàn bộ; không nối thêm vào bản cũ |
| Byte/hash nguồn hỏng | Không phát. Có thể thử nguồn dự phòng được phép một lần, đúng cùng hash; nếu vẫn hỏng thì dừng |
| Pause/ẩn tab/đổi người/reset/logout | Hủy theo contract engine; giữ chỉ phần byte đã xác minh, không hồi sinh player hoặc phản hồi cũ |

Mỗi lần chuyển nguồn vẫn giữ phần đã xác minh và không đổi hash bản ghim. Không đưa HTTP 403 của nguồn R2 thành thành công mặc định; fallback chỉ được sau native authorization và policy public rõ. Đây là contract production dự kiến, không lấy nguyên logic xử lý lỗi của prototype làm chuẩn đã đạt.

## 6. Giữ hành trình theo từng sản phẩm

### Homework

Giữ nghe lại/tua/tốc độ theo đoạn, chương chép và phân tích, transcript/cue, không phục hồi nút Nghe toàn bài. Không gán timer, nghe một lượt, khóa tua hoặc chặn điện thoại của bài thi vào Homework. Trong cùng workspace, bấm clip khác dùng lại công việc chuẩn bị/Blob đã được cho phép; không thêm request cấp link cho mỗi nút.

Lỗi tải chỉ hiện tại vùng audio; nội dung nhập, CAS, mutation ID, phiên bản nộp, vòng sửa–nộp và lịch sử giữ nguyên. Review của GV vẫn readonly. Không chạy lại AI/chấm hoặc Docs chỉ vì đổi nguồn audio. Giữ scroll/focus/selection và popup qua ba nhịp cập nhật nền.

### Thực chiến

Giữ thứ tự native đang có: tải đủ → metadata/seek đúng vị trí → `/activate` hiện hành → `play()`; không biến GET grant/download thành lệnh begin/activate. Giữ cách xử lý autoplay bị chặn, audio waiting, Pause/Resume/Reset/Submit, 1× và thời gian rà. Không thiết kế lại đồng hồ trong task transport.

Ẩn tab thật dừng theo native; quay lại/reload không tự phát. Khôi phục giữ cùng attempt, lease, câu trả lời, audioPosition và thời gian rà đã dùng. Giữ kiểm checkpoint/active/audioAdvance của cả Buổi 8/10 và C21 full; không reset để sửa tải lỗi.

Review HV chỉ sau nộp; GV chỉ chuẩn bị kết quả đã nộp đang chọn. `app.js` và `explanation-review.js` import đúng cùng URL/query của `audio-delivery.mjs` để tái dùng một Blob. Warm không phát/tua player chính; đổi người/lượt/phiên trong lúc warm phải hủy kết quả cũ.

## 7. Nơi sửa và thứ tự công việc

| Lát | Đầu ra cụ thể và nơi chịu trách nhiệm | Phụ thuộc | Cách khép lát |
|---|---|---|---|
| L0 · Chốt nền | Inventory 8 asset, byte/hash/object/MIME, source/image/config live của hai runtime, entry HV/GV/alias và các bản đang ghim; ghi quyền public fallback từng asset | Source và báo cáo đã đọc | Không thiếu bài/entry; phân biệt runtime thật với main, có baseline quay lui |
| L1 · Một luồng Homework hoàn chỉnh | Signer trong backend Homework; descriptor sau route audio native; module direct/cache dùng chung ở Pages; Scandinavian chạy trên preview và DB cách ly | L0 | Đúng người/lớp/hash, tải/refresh/fallback/IDB reload và nghe theo cue; không đổi vòng sửa–nộp |
| L2 · Hoàn thiện Homework | Áp adapter cho Horton, Origami, Natural dyes, Paper; giữ `lesson-2` alias, entry GV/preview và cách hủy work | L1 | Cả 5 bài đạt byte/hash hai nguồn và ca Homework ở mục 9 |
| L3 · Một luồng thực chiến hoàn chỉnh | Signer trong runtime thực chiến; ba tuyến audio/review; nhãn policy cho lượt mới; adapter và review cùng module | L1 + L0 của thực chiến | Buổi 8 trên DB cách ly qua tải → activate → nghe → Pause/Resume/hidden/reload → rà → nộp giả → review |
| L4 · Hoàn thiện thực chiến và kiểm tích hợp | Inclusive design và C21 full; kiểm tương thích client cũ, GV, pin/lease và cả hai engine chạy cạnh nhau | L2 + L3 | Đủ ca hữu hạn ở mục 9 và benchmark mục 10; không ảnh hưởng consumer ngoài scope |
| L5 · Phát hành theo nhóm | Backend tương thích trước, frontend opt-in sau, bật allowlist từng bài và hậu kiểm có thời hạn | L4 đạt cho nhóm được bật | Đúng source live, native/byte/cache/cue và dữ liệu cũ; kết thúc theo mục 11 |

Chi tiết L0–L1 đã đủ để bắt đầu khi có yêu cầu triển khai; các lát sau giữ contract trên và cập nhật đúng phần phụ thuộc nếu nền live khác. Codex tự thực hiện, không mặc định giao cho agent/team khác hoặc tạo issue gửi người khác.

### Bản đồ file dự kiến

- Repo `izone-writing-task1-practice`: `backend/src/listening-homework67/app.js` tại route audio, bootstrap `backend/scripts/serve-listening-homework67.mjs`, helper signer/module kiểm catalog mới và config release Homework. Không sửa grader/Docs worker vì transport.
- Repo `izone-classroom-mapping-review`: `products/listening-practice/src/app.js`, `public-audio.js`, `service.js`/domain khi cần nhãn policy tương thích, bootstrap/config của đúng product và helper signer cùng contract. Không lấy bộ fixture K67 Term/Mini thay cho thực chiến.
- Repo Pages: module `shared/audio/direct.mjs` và helper cache mới; adapter mới trong `listening-homework/app.mjs`, `interactive-workspace.mjs`; `listening-practice/audio-delivery.mjs`, caller app/review khi cần capability. Giữ mặc định shared transport/public-audio cũ cho các consumer khác.
- Rà thực tế CORS HTTP/meta CSP của entry HV/GV, năm Homework và alias, preview và ba bài practice. CSP chặn R2 đã thấy trên **Term Test 1**, không suy hai sản phẩm này cũng có cùng CSP: chỉ thêm đúng endpoint R2 nơi policy thật cần sửa, giữ `media-src` Blob và mọi nguồn hiện có. Kiểm chuỗi HTML → loader → import/query; không chỉ bump file chung.
- Hai backend có cùng logic ký nhưng cấu hình/quyền phát hành riêng. Tìm package/helper dùng lại trước, không copy ngầm hai bản diverge; nếu vendor helper nhỏ thì ghim hash và có test parity.

## 8. Thiết lập Cloudflare và vận hành

1. Đọc lại từng object đang có, không upload lại nếu byte/hash đúng. Nếu catalog thiếu asset mới thì đăng ký/copy đúng file theo quyền và kiểm đủ hai nguồn; không đổi key bất biến của bản đang ghim.
2. CORS R2: chỉ origin webapp production được đối chiếu; GET/HEAD; request header Range; expose Content-Length/Content-Range/Accept-Ranges/ETag; preflight MaxAge 600 giây. Preview local dùng origin riêng trong cấu hình thử, không mở `*` hoặc localhost vĩnh viễn trong production. HEAD chỉ gọi nếu có chữ ký đúng method, không dùng GET URL để mặc định HEAD.
3. Kiểm endpoint S3 chính xác `https://e340869dcc6ff285504947407d148104.r2.cloudflarestorage.com`; link S3 có chữ ký không dùng với custom domain. Không tự bật CDN public để xử lý CORS.
4. Cài secret đọc riêng hai runtime, kiểm load secret/rotation/restart và log không lộ URL có query. API descriptor trả `private, no-store`; media request `credentials: omit`, không gửi native bearer/cookie/Doc header sang R2/Pages.
5. Phân biệt log cấp link và log byte thực đã tải: source, asset/hash, thời gian grant/download/verify/cache, request/byte/retry, lý do fallback và generation hủy; không có signed URL, khóa, token, tên/Doc/bài làm trong log transport mới. Dùng log nghiệp vụ native hiện có cho đối soát đúng người/lượt, không mở logger khác sản phẩm.
6. Giả định tải kiểm: **30 lượt bắt đầu đồng thời tổng cộng hai engine**, dữ liệu giả, một asset đại diện khoảng 7–10 MB, một lượt có lỗi chọn lọc. Đây là giả định một lớp để nghiệm thu ban đầu, không là số người dùng thực tế đã đo hoặc bảo đảm 500 máy. Không bắn load vào phiên/API bài làm production.
7. Không gọi API quản trị Cloudflare để ký mỗi lượt: ký tại server. R2 có quota lưu trữ/operation riêng, không thu egress trực tiếp; GET thẳng không tiêu request Worker chia phần. Theo dõi tổng tài khoản, không nhận quota miễn phí là dành riêng cho hai sản phẩm. Pages có soft bandwidth 100 GB/tháng và có thể rate-limit; dự phòng có ngân sách, không là vô hạn.

Các tham số tải/timeout/cache là đề xuất khởi đầu để test, không phải lời hứa về mạng học viên. Nếu đạt timeout 120 giây trên mạng quá chậm, dừng/báo giữ bài đúng trạng thái; không tự tăng giờ thi để ép pass. Vượt quy mô đã kiểm hoặc phát sinh chi phí đáng kể là lý do đánh giá lại, không tự nâng gói.

## 9. Phạm vi kiểm hữu hạn trước rollout

Tạo fixture riêng đúng từng engine và dữ liệu giả; log nguồn/sha và revision cho từng phép kiểm. Không cần tích Descartes mọi bài × mọi lỗi. Byte/hash phải phủ đủ 8 asset; trạng thái đặc thù chọn bài đại diện như dưới, thêm ca khi có khác biệt cấu hình thật.

| Nhóm ca | Hành vi cần chứng minh | Consumer đại diện |
|---|---|---|
| A1 · Media | Cả 8 asset lấy từ R2 và Pages đúng byte/hash/MIME; 16 phép tải, đủ cue đầu/cuối/decoder | 5 Homework + 3 thực chiến |
| A2 · Quyền | Sai người/lớp/lesson/Doc/token/attempt bị chặn trước ký; GV ngoài lớp và review chưa nộp không được cấp; cache không cứu quyền bị từ chối | Hai native adapter, review HV/GV |
| A3 · Hạn | Link hết hạn trước GET và trong lúc tải tiếp, native refresh cùng lượt đúng một lần; native từ chối renewal dừng; clock ±1 ngày | Hai API + Chrome thật |
| A4 · Hỏng nguồn | R2 timeout/network/429/5xx, CORS mất, 403 che error body, credential revoked; fallback đúng policy; cả hai nguồn lỗi phải giữ bài | Bộ tải chung và hai adapter |
| A5 · Dữ liệu | Sai hash/size/version, Range sai, 200 khi xin Range, object đổi trái catalog; không phát byte sai | Bộ tải + R2/Pages thật |
| A6 · Cache | IDB reload thật từ prefix đã ghi bền; cache bị sửa/thiếu/tràn quota; RAM fallback; cùng hash không tải lại Blob; cache không lưu grant | Chrome thật, không chỉ Map prototype |
| A7 · Đồng thời | Hủy/đổi người/lượt/logout khi grant/tải/metadata chờ; response cũ không gắn lại; không sinh tải song song cho cùng player | Hai engine và review |
| H1 · Hành trình Homework | Đúng cue, tua/tốc độ/chương, chọn dẫn chứng; đổi clip nhanh; lỗi audio không mất nháp/CAS; reset giữ lịch sử; GV readonly | Scandinavian + Paper/cấu hình khác |
| H2 · Nền không đổi | Bản nhập/scroll/selection/focus qua ba nhịp nền; tải lỗi và lưu bài không kéo nhau về loading; không gọi AI/Docs thêm | Homework thật trên fixture |
| P1 · Bắt đầu | Grant không start clock; fetch/metadata/seek/activate/play và autoplay-block giữ contract; 1×, không tua trái luật | Buổi 8 và C21 full |
| P2 · Khôi phục | Pause/Resume/Reset/hidden thật/reload; pending reset cũ, ACK chậm/mất, lease sai; giữ vị trí/đáp án/usedMs; hai phút rà không cấp lại | Buổi 8/10 + full tại ranh giới kết thúc |
| P3 · Kết quả | Natural ended đúng → rà/nộp; lỗi tải/error không giả ended; HV/GV chỉ review bài có quyền, warm không phát; đổi kết quả không nhận player cũ | C21 full và review HV/GV |
| C1 · Tương thích | Client cũ, cờ tắt, allowlist rỗng, lượt cũ thiếu nhãn, pin legacy, rollback cùng asset; hai API/DB độc lập | Hai product + smoke consumer ngoài scope |
| C2 · Trang thật | Entry HV/GV/alias và HTML/CSP/header thật tải R2 được, không chỉ harness; module query thống nhất; preview dùng renderer thật | Năm Homework + practice shared entries |

Native test nền để mở rộng: Homework `backend/test/listening-homework67.test.js`, `listening-homework-owner-entry.test.js`; thực chiến `products/listening-practice/test/public-audio.test.js`, `recovery.test.js`, `review.test.js`, `teacher-session.test.js`. Pages: `tests/listening-homework-audio.test.mjs`, `listening-audio-reuse.mjs`, `listening-recovery.mjs`, `listening-review-player.mjs`, `listening-review-browser.mjs`, `audio-clock-skew.test.mjs`, `audio-part-rescue.test.mjs`, `public-audio-delivery.mjs`.

Kiểm desktop Chrome và giao diện mobile đang hỗ trợ, gồm phát/seek bằng tương tác người dùng. Browser thiếu khả năng stream/crypto/abort cần dùng helper tương thích hoặc giữ loader cũ bằng feature detection; không chặn điện thoại theo quy tắc của Term Test. Safari/iPhone vật lý chưa có bằng chứng thì ghi riêng và giới hạn kết luận/cách bật đường mới tương ứng, không gọi viewport giả lập là thiết bị thật.

Ví dụ lệnh backend kiểm mục tiêu, chạy tại đúng root tương ứng: `node --test backend/test/listening-homework67.test.js backend/test/listening-homework-owner-entry.test.js`; `node --test products/listening-practice/test/public-audio.test.js products/listening-practice/test/recovery.test.js products/listening-practice/test/review.test.js`. Đầu vào là fixture/DB riêng, xử lý gọi API và state thật, đầu ra exit 0 cùng ca đạt; exit khác 0/fixture thiếu là lỗi hoặc chưa kiểm, không trỏ sang production để vượt guard. Runner browser phải đọc yêu cầu khởi động trước, không giả các file Playwright là test `node:test`.

Lát build thêm ca native cấp descriptor và bài thi đi trọn đường tải mới. Các ca 48/48 Term/Mini K67 của prototype **không thay** ca Listening thực chiến/Homework. Dùng lại kết quả cũ chỉ khi source/runner/config còn khớp; cuối cùng chạy hợp các suite bị tác động trên revision ổn định, không đếm trùng để lấy số đẹp. Không chạy AI/Google/Docs thật nếu phần đó không đổi; riêng quyền người/GV liên quan phải có kiểm thích hợp và báo khoảng trống thiết bị thật.

## 10. Cách so tốc độ và điều kiện đạt

- Ba file đại diện đúng sản phẩm: Paper 0,52 MB; Scandinavian 10,34 MB; C21 full 25,84 MB. Ba phương án: legacy Cloudflare chia phần, R2 nguyên file, Pages nguyên file. Mỗi tổ hợp ba vòng xen kẽ: **27 lượt đo thường**, cùng máy/origin/cache policy, includes hash/cache-write; đo riêng native grant để không bỏ chi phí cấp link mới.
- Ba trạng thái riêng: cache byte trống, cache phần đã có qua reload, Blob hoàn chỉnh/decoder sẵn trong cùng tab. Tắt HTTP cache ở phép mạng trống; không nhận no-store là làm lạnh DNS/TLS/CDN toàn cầu. Ghi source thật khi baseline chuyển Pages, không gán toàn bộ thời gian đó cho Cloudflare.
- Slow 4G mô phỏng: một cặp/ba nguồn với Natural dyes 2,15 MB, và một ca full-file vượt deadline để kiểm trạng thái lỗi an toàn. Không buộc file 25,84 MB hoàn tất trong 120 giây trên mọi mạng.
- Tải 30 phiên giả và lỗi chọn lọc theo mục 8; không mở rộng lên 100/500 nếu không có lỗi hoặc yêu cầu mới. Đo median/range; p95 chỉ mô tả mẫu đủ lớn và nêu cỡ mẫu, không dựng p95 từ ba lượt.
- Đạt chức năng: mọi ca quyền/hash/range/định danh/clock/nộp quan trọng đúng; không có dữ liệu cũ bị sửa do migration; đủ 8 asset hai nguồn; entry thật và IDB reload thật đạt.
- Đạt hiệu năng dự kiến: R2 bình thường một GET MP3; không tải lại byte khi review đã có Blob; median tải gồm xác minh không chậm hơn legacy quá `max(20% thời gian legacy, 500 ms)` trên cùng bộ đo. Mạng lỗi không vượt deadline và giữ bài; không cần R2 thắng Pages để được chọn.
- Nếu không đạt: giữ cờ tắt cho nhóm đó, ghi nguyên nhân và chỉ sửa phần liên quan. Không giảm test quyền/clock hoặc nâng timeout/gói trả phí để làm đẹp số đo. Tiêu chí này là đề xuất plan để kiểm, chưa phải kết quả đạt.

## 11. Rollout, quay lui và điểm hoàn tất

### Thứ tự phát hành đề xuất

1. Ghim đúng image/config live và backup code/operator/config hai runtime, snapshot/hash dữ liệu trước chuyển. Với cohort thực chiến phải kiểm trường policy tương thích. Không rebuild toàn main lên image live thiếu overlay.
2. Chuẩn bị R2/CORS/secret và backend tương thích **cờ direct tắt**. Client cũ vẫn chạy. Kiểm native từ chối và health/source.
3. Phát frontend hai adapter/module/import đúng revision, còn mặc định đường cũ. Canary bằng fixture và trang thật phù hợp quyền; không tạo/nộp bài học viên thật.
4. Homework: bật Scandinavian trước; sau canary đạt bật Horton, Origami, Natural dyes, Paper theo allowlist. Không ép reload bài đang mở, giữ trạng thái lưu/chấm và code/alias.
5. Thực chiến: bật lượt **mới** Buổi 8 → Buổi 10 → C21 full. Lượt cũ tiếp tục legacy. Có thể quay lui riêng thực chiến mà Homework vẫn chạy và ngược lại.
6. Đọc lại module/entry/cờ/hash live; đối soát nháp/lượt/điểm/config trước–sau, phân biệt ghi mới tự nhiên với thay đổi do triển khai. Không yêu cầu không có mọi ghi mới trong hệ thống đang được học.

### Quay lui

Native sai quyền/hash/định danh hoặc phát hiện clock/bài làm hồi quy: dừng bật nhóm tiếp, tắt cờ của đúng runtime/asset và quay code tương thích nếu cần. Sau tắt cờ, request mới dùng hợp đồng cũ/cùng hash; không cắt Blob đang phát hoặc reset lượt để đổi nguồn. Nếu cần quay backend, giữ descriptor optional/client fallback tương thích. Không restore database cũ, xóa cache bài làm hoặc chấm lại.

Thu hồi secret production chỉ khi các runtime đã hết phụ thuộc hoặc khi có sự cố khóa; việc thu hồi làm link R2 đang dùng không còn tải tiếp được, nên kiểm fallback đúng policy trước khi chọn làm rollback. CORS mới có thể giữ cho direct client đang mở còn hoạt động; chỉ gỡ sau khi đã xác minh không làm hỏng lượt còn phụ thuộc. Không áp cách xóa CORS/khóa ngay sau benchmark cho rollout thật.

### Hậu kiểm hữu hạn và điều kiện kết thúc

Canary/readback ngay sau mỗi nhóm; quan sát có giới hạn **24 giờ hoặc buổi sử dụng tự nhiên đầu tiên trong cửa sổ đó**. Codex kiểm log theo phạm vi đã bật, không tạo automation lịch mới. Nếu không có lượt học tự nhiên, kết thúc phần xây/phát với trạng thái đã phát/chưa có quan sát người học; không tạo bài thật để lấp bằng chứng và không kéo dài vô hạn.

Kế hoạch triển khai hoàn tất khi: 5 Homework/3 thực chiến trong inventory hiện hành đã được xử lý đúng phạm vi, đường mới và fallback đạt trên native + browser/entry thật, pin/client cũ không hỏng, dữ liệu không bị đổi ngoài ý định, rollback đã diễn tập và bản live đọc lại đúng. Báo riêng ba trạng thái: source/Git; production đã chuyển nhóm nào; hành trình người dùng/thiết bị/lượt tự nhiên đã quan sát tới đâu. Không gọi bản benchmark hoặc unit test là đã nghiệm thu toàn tuyến.

## 12. Nguồn tra cứu và bàn giao tiếp

- [Báo cáo thử và số đo R2/Pages](REPORT.md); prototype ở cùng thư mục chỉ là đầu vào để phát triển, không copy thẳng vào production.
- [Cloudflare presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/): S3 endpoint, bearer/expiry và giới hạn custom domain.
- [CORS và lỗi expired URL](https://developers.cloudflare.com/r2/buckets/cors/): browser vẫn cần CORS; expired 403 có thể không trả CORS headers.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/); [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
- Source canonical nằm trong ba repo nêu ở mục 7. Worktree plan này không thay source live; khi bắt đầu build, tạo/tiếp worktree đúng từng repo từ remote mới nhất, giữ mọi thay đổi task khác và cập nhật revision plan nếu inventory hoặc contract đã đổi.

Bước thực hiện đầu tiên khi được giao triển khai: L0 và lát L1 hoàn chỉnh với Scandinavian trên fixture/preview, gồm signer sau native auth, CORS/CSP trang thật, IDB reload, lỗi/hết hạn và fallback. Chỉ sau bằng chứng đó mới áp tiếp các lát còn lại; không hỏi lại quyền Git/phát hành đã có và không tự mở rộng bài/lớp ngoài scope.
