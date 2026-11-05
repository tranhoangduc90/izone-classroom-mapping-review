# Ghi mốc Speaking sau khi SQL commit

## Vé client và mốc HTTP —06/11, nền API chưa phát

Runtime nhận intake từ factory cấu hình với allowedOrigins cố định. Chỉ khi logger bật mới có POST journal-context và journal-events. Context dùng service.grant native kiểm SQL/token và nguồn thành viên hiện hành, rồi tạo scope từ assignment_code/class_id/identity_ref/work_unit. Không tạo bài để cấp vé và không nhận các trường scope client tự khai. Vé append-only mặc định7ngày, không là quyền đọc hoặc nghiệp vụ; quyền nguồn đã thu hồi không cấp vé mới, backlog có vé cũ chỉ gắn scope cũ đến hạn. collect trả persisted chỉ sau ACK Collector; sai vé/phạm vi/source/schema bị từ chối.

Sáu route nghiệp vụ hiện có thêm context request khi logger bật. requestId UUID chỉ để đối chiếu; scope chụp sau grant native. Middleware đo HTTP finish và chụp ID check/receipt từ kết quả native, không ghi body/URL/token. HTTP202/409/503 vẫn http_response_only. Mốc SQL gốc giữ ID/chống trùng cũ. Hai request đồng thời hoặc phản hồi muộn giữ frame riêng, không đổi sang người/lượt hiện tại. CORS cho phép/expose đúng header x-exam-journal-request-id; không mở origin mới. Logger tắt không có hai route log và không thêm request ID.

19ca thư viện/schema và7ca runtime đạt; native46ID duy nhất theo hợp28ca nền hiện tại,4HTTP hiện tại và14provider/legacy không đổi. Lượt tổng30/31 bị child V8 fatal/Wasm sau hai subtest HTTP, không là lượt xanh; file HTTP cuối4/4 đạt và thoát bình thường, chưa sửa nguyên nhân V8. Một lượt trước lỗi fixture plain Error thay cho lỗi403 native của source; đã làm mock đúng loại, không đổi error handler production. Các schema UI/client mới chưa được phát từ Pages; còn adapter ba engine, browser/cross-origin thật, báo cáo/P3/P4 và rollout.

## Startup/đóng dịch vụ —06/11, chưa phát

Thêm helper speaking-journal-runtime.js vào đúng native webapp; mount readonly thư viện log tại src/exam-journal-runtime. Cờ EXAM_JOURNAL_ENABLED=1 và EXAM_JOURNAL_CONFIG_FILE dùng cấu trúc v1 hiện có, bắt buộc rpc.producerSpool v1. Tắt không import thư viện/đọc config/gửi request. Lỗi startup trả journal=false để giữ nghiệp vụ, console chỉ có mã cố định. configured không chứng minh Agent hoặc Collector đã nhận log. Một callable journal giữ nguyên batch capability được truyền vào cả API và Docs.

Entrypoint dừng HTTP/workers theo thứ tự native rồi flush callback API và Docs, close producer, cuối cùng đóng pool. Cả dispatcher Docs coordinated và nhịp cũ đều có flushJournal. Runtime close idempotent, vẫn thử các drain/close còn lại nếu một bước lỗi; RAM retry/pending còn lại được báo shutdown_unknown. Không cam kết SIGKILL hoặc crash trước Agent ACK được bảo toàn.

Helper6ca, thư viện/schema15ca; native42ID duy nhất theo hợp27ca đạt của lượt28, một ca khởi tạo Docs kiểm riêng đạt và14ca nền không đổi. Lượt28 có27đạt/1lỗi RPC setup JOURNAL_OUTCOME_UNKNOWN, không nhận lượt đó xanh hoặc đã sửa nguyên nhân kết nối. Cleanup thoát bình thường. Hai ca mới kiểm config thật→SQL→Agent→Collector sau drain và flush của hai dispatcher tắt. Chưa thử tín hiệu SIGTERM cả container, Google/AI thật hoặc production. Còn vé/client, báo cáo/P3/P4 và rollout; không tự mở thêm tầng đo Google nội bộ.

## Callback tới hàng chờ bền —06/11, chưa phát

Helper tách durableQueued của Agent khỏi delivered/persisted của Collector. Batch capability gom tối đa32projection, mỗi mục có deliveryId UUID riêng; trả đảo thứ tự vẫn ghép theo ID, thiếu/ACK mâu thuẫn thành unknown. Callback cũ vẫn serial. Native transaction không đợi mạng; false/throw của logger không đổi kết quả nghiệp vụ. API và worker Docs có flushJournal để dùng khi shutdown sau khi dừng nguồn phát; không đóng producer trước khi callback xong.

Factory thư viện adapters/speaking-producer.mjs dùng producerSpool v1 bắt buộc, mã hóa, batch và RAM retry đã có. Giữ nguyên callable factory với capability batch khi truyền vào API/Docs. Chỉ mode independent được gửi; không mở Speaking cũ. Còn khoảng hở trước Agent ACK và RAM retry hữu hạn, chưa phải SQL outbox.

Ca thật trên laptop dùng PGlite/Collector/Agent SQLite/host ledger giả:75mốc→tối đa10enqueue request; queue ACK khi Collector0event; Agent chết lúc claim, phục hồi và mất ACK Collector vẫn đủ75ID. Mất ACK enqueue/gửi lại không nhân đôi; Docs giả verified riêng với queue ACK. Boundary14/14 có4ca RED trên base, producer nền21/21; native40ID duy nhất theo hợp29ca nền còn hiệu lực+7Docs+4spool. Không nhận hai lượt full37/38 và37/39 là đạt: chúng lỗi RPC khởi tạo fixture, chưa có nguyên nhân kết nối chắc chắn. Sửa cleanup trước await có RED/GREEN riêng; không đổi assertion nghiệp vụ hoặc dùng force-exit cho bằng chứng GREEN cuối. Startup/vé/client, Google HTTP/auth, báo cáo/P3/P4 và production còn lại.

## Share/AI của Speaking webapp —06/11, chưa phát

Patch independent thêm provider.progress tại ranh giới fetch/https.get của source native. WeakMap lấy định danh từ claim SQL đã commit, không đổi attempts cũ trong DTO nghiệp vụ. Worker coordinated và nhịp cũ đặt AsyncLocalStorage riêng từng job; các phần Doctor chia sẻ counter nhưng giữ part riêng. Lời gọi cũ hoàn tất sau khi job đã retry vẫn thuộc run cũ; job sao chép không tự tạo quyền gắn nhãn provider. Ghi mốc này không cấp quyền chốt job hoặc thay guard owner/lease SQL.

Helper speaking-provider-journal.js quan sát started, headers/failed/outcome_unknown; trả nguyên response/error. Đếm lần gọi từ runtime, tách initial/retry/redirect/correction và đo đến headers. Không coi headers là đọc xong body, AI đã xong hoặc đã commit kết quả. Fetch redirect/retry ngầm và request bên trong n8n/provider/Google không được đếm. Không log URL, prompt, Share, headers, body, token hoặc exception message.

Chỉ copy hai helper được kê trong manifest rồi áp toàn patch lên11file native đúng SHA; không chép canonical cả backend lên live. Leaf dùng chung chỉ phát log trong context của worker webapp mới; phần legacy giữ nguyên và chưa bật. Kiểm mới gồm helper5ca, contract12ca và source-native/PGlite/Collector ký với HTTP giả, thêm5ca provider vào30ca nền hiện có. Bằng chứng/full TAP và giới hạn ở gói private homework-p2-speaking-provider-r1 của dự án chính. Còn producer bền/gom lô/retry, client/vé/startup, Google HTTP/auth, báo cáo/P3/P4; không nhận Speaking đã hoàn tất hoặc đã mở production.

## Phạm vi hiện hành và log Docs webapp —06/11

Đức chỉ yêu cầu Speaking webapp hiện hành; phần legacy bên dưới giữ làm lịch sử/tương thích, không làm tiếp hoặc dùng làm điều kiện hoàn thành. Patch independent nay gồm speaking-independent.js và speaking-progress-docs.js của đúng native. Không copy toàn module Docs canonical: native có claim/run, coordinator và work-ready khác bản canonical cũ. Patch đã áp xuôi/ngược, khớp byte nguồn thử ở cả hai file; helper chung vẫn lấy từ src/speaking-journal-boundary.js.

Queued được stage trong transaction API và chỉ gửi sau COMMIT. Worker ghi started từ SQL auto-commit, write_attempt sau khi lưu bản định ghi, write_received sau phản hồi gateway, rồi verified hoặc snapshot_applied từ đọc lại Docs và SQL cập nhật. Mất ACK lúc write hoặc SQL trả về sau readback giữ outcome_unknown; sai chủ/403/thiếu quyền sửa có lý do riêng. Snapshot cũ áp dụng xong nhưng sequence mới đã đến vẫn pending. attemptSequence, queueSequence và appliedSequence tách ba mốc; schema không nhận bản đang ghi cũ là verified của bản mới.

Scope lấy từ work_unit/profile đã xác thực; payload chỉ giữ hash theo bộ giá trị cố định, không có text/link/Doc ID/token. WeakMap native vẫn kiểm handle; không giữ transaction qua Google I/O. Trường write_received dùng snapshot SQL gần nhất của attempt, chưa chứng minh hàng đợi hiện hành đã xác minh. readCalls/writeCalls đếm lần gọi gateway, chưa đếm token refresh hoặc retry HTTP nội bộ Google. Không bật logger cho schema legacy.

Helper có thêm recordCommitted cho caller vừa nhận SQL auto-commit hoặc kết quả I/O; dùng cùng hàng RAM hữu hạn, serial, không await mạng trong nghiệp vụ. Caller chịu trách nhiệm lấy đúng bằng chứng; helper không tự chứng minh COMMIT hay Collector đã lưu. Hàng vẫn chưa bền qua crash, chưa có retry/batching/startup; không coi mốc này là xong Speaking.

Kiểm cuối30/30 nguồn native/PGlite/Collector ký khi chạy file lần lượt, gồm7ca Docs webapp; contract11/11 và helper10/10. Lượt gộp song song trước có28/30 đạt, hai ca cũ hết5giây khi pending chưa xong; giữ riêng TAP, không gọi lượt đó xanh hoặc dùng lượt serial làm sức tải. RED6 trước tính năng có5thiếulog/1đạt; ca mất ACK SQL thứ7 thêm sauRED6. Helper/direct-fact và điều kiện verified có RED riêng rồi GREEN. Google giả, không gọi provider/production. Còn provider/client/vé, producer bền/gom lô/startup, báo cáo và P3/P4 của webapp.

## Bổ sung checker legacy — chưa phát production

Patch legacy gồm ba file native: speaking-homework.js và hai runner check/practice. Giữ overlay AI native; canonical practice runner có kiểm bằng chứng AI khác native nên không copy toàn file canonical đè runtime. Manifest ghi SHA từng file và kiểm áp xuôi/ngược; hai runner chỉ khác newline ở phép dựng patch, nội dung LF khớp ứng viên đã kiểm.

Claim log lấy scope/access_grant, link revision, attempts và timestamp chính xác từ SQL đã UPDATE; DTO trả worker giữ nguyên. WeakMap giữ context theo đúng đối tượng job và chuyển qua các bản sao lane/work_kind nội bộ. Hai runner lấy adapter gắn context trước await. Kết quả accepted/rejected/failed chỉ phát sau COMMIT; job done gửi lại không phát thêm. Bốn khóa là grant/người, link+revision, job+runHash và ID sự kiện từ projection. Không ghép bằng vị trí hoặc tên.

Legacy không có owner fence như bản mới. Kết quả cũ vẫn được native chấp nhận khi job đã được nhận lại; log giữ run gốc, currentJobAttempt và claimCurrent từ snapshot SQL, không gán kết quả cũ vào run mới. So timestamp ở độ chính xác JSON SQL, không làm tròn qua Date trước so sánh. Đây là tín hiệu chẩn đoán, không cấp quyền xử lý. Context mất hoặc job khác thì bộ đếm unknown tăng và không bịa run; nghiệp vụ vẫn giữ kết quả native. Context còn trong RAM, chưa khôi phục sau restart hoặc qua JSON/RPC; startup/producer vẫn phải nối đúng.

Bộ cuối23/23ca nguồn native/PGlite/Collector ký, gồm9ca checker legacy, phủ main/practice, lỗi rồi retry, reset attempts, kết quả muộn, COMMIT lỗi, hai người trả ngược thứ tự, lỗi một phần, replay, tắt/lỗi logger và context mất. Contract10/10 và runner canonical25/25 đạt. Dùng fake Share/AI, không gọi nhà cung cấp. Giữ phần chưa làm: Doctor legacy, provider/Docs, client/vé, producer bền/retry/gom lô/startup, báo cáo/P3/P4. Không thay API hoặc runtime lớp đang thi.

## Nền và các mốc kiểm trước đó

Gói local cho Speaking mới và legacy, chưa phát production. Helper chỉ bọc transaction của Speaking, giữ nguyên `withSpeakingTransaction`/work-ready native; không sửa db.js dùng chung. Patch lấy scope từ grant đã xác thực, ghi link main/practice mới và receipt mới sau COMMIT; không thêm SELECT chỉ để lấy log. Legacy practice lấy submitted_at, main lấy created_at. Giá trị trả về API và việc gửi lại không tạo thêm link/job/receipt giữ nguyên.

ClassRef là ERP class_id dạng chuỗi; profile document chưa có lớp giữ null tường minh, không tạo lớp giả chuỗi "null". SubjectRef là profile.identity_ref của bản mới hoặc student_ref đã xác minh của legacy. Session có namespace independent/work_unit và legacy/access_grant, generation0. Nếu lớp được gắn sau đó, công cụ đọc cần tìm unit/subject qua cả scope chưa gắn và đã gắn lớp. Dữ liệu chỉ gồm ID, phần/slot, revision, trạng thái, số lượng và thời điểm native; không ghi Share/Doc ID, tên/email, token hoặc payload AI. Gửi log không chặn request; rollback/COMMIT lỗi không phát. Hàng staging và delivery có giới hạn, bộ đếm unknown/overflow; chúng chưa phải producer bền.

`native-overlay.json` ghi SHA nguồn đã chụp và hai patch. Chỉ copy thêm helper chung rồi áp đúng patch lên source native khớp, giữ mọi overlay khác. Không rebuild cả canonical backend lên runtime mới/legacy và không đổi API đang thi. Khi hết ca, đọc lại nguồn thực tế trước khi chuẩn bị phát; metadata này phục vụ đối chiếu, không đặt thêm cổng xin quyền.

Kiểm helper bằng node --test backend/test/speaking-journal-boundary.test.js. Fixture SQL nằm ở fixture/test để dùng trong thư mục thử riêng: hai thư mục independent/src và legacy/src từ snapshot native đã ghép patch/helper; ops/migrations từ backend, package.json type module và node_modules đã cài theo backend. Sao chép fixture/test vào đó. SPEAKING_JOURNAL_LIBRARY_ROOT trỏ tới tools/exam-journal của repository thư viện log; chạy node --test test/commit-collector.test.mjs từ fixture. Đầu vào là source giả lập/SQL migration và thư viện log, đầu ra là TAP; thiếu nguồn/schema hoặc assertion sai sẽ dừng kiểm. Fixture độc lập dùng PGlite và localhost, chặn SPEAKING_NATIVE_TEST_DATABASE_URL, không trỏ vào dữ liệu lớp thật.

Mốc link/receipt ban đầu đã kiểm bảy ca helper và bảy ca SQL/Collector: hai namespace, replay, COMMIT lỗi, hồ sơ document không có ERP, logger lỗi/flag false, thời điểm native, tín hiệu work-ready sau COMMIT và đọc metadata từ Collector có chữ ký. Kết quả checker tại mốc đó được seed xác định để đi tới receipt; xem bổ sung worker phía dưới cho phần SQL checker/lease mới đã kiểm. Chưa kiểm classifier AI thực hoặc hoàn tất Speaking: còn legacy worker, mốc provider/Docs, client/vé, producer bền/gom lô/startup, báo cáo, P3/P4 và kiểm native/Linux phù hợp trước mở tuyến. Khoảng hở COMMIT→callback còn; không cam kết phục hồi callback qua crash trước khi producer/outbox được nối.

## Bổ sung worker của Speaking mới

Patch independent hiện nối thêm checker started/accepted/rejected/superseded/failed và Doctor queued/started/failed/completed. Claim lấy attempts/owner đã UPDATE riêng cho log; payload worker giữ attempts cũ. Completion đọc scope/owner/lease trong SQL hiện hành; run hash đổi theo owner kể cả attempts reset. Hàng Doctor mới queued có attempts0 và chưa có run. Không ghi nội dung AI/Share/raw owner; không suy Doctor hoặc receipt thành Docs verified. Legacy hiện mới có link/receipt, còn phải nối worker theo contract riêng.

Helper chuyển từng callback trong hàng RAM hữu hạn để tránh tự mở quá nhiều request. Ca 12callback cùng lúc RED trên bản cũ, GREEN trên bản mới; nghiệp vụ vẫn không chờ mạng. Không gọi đây là producer bền hoặc batching/retry. Bộ kiểm cuối gồm 8ca helper và 14ca source-native/PGlite/Collector (7ca link/receipt hai mode +7ca worker mới), có một luồng 23event: main/practice qua checker native, receipt và Doctor; kết quả phân tích giả lập, không gọi AI/Google. Các TAP lỗi trước sửa được giữ riêng, không nhận mọi lượt đầu đều đạt.
