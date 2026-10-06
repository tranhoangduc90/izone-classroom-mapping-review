# K67 — Kế hoạch kiểm theo hành vi
Phạm vi cuối: chuyển toàn Term/Mini K67 ổn định bằng mô phỏng; small_complete; không chờ bài thật.
## Native suites dự kiến
- S3.4a: tools/repair-grading-fixture.py chuẩn bị candidate/validate/trigger/lineage, chỉ update writer own inactive sau review đúng hash; nâng đúng gateway mount sau backup và kiểm marker, giữ DB/Portal state và APP. Native false-ACK điểm0 phải bị từ chối, lưu thật0 phải synced; mất ACK sau ghi đọc lại và gọi lặp không thêm PUT; sai khóa/đích/grade và điểm chính thức khác phải không đổi ô. Mọi lần giữ nguồn49/container7, journal không cho retry mù hoặc ghi đè candidate cũ.
- k67-grading-fixture: node --test test/grading-fixture.test.js; biến đổi chính xác hai parent/năm Portal node, giữ nguyên AI/prompt/trigger/ID và nguồn đầu vào; từ chối baseline/credential/intent/host lạ. Native tools/verify-grading-fixture.py kiểm execution n8n/AI thật, callback/DB theo runKey/owner, ba Writing task ở hai Term, Mini không có job, Portal giả đúng ô/readback/lặp/mất ACK/điểm khác; guard49 source/bảy container và restore inactive. Mock chuyển đổi không thay native execution.
- k67-portal-fixture-route: HTTPS18868 chỉ namespace Portal giả theo intent; route backend/control/asset không mở, GET/PUT có khóa, sai khóa/lớp bị từ chối. Chỉ cấu hình mới exclusive, giữ byte vhost443 trước-sau; nginx -t/graceful reload/readiness cùng route chung; rollback chỉ file intent, không ghi đè thay đổi khác. GET→PUT workflow chỉ là guard có giới hạn, không phải atomic CAS; ba ID riêng và khóa một chủ local giữ phạm vi rủi ro P2.
- k67-fixture-gateway: node --test test/fixture-gateway.test.js; HTTP thật localhost kiểm proxy tiền tố cố định, query/body/header giữ nguyên, ranh giới route, khóa Portal/control, whitelist class/student/record, Band hợp lệ, readback/lặp, và dữ liệu không đổi khi request sai. Không gọi API ngoài.
- k67-live-http-fixture: tools/verify-http-fixture.py trên đúng state/marker/DB/container mới; ready của server thật, ba content có hash/chủ đề ghim, nghe thử và audio mã hóa của phiên giả giải lại khớp file gốc, dữ liệu seed giả, image/config/quota/network/guard trước-sau. Không nhận là chấm n8n/AI hoặc Portal thật đã đạt.
- k67-grading-provision: unittest test/grading-provision.test.py kiểm tạo từ lá lên cha, graph ngoài/cycle, mất ACK không create lại, tag/lifecycle lỗi tiếp cùng ID; đối soát DNS không tạo lại hoặc nhận đúng ID/nội dung, giữ pending khi timeout/journal cũ/trùng/nội dung/thời điểm sai; guard SSH mới không che lỗi dựng (RED/GREEN). Native deploy-inactive còn phải đọc đủ 49 ID thật/nội dung/status/lifecycle và version nguồn/cấu hình được bảo vệ; chưa tính thành execution chấm hoặc Portal.
- k67-n8n-intent: unittest test/n8n-fixture-intent.test.py; log lượt cũ không được gỡ lượt mới chưa biết kết quả, log đúng lượt nối đúng execution, kết quả execution khác workflow bị chặn. Mock API chỉ để kiểm phục hồi ý định; native n8n vẫn kiểm riêng.
- k67-n8n-redis: n8nctl workflow run trên luồng thủ công K67 đã đăng ký; execution snapshot phải success, đủ node SET/GET/assert/DEL, kết quả đúng PRODUCT-TERM-MINI-K67 và Redis thật không còn khóa thử. Không dùng status execution đơn lẻ thay readback.
- k67-redis-fixture: unittest trong tools/prepare-redis-fixture.py --verify dùng redis-cli thật của container riêng; native ID test_own_namespace_round_trip, test_native_expire_command, test_native_type_command, test_foreign_namespace_denied, test_admin_commands_denied, test_wrong_password_denied, test_anonymous_denied, test_runtime_boundary. Kiểm EXPIRE/TYPE riêng đúng cách node n8n dùng, khóa ngoài phạm vi vẫn bị từ chối; ACL, AOF, quota, mount/network và cấu hình các dịch vụ được bảo vệ trước/sau; không dùng mock thay quyền Redis thật.
- k67-grading-bundle: node --test test/grading-bundle.test.js; từ chối mapping thiếu/trùng/trỏ về cây cũ, đổi callback/cache/khóa riêng, giữ prompt và topology, bỏ pinData/staticData, không sửa đầu vào. Thực thi Code node fixture để kiểm callback và writer xác thực đúng/sai, không gọi mạng. Kiểm toàn bộ snapshot có hash và biên dịch Code sau dựng. Đây là kiểm bộ đóng gói, chưa phải execution n8n hay kết quả AI/Portal thật.
  Regression readback điểm 0: chạy nguyên Code node sinh từ snapshot ghim; ô thiếu/null/rỗng/khoảng trắng hoặc kiểu boolean/array/object phải từ chối, điểm số 0 và chuỗi số 0 hợp lệ phải synced. Giữ RED trên generator trước sửa và GREEN sau sửa; native false-ACK không ghi vẫn phải bị từ chối trước chuyển. Chỉ sửa writer K67, writer nguồn chung giữ nguyên.
- k67-unit: node --test test/term-tests.test.js test/mini-tests.test.js test/term-test-assets.test.js test/term-test-writing-notifier.test.js; bảo toàn chấm L/R/Mini, asset/session và notifier.
- k67-boundary: node --test test/runtime-boundary.test.js; HTTP chỉ Term/Mini/auth/health, route khác 404, DB config và entrypoint không khởi động worker khác.
- k67-database: native fixture PostgreSQL/PGlite hiện có, sau đó PostgreSQL thật với role riêng; kiểm nháp/giờ/nộp lặp/quyền và migration đối soát. Chốt file inventory trước chạy; không lấy mock làm bằng chứng grant.
- k67-integration: HTTP browser + container K67 + PG riêng + n8n K67 + Portal fixture, fault/retry/readback và restart/quay lui. Native runner/IDs được collect trước kiểm; chưa định danh là chưa đủ coverage.
## Kiểm hợp đồng phản hồi lỗi S3.4b

test/erp-response-proof.test.js chạy createErpGradeSync thật với fetch tiêm vào: HTTP200 rỗng/HTML/JSON sai/ACK sai token phải bị từ chối; ACK synced đúng token phải được nhận; HTTP lỗi dù body hợp lệ vẫn từ chối. Mỗi probe phải gọi fetch đúng một lần. Native fault runner replay status/raw body đã nhận và giữ nativeerror/identity/Portal readback. Ca1818405 chỉ replay tín hiệu invalidJSON đã ghi, có provenance snapshot và receipt thất bại nguyên vẹn; không nhận byte-exact hoặc native execution mới. Ca queue HTTP/PG trên DB mới giữ job/kết quả khi Portal lỗi; không sửa/reset job đã chấm.

## Bất biến cần chứng minh
K67-ISOLATION: restart/deploy/rollback K67 không đổi K56 image/config/schema/consumer.
K67-PRESERVE: attempt/token/nháp/hạn/điểm/asset không thay trong bản sao/chuyển.
K67-AUTH: giảng viên chỉ lớp được cấp; admin đúng quyền; nguồn quyền lỗi không mở quyền.
K67-ONCE: nộp lặp/callback đến muộn/mất ACK/lease hết hạn chỉ một chủ và một kết quả.
K67-PORTAL: đúng lớp/học viên/đề/thang điểm; đọc lại đích sau ghi, không dùng API success thay outcome.
K67-COMPAT: giữ endpoint Mini cũ, storage key cũ và callback cũ đến đúng bên.
K67-RECOVERY: quay lui giữ dữ liệu mới; kiểm backup/restore ở đích cô lập.
## Quy tắc bằng chứng
Observe parent kiểm toàn snapshot sau chuẩn hóa bằng đúng hàm native đã ghim cùng bảy schema node ở profile/default. Đổi code/URL/credential/connections/settings hoặc schema/hàm chuẩn hóa phải bị chặn; thêm mặc định n8n chỉ được nhận khi toàn body sau chuẩn hóa trùng. Giữ execution ID đã chạy, không chấm lại để sửa phép đối chiếu.
Nhóm k67-http-native (test/integration.test.js, run-vps-tests.py --http-only): native HTTP+PostgreSQL trên DB mới có marker. Native ID riêng cho hành trình Term 1, Term 2, Mini; cookie/quyền lớp; nguồn ngữ cảnh hết hạn vẫn giữ bài đã bắt đầu; Mini callback cũ đúng khóa/không ghi trùng; readiness/CORS/đường sản phẩm khác đóng. Trong hành trình Writing kiểm owner/runKey sai không mutation, callback lặp không tạo thêm tiêu chí, result/review và đọc lại đích nhận điểm HTTP giả. Không gọi biên Google/n8n/AI/Portal thật đã passed từ các ca này.
Selector release, unknown giữ bộ rộng. Thu native inventory/executed IDs từ runner. Receipt ghi revision, runner, env/config/fixture, failed/skipped/exit và log thật; không gắn pass cũ vào revision mới.
Không có lỗi người dùng mới đang sửa trong S1; nếu phát hiện lỗi runtime, thêm regression RED trên base/GREEN trên head.
Nhóm unit/boundary là phản hồi sớm, chưa đủ phát hành. Full suite hiện hành, review độc lập, quyền DB thật, mutation readback và mô phỏng vận hành sau chuyển đều bắt buộc.
Mọi điểm mô phỏng phải có dữ liệu giả/đích thử được xác định; không đổi điểm học viên thật để chứng minh pipeline.

## Native kiểm ngữ cảnh và phiên

test/context-contract.test.js: contract v1/product/scope/UTC/duplicate/hash/size; HTTP nguồn từ chối khóa sai; snapshot đọc nhất quán; guard hết hạn chỉ chặn mở lượt/quyền, không chặn đường lưu/nộp theo token.
test/context-database.test.js: PostgreSQL fixture với role k67_context_sync; snapshot nguyên tử và cũ không ghi đè; nguồn sai không đổi mirror; quyền thu hồi vô hiệu cookie cũ; NULL source subject giữ binding; logout đọc lại revoked_reason; không đọc token_hash hoặc tạo phiên bằng role đồng bộ. Dùng runner SSH tunnel riêng, marker và lớp giả; không test trên dữ liệu live.

Ca đồng thời ép đăng nhập dừng sau kiểm tài khoản, đồng bộ thu hồi/cấp lại, rồi mới tạo cookie; phiên cũ phải bị từ chối. Ca thêm lớp cũng phải thu hồi cookie cũ trước khi quyền mới được dùng. Hai ca đã RED trên bản trước sửa; giữ nguyên log và revision của mỗi lần chạy.

Ca yêu cầu đang chạy dừng sau xác thực admin rồi đồng bộ hạ quyền trước SQL phải không trả lớp qua phiên đã thu hồi. Cả bốn truy vấn giáo viên kiểm tài khoản/subject/phiên/quyền trong cùng snapshot với dữ liệu; ba truy vấn kết quả/chi tiết còn được chạy trực tiếp trên PostgreSQL thật với phiên hợp lệ, lớp ngoài quyền, Bearer đúng/sai subject, cờ admin cũ, thu hồi và cấp lại. Chứng cứ xác thực chỉ truyền nội bộ từ middleware sang SQL, không nhận từ body/query và không trả hash phiên ra HTTP.

## Dựng mới và phục hồi S2.1

tools/test-bootstrap-restore.py dùng container PostgreSQL fixture có marker đã kiểm; tạo hai DB mới tên ngẫu nhiên dưới tiền tố term_mini_k67_test_. Áp nguyên bộ DDL 001–005 vào DB trống, kiểm 13 bảng assessment, 26 trigger lịch sử và quyền hai role. Ghi đề/lượt thi/nháp bằng dữ liệu mô phỏng, chạy pg_dump định dạng custom và pg_restore thật sang DB trống thứ hai, so nội dung, token, hạn, nháp và số thứ tự lịch sử; kiểm quyền và trigger tiếp tục hoạt động ở đích. Giữ bản dump riêng tư và hai DB diễn tập để điều tra, không drop/reset dữ liệu có sẵn. So cấu hình/image/restart của backend chung, K56 và PostgreSQL chung trước/sau. Lỗi SQL, restore, sai dữ liệu hoặc thay đổi thành phần được bảo vệ làm runner thất bại. Đây là kiểm cơ chế phục hồi; chuyển dữ liệu thật vẫn cần đối soát riêng ở S5.

## Đã thực hiện sau chuyển — 06/10/2026

Phạm vi chuyển K67 đã đạt bằng mô phỏng theo yêu cầu; trạng thái và các
biên nhận riêng tư có đường dẫn kiểm được ở RELEASE_STATUS.md.

- `production-migration.py`: snapshot cuối, restore một lần vào đích trống,
  hash 13 bảng, 15 FK, sequence và 26 history trigger; source fence riêng.
- `verify-production-journeys.py`: ba học viên giả mới, đề/audio đã ghim,
  deadline/nháp/nộp lặp, sáu job chấm thật xử lý một lần, kết quả API hiện
  ra; không tạo job Portal thật. Pha `observe` chỉ đọc lại, không chấm lại.
- `verify-historical-preservation.py`: hash 13 bảng lịch sử sau mô phỏng và
  diễn tập quay lại vẫn bằng snapshot; chỉ loại đúng dữ liệu giả của intent.
- `rehearse-production-release.py`: đổi sang runtime K67 riêng rồi trả bản
  chính, cùng DB có bài mới; ba kết quả giữ nguyên, standby đã dừng. Chín
  ca hồi phục local kiểm forward lỗi/gián đoạn, file lạ, shared đổi, mất ACK
  khi stop và container bị chạy lại. Không suy thành thử bản nghiệp vụ khác.
- Giao diện: ghép đủ 59 native ID cùng nền/cấu hình; chỉ chạy lại ca K56
  timeout còn thiếu. Chín trang live có kiểm Chrome/roster/CORS/CSP mới.
- `verify-production-readiness.py`: chỉ đọc runtime/DB/quyền/Redis/ngữ cảnh,
  chín hash asset, API/CORS và trạng thái nguồn/đích; core guard trước/sau.

Các ca native đã đạt trên source ảnh ghim được giữ, không gắn pass sang
nghiệp vụ khác. Helper vận hành/tài liệu thay đổi không đổi 20 file trong
ảnh; khi đổi source/config/fixture, chọn lại ca chịu ảnh hưởng. `npm test`
bao gồm ca cần PG và HTTP fixture riêng; không chạy trên DB production.
Đăng nhập Google thật và điểm thật ở Portal chưa được thực hiện trong lượt
chuyển này; boundary/quyền và callback được kiểm bằng fixture/mô phỏng.
