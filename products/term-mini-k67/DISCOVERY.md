# K67 — Phạm vi đã xác nhận và kế hoạch thực hiện
Ngày 06/10/2026; session 01a10a12-4318-7ee1-9924-9ebd1dff9ef7; plan_revision k67-v1.

## S3.1 — Ghim và dựng bộ chấm độc lập, trước triển khai

Kết quả học viên cần giữ: cùng đề, bài, thang điểm và nhận xét; thay đổi K56 sau này không đổi bộ chấm K67. Lát này chỉ tạo bộ chuyển đổi và kiểm cục bộ từ snapshot live có hash, chưa bật workflow hoặc gọi AI/Portal. S2.2 còn kiểm triển khai thực tế; kết quả 81/81 và review chỉ chứng nhận lát quyền/ngữ cảnh đã nêu trong evidence.

Nguồn live đã xác minh: default/ducizone.ddns.net có hai đầu nhận DHUgPXJdCfVZWj56, SGtuBV91Yc9oxEVt và cây con vxwctiMNBc7BnSNn gồm 48 định nghĩa; izone-ai/n8n-ai.izone.edu.vn có writer NFgOTzvfzfjwqY9x. Helper bắt đầu sửa đã tạo baseline/version manifest trong worktree n8n riêng; các snapshot đầy đủ lưu riêng trên ổ E. Registry isfTUNj1X1LJxKgg hiện nhúng ROUTES/PROMPT_LIST, không gọi kho prompt động trong lúc chấm: ghim nguyên code và dữ liệu này, không viết lại chuyên môn.

Source bộ đóng gói K67 thuộc ops/ trong package backend canonical, đúng module grading/release đã đăng ký. Repo n8n giữ snapshot phiên bản đã sanitize và manifest vận hành; không chỉnh hai bản source độc lập. Đầu vào là 49 snapshot đã ghim; đầu ra là các định nghĩa K67 inactive cùng bảng đối chiếu ID. Không dùng snapshot đã sanitize để phát hành trực tiếp: bản private giữ credential binding, bản Git chỉ giữ tham chiếu đã làm sạch.

Mỗi cạnh gọi workflow con phải đổi sang ID K67 đã biết; thiếu mapping, trùng ID hoặc còn tham chiếu về cây cũ thì dừng. Đường callback đổi chính xác từ /mapping-api sang /term-mini-k67-api. Khóa Redis termtest:writing:direct: và writing:test:sync_secret phải thành namespace riêng termmini:k67:. Quyền Redis/credential/header/webhook mới và quota phải được nghiệm thu ở S3.2 trước bật thật; tiền tố riêng chưa chứng minh quyền dữ liệu riêng.

Writer K67 chỉ nhận khóa K67; không tiếp tục nhận khóa Writing/Term chung. Giữ quy tắc không ghi đè điểm chính thức và đọc lại Portal. AI gateway vẫn là tài nguyên hạ tầng được dùng chung theo contract hiện hành, giữ nguyên model/prompt/fallback và giới hạn; không sửa gateway trong lát này. Mọi workflow mới phải all/all/true, đường webhook/UUID riêng, error workflow riêng và lifecycle rõ trước triển khai.

Định danh cần bảo toàn: jobId + runKey + taskNumber + owner workerId cho claim/result/fail; attemptToken + classId + studentId + testSlug cho Portal. Không dùng thứ tự item làm khóa. Ca kiểm S3.1 thực thi Code node qua harness với HTTP giả để quan sát đúng callback, khóa cache và từ chối sai danh tính; chưa thay native n8n/Portal/readback của S3.2.

Điểm dừng: baseline đổi, dependency ngoài danh sách, mapping thiếu hoặc code không biên dịch thì không xuất candidate. Quay lại ở lát này chỉ bỏ sử dụng candidate mới, không có mutation production để hoàn tác. Review Focus: không gọi workflow cũ; cache/khóa xác thực tách; giữ nguyên chuyên môn; identity không đổi; không bật lịch/webhook ngoài ý muốn.

## S3.2a — Kho lưu tiến độ chấm mô phỏng riêng

Kết nối hạ tầng AI/Portal: giữ credential hiện hành chỉ cho đúng 59 HTTP node cổng AI và 5 HTTP node Portal đã ghim. Đây là quyền gọi tài nguyên hạ tầng dùng chung, không phải quyền đọc kho tiến độ hoặc nhận callback K67. Không sao chép refresh token OAuth vì có thể làm hỏng phiên dùng chung. ops/shared-infrastructure-bindings.json chốt từng profile, workflow/version, node/type/URL và credential; đổi node/URL/credential thì ngoại lệ không còn hợp lệ. Redis và khóa webhook K67 luôn mới; không có cờ bỏ kiểm credential tổng quát. Mô phỏng Portal phải đổi đích ghi sang fixture riêng trước execution, không dùng điểm thật.

Trước native n8n, tạo Redis fixture riêng tên term-mini-k67-redis-fixture trên n8n-net sẵn có; không thêm mạng vào n8n hoặc sửa Redis chung. Không mở cổng ra host. Image Redis đã có trên máy chủ được ghim bằng sha256:13105d2858ded45aedf7b24f0870e6a4e7ce4964924bffce68e562ca72149f1e. Giới hạn 0,25 CPU, 128 MiB, 64 PID; Redis dùng tối đa 64 MiB, không tự đẩy mất checkpoint khi đầy, bật AOF và volume riêng. Dữ liệu mô phỏng ít, trước chạy đã đọc VPS còn khoảng 3,8 GiB bộ nhớ khả dụng và 29 GiB đĩa.

Role k67_grading được get/set/del/expire/type trong termmini:k67:* và các lệnh bắt tay/kết nối cần thiết; default tắt, không quyền CONFIG/FLUSH hoặc đọc khóa cũ. Native execution 2459232 cho thấy node Redis n8n dùng SET rồi EXPIRE riêng; execution 2459293 cần TYPE trước GET tự nhận kiểu. Cả hai có ca RED riêng và source Redis.node.js/utils.js của n8n 1.121.3 đã được đọc để đối chiếu toàn đường get/set/delete. Helper --allow-expire hoặc --allow-type chỉ sửa đúng một delta của cấu hình fixture K67 có baseline khớp, backup trước và restart đúng container fixture; không restart Redis/n8n chung. Mật khẩu mới sinh riêng, lưu DPAPI cục bộ; ACL phía Redis chỉ giữ hash. Helper tools/prepare-redis-fixture.py kiểm đúng marker/container/mount/image, chỉ tạo khi tên/volume chưa tồn tại; không tự ghi đè hoặc xóa fixture cũ. Nếu chạy dở, giữ lại để kiểm trạng thái rồi tiếp đúng bước.

Native unittest dùng redis-cli của chính container, mật khẩu qua stdin, không qua argv/log. Phải chứng minh ghi/đọc/xóa đúng khóa mô phỏng, từ chối namespace cũ, CONFIG/FLUSH bị từ chối và mật khẩu sai không dùng được. Trước/sau so image/config/mount/restart của n8n, Redis chung, PostgreSQL chung, backend chung, K56 và hai dịch vụ đang dùng cổng 8797/8799. Chưa có workflow thật trỏ vào fixture; dừng thử không làm mất bài học viên. Đây là hạ tầng thử riêng, không phải chuyển production hay bằng chứng delivery.

## S3.2b — Nối n8n với kho tiến độ riêng

tools/n8n-redis-fixture.py dùng CLI đã pin trên đúng default/https://ducizone.ddns.net, tạo một credential Redis mới bằng stdin từ DPAPI, một luồng ghi nhận lỗi K67 và một luồng kiểm thủ công. Hai workflow inactive, lưu all/all/true, tag và đăng ký vòng đời ngay sau create; ghi ý định trước API để không tạo bản trùng khi phản hồi mất. Chỉ phép thử thủ công ghi/đọc/xóa một khóa synthetic cố định riêng rồi đọc lại Redis; không gọi AI, Portal hoặc nhận bài học viên. Tái sử dụng ID đã lưu, không sửa workflow cũ.

Native execution phải hoàn thành đúng chuỗi SET→GET→kiểm nội dung→DEL, output có product và kết quả, khóa đích đã xóa. Lấy execution snapshot thật và kiểm từng node trước kết luận. So các container được bảo vệ trước/sau. Lỗi CLI/execution/readback giữ workflow inactive và bằng chứng, không tự retry khi chưa biết execution terminal. Đây là kiểm kết nối n8n/Redis, chưa phải toàn cây chấm hoặc chuyển production.

## S3.2c — Dựng cây chấm trên đúng hai instance, giữ inactive

Tạo khóa nhận thông báo K67 mới, lưu DPAPI riêng; giữ quyền gọi AI/Portal đúng bảng ghim. Dùng lại kho Redis và error workflow default đã kiểm; tạo error workflow riêng trên izone-ai cho writer. Chưa đặt biến Portal, chưa gọi AI/ghi Portal và chưa bật webhook/lịch. Bộ 49 candidate phải validate cục bộ trước API. Tạo từ lá lên cha: ID n8n thực của luồng con được đọc lại và ghi trước khi cha tham chiếu; không dùng ID dự kiến làm bằng chứng live. Sau toàn bộ, xuất lại với đủ ID thật và so node/connection/settings live, lưu snapshot private. ID, tag và vòng đời được ghi ngay; mất phản hồi giữ pending để đối soát, không tạo lại.

tools/provision-grading-bundle.py chỉ quản lý ID K67 do chính task tạo, không update workflow nguồn. Trước/sau đọc version 49 nguồn và hash cấu hình các container được bảo vệ. Mọi phiên vẫn inactive, all/all/true; lifecycle temporary có hạn 13/10 đến khi nghiệm thu/chuyển thành bản chính. test/grading-provision.test.py kiểm thứ tự dependency, graph ngoài/cycle và pending trước side effect. Đây là dựng định nghĩa và readback, chưa phải chạy cây chấm, Portal hoặc cutover.

Khôi phục lượt tạo dở: --reconcile chỉ đọc API đủ trang và journal đúng lượt, kiểm hash candidate, tên, thời điểm, nội dung và trạng thái inactive. Nếu có đúng một bản mới khớp, nhận ID đó để bước sau đăng ký/đọc lại; không create/update ở bước đối soát. Chỉ xác nhận chưa tạo khi journal duy nhất đúng lượt ghi lỗi DNS ENOTFOUND trước gửi request, stdout rỗng và inventory không có tên đó. Timeout, journal cũ/trùng, nội dung lệch hoặc nhiều ID đều giữ pending. Lượt mới ghim UUID journal vào ý định; lượt cũ chỉ được đọc một journal sau thời điểm ý định. Nhật ký khôi phục và hash được lưu trước khi gỡ pending.
Guard máy chủ dùng kết nối SSH mới trước và sau lượt API dài. Lỗi dựng và lỗi guard được ghi riêng, không để kết nối nhàn rỗi bị đóng che nguyên nhân. Thiếu readback guard vẫn unknown, không được tính nghiệm thu thành công.

## S3.3b — Backend diễn tập giữ sống, asset thật và đích điểm giả

Trong quyền chuyển/mô phỏng đã cấp, dựng đúng hai container mới trên n8n-net: term-mini-k67-http-fixture chạy Dockerfile/server.js thật và term-mini-k67-gateway-fixture chuyển tiếp tiền tố API riêng, đồng thời giả lập hợp đồng Portal. Chỉ gateway mở cổng 127.0.0.1:18867; backend không mở host port. PostgreSQL fixture được nối thêm n8n-net, không đổi container dùng chung. Backend 0,5 CPU/256 MiB/100 PID; gateway 0,25 CPU/128 MiB/64 PID; read-only, tmpfs giới hạn, không có worker sản phẩm khác.

DB trống mới term_mini_k67_test_live_<mã> và marker riêng; áp DDL 001–005. Chỉ đọc ba test_definition hiện hành từ nguồn chung, ghim hash; toàn bộ roster/người/bài/điểm là dữ liệu giả. Chép đúng chín asset đã kiểm hash/byte từ thư mục nguồn sang thư mục fixture mới, kiểm cả trước/sau; không chép source hoặc dữ liệu học viên. Tệp riêng có quyền đọc cho user node, thư mục triển khai chỉ root quản lý. Bí mật sinh/lấy từ DPAPI riêng, truyền file 0600, không đưa argv/log/source.

Gateway chỉ chuyển tiếp /term-mini-k67-api/ tới backend cố định, không nhận upstream từ request. Đích Portal giả chỉ lớp1124 và ba student ID mô phỏng9870677001–7003, sáu cột Phase1/2; khóa riêng; GET/PUT giữ định danh và record_id, không gọi Portal thật. Điều khiển/đọc bằng chứng của stub cần khóa riêng; chưa có điểm gọi vào đích thật. Lát này chưa bật n8n hoặc notify, chưa chuyển route công khai/học viên. Native test gateway kiểm khóa, whitelist đích, ghi/đọc lặp và từ chối điểm/định danh sai.

Helper ghi state/ý định riêng trước mutation, giữ nguyên khi gián đoạn, chỉ nhận lại tài nguyên cùng marker/image/DB/hash. Không tự xóa hay ghi đè tài nguyên tên trùng. Sau dựng kiểm ready, ba asset content, audio mã hóa giải lại khớp hash gốc và guard bảy container. Lỗi hoặc thiếu readback giữ partial/unknown. Dừng bản thử chỉ dừng đúng hai container thuộc task; DB/asset/bằng chứng giữ lại. Cây chấm và writer sẽ được nối ở lát kế tiếp sau backup/readback và review; không dùng thành công dựng fixture thay execution chấm.

Module RELEASE sở hữu helper/gateway; EXAM giữ app/asset nguyên hành vi; DELIVERY chỉ nhận hợp đồng giả trong phép thử. Review Focus: không chạm người dùng thật, asset đầy đủ, bí mật riêng, đúng đích Portal giả, bảo toàn K56. File mới ops/fixture-gateway.mjs, test/fixture-gateway.test.js, tools/prepare-http-fixture.py và tools/verify-http-fixture.py; không sửa source app trong lát này.

## S3.4 — Diễn tập cây chấm và ghi điểm bằng n8n thật

Chỉ chỉnh ba workflow thuộc task: default/pY437GnW09WmD9b2 và qj1aGCo406QsXtai đổi năm callback jobs sang gateway HTTP fixture nội bộ; izone-ai/nwp6ERqWKb2FkgFl đổi đúng năm HTTP Portal sang đích giả và credential header mới. Cây 48 định nghĩa chấm, prompt/model và mọi binding AI giữ nguyên. Mỗi workflow có worktree/version manifest riêng, backup bằng helper bắt đầu sửa, đọc version/nội dung ngay trước update và khóa một chủ local; restore chỉ khi live còn khớp overlay/version đã ghi. API n8n1.121.3 không có conditional PUT nguyên tử; kiểm GET→PUT không được gọi là CAS bảo đảm chống mọi writer. P2 này được chấp nhận riêng cho ba workflow inactive do task tạo và giữ một chủ, không áp sang workflow chung; chỉnh trực tiếp ngoài task vẫn là rủi ro còn lại và phải dừng khi quan sát version lệch. Không bật lịch parent; chạy manual có giới hạn. Writer được bật chỉ sau đích giả/khóa đã readback, rồi tắt/restore sau diễn tập.

Hai instance không được giả định cùng mạng. Tạo file cấu hình HTTPS hoàn toàn mới trong /etc/nginx/conf.d/, chỉ listen18868 bằng chứng chỉ ducizone hiện có, phục vụ /k67-portal-fixture/<intent>/1124/student-tests GET/PUT tới localhost18867. Không sửa vhost443, include AI hoặc route K56; không mở backend, asset hoặc route điều khiển. Khóa service riêng ở header, không đặt secret trong Nginx/source/argv. Kiểm cổng trống, file nguồn nginx.conf có include conf.d hiện hành, tên file/marker mới; mở file exclusive, sai nội dung thì dừng. nginx -t trước graceful reload và kiểm health/container trước-sau. Khi rollback chỉ vô hiệu hóa file cấu hình thuộc intent bằng rename sang .disabled sau kiểm hash, không thay file dùng chung hoặc xóa bằng chứng. Dùng khóa local một chủ cho helper; không tự sửa firewall nếu cổng bị chặn. P1 TOCTOU của cách thay vhost dùng chung đã được loại bằng thiết kế không ghi vhost.

Seed đúng termmini:k67:sync_secret trong Redis riêng bằng khóa grading_sync; từ chối giá trị đang có khác. Biến mới K67_ERP_SYNC_SECRET trên izone-ai dùng khóa erp_sync, chỉ tạo khi không có hoặc nhận lại khi bằng nhau; không xóa/tạo lại biến khác. Credential Portal fixture mới chỉ chứa x-k67-fixture-service, private DPAPI. Truyền stdin qua SDK/CLI đã pin để tránh secret trên command line; ghi ý định trước mọi mutation có thể mất phản hồi, đọc lại đúng ID/nội dung trước tiếp.

tools/prepare-grading-fixture.py quản lý baseline/overlay/Redis/biến/credential thuộc task; ops/grading-fixture.mjs sở hữu chuyển đổi chính xác và adapter SDK nhận stdin; tools/prepare-portal-fixture-route.py sở hữu file cấu hình riêng/rollback; tools/verify-grading-fixture.py sở hữu native execution và readback. Native test/grading-fixture.test.js kiểm giới hạn delta, không đổi source/AI/prompt, marker và restore khi live đổi. Dữ liệu ba bài/ba task giả đi qua HTTP thật, AI thật, callback/DB thật; Portal writer thật chỉ ghi stub, đọc lại đúng định danh. Ngân sách lượt: một bài Term1 Task2, một bài Term2 Task1+Task2; Mini kiểm lại không phát sinh Writing job. Không retry AI mù khi execution/job chưa terminal. Hỏng ở đâu giữ bài/job/log ở đó để đối soát, không reset/regrade.

Ngoại lệ lineage được Cún (/root/cun) rà ngày 06/10/2026 chỉ cho writer candidate file SHA-256 26639c562d3c14dd0e62e199137cdebd7973762d857b03272afe6eb7467a4a38, canonical body fa3ac48f1cf2b105010f9aaa99d4858a0ecb50d737b3a4986b1dac702dd96081 và report e7e5e5c10ed450c4d921d2d034e52467de8c3e5949c8bf81fa1cf925d4a51b60. Giữ native exit1/risk=true, ghi reviewed_single_entity_pending_native_readback. Webhook bản n8n đã pin đặt req.body trong một envelope; hai Code trả một item và ba IF tuyến tính; code/connections không đổi baseline. Không áp ngoại lệ cho batch, response nhiều item hoặc candidate khác. Native readback đúng ô, payload nhiều entity, các đích sai, lặp/conflict/mất ACK còn phải đạt; chưa gọi checker pass.

Runner tools/verify-grading-fixture.py chia phase prepare/step/observe/portal/off trên một journal riêng tư. Prepare nộp ba lượt giả qua HTTP và chỉ làm mới context đã nhận diện; step chạy tối đa sáu lượt parent thủ công (ba dispatch, ba collect), giữ execution ID ngay khi nhận rồi observe chỉ đọc tiếp đúng ID. Không dùng --wait trước khi giữ ID, không khởi động lại khi kết quả chưa rõ. Portal positive chỉ dùng điểm thật vừa tính từ bài giả, kiểm đúng ô và mọi ô khác không đổi, kiểm gọi lặp không mutation. Kiểm fault/đích sai và native snapshot các nhánh AI còn là phần bắt buộc kế tiếp; phase positive không chứng nhận toàn S3.4. Parent giữ inactive, writer tắt trước restore.

Snapshot execution có tham số mặc định do Workflow của n8n tự điền. Chẩn đoán execution2461179 xác nhận toàn body trùng sau dùng NodeHelpers.getNodeParameters của n8n-workflow1.118.2 đang cài, không bỏ trường khác biệt. Observe dùng SDK chỉ đọc catalog đúng profile/default và bảy loại node của parent; ghim SHA catalog 7cbe2af1ad4cc62c7f03e92a5228d88f046b452556b2365b5f240cee994522b6, SHA node-helpers.js 8f80f429c388720122e10da5fad970d22ab632d9917698b1e36b4d4c5912482c. Chuẩn hóa bản candidate đã ghim bằng hàm native trong container n8n qua stdin, so toàn name/nodes/connections/settings với snapshot và lưu proof riêng tư; không chạy workflow/AI khi đọc lại. Hash/version/image hoặc body lệch vẫn chặn. Không sửa execution cũ để nhận pass; snapshot không có versionId nên version live trước/sau và hash body cùng proof chuẩn hóa là bằng chứng khả dụng.

Execution2461179 thực tế chỉ chạy manual rỗng rồi guard trả []; không có claim/callback/AI. Đối soát riêng bằng snapshot hai node terminal và DB journal trước đó SHA ad06ce6ff2b88cf0a5361c53a4b8ef3ccf561281140892a86d0a9942fc55e6af: toàn attempts/runs/jobs/criteria/finals phải nguyên vẹn mới ghi nhận manual_empty_no_claim và gỡ pending, không tính vào sáu lượt chấm. CLI run không nhận dữ liệu trigger; parent event diễn tập bằng SDK đã cài gọi REST manual endpoint, truyền đúng một envelope {body:{kind:term_test_writing_ready},query:{}} vào triggerToStartFrom.data và startNodes là guard; native manual-execution.service.js hỗ trợ đường này. Candidate/body/version vẫn nguyên, không sửa pinData/workflow hoặc bật parent. Giữ ID ngay khi ACK và mất ACK chỉ nhận lại đúng stdout journal. Đây là mô phỏng đầu vào trigger, chưa chứng nhận xác thực HTTP Webhook thật; auth/probe native phải kiểm riêng trước chuyển. Poll tiếp tục native CLI manual bình thường.

Nghiệm thu lát này cần native execution ID/snapshot, đủ criterion/final theo runKey, callback cùng owner, điểm/nhận xét ở API và Portal giả đúng attempt/lớp/student. Kiểm lặp, điểm chính thức khác bị từ chối, mất ACK sau ghi được đọc lại; không lấy execution success thay outcome. Sau diễn tập restore candidate ghim, đọc lại inactive/settings và bảo toàn 49 source version/bảy container chung. Chưa chứng nhận Google thật, migration học viên hoặc chuyển route K67.

Review Focus: đúng đích giả; delta chỉ ba workflow/năm Portal binding; secret/namespace riêng; mất ACK/CAS không ghi đè; K56 và source cũ không đổi. Module GRADING/DELIVERY nhận hợp đồng fixture S3.3b; RELEASE sở hữu triển khai thử/backup/rollback. Bằng chứng cũ giữ revision riêng, kiểm full suite cuối theo native inventory hiện hành.

Catalog parent dự phòng có scheduleTrigger thay Webhook; bảy schema riêng đã đọc có SHA ad9015b46ffccc2c0f1ad27d7f24ebcb138a14910d27dfe1059447ba1f825c8c. Runner ghim catalog theo role, không lấy pin event áp nhầm cho poll.

## Quyền và nhu cầu
### S3.4a — Đóng lỗi readback điểm 0 trước chuyển

Native positive đã đạt ba run/12 criteria/sáu job và hai final; Cún xác nhận trên revision 15b72d01. Kiểm bổ trợ 47 execution con giữ đúng candidate/parent links và không pinData; không cộng chúng thành native full-suite ID. Writer đã inactive, chưa chuyển học viên.

P1 tái hiện bằng nguyên Code node: Portal trả ô null nhưng điểm mong đợi là 0 bị Number(null) coi là đã ghi. Regression RED exit1 trên revision 89957dfc; generator K67 sửa kiểm kiểu/nội dung trước so sánh, GREEN 19/19 trên 4570b506. Không thay writer nguồn dùng chung. Chỉ vá Code readback của writer own inactive, lưu candidate và backup mới riêng; bản overlay cũ còn nguyên để đối soát/khôi phục inactive. Candidate phát hành sau này phải sinh từ generator đã sửa.

Để kiểm native false-ACK, gateway giả bổ sung fault ack_without_write dùng đúng khóa control riêng, chỉ tiêu thụ một PUT và giữ ô giả nguyên vẹn. Nâng đúng file gateway mount của container riêng sau backup/hash/marker, restart chỉ gateway riêng; DB, image backend, bài đã chấm, cấu hình/env/quota và bảy container chung giữ nguyên. Ghi riêng nguồn image cũ và nguồn gateway mount mới, không gọi đây là rebuild backend. Tất cả điểm thử dùng ba học viên giả. Nguồn mới phải được review độc lập trước update writer/gateway; lỗi hoặc mất ACK giữ journal, chỉ đối soát đúng resource, không chấm lại AI.

Module GRADING sở hữu generator/repair writer; RELEASE sở hữu journal, backup và gateway upgrade có giới hạn. Tools/repair-grading-fixture.py chỉ chuẩn bị candidate, nâng gateway giả và update writer own; tools/verify-grading-fixture.py kiểm fault/identity/readback, kết thúc OFF rồi restore inactive/rollback route. Review Focus: null không thành 0; chỉ một Code đổi; không ghi Portal thật; giữ điểm/bài giả đã có; K56/source49 không đổi. Không mở quyền xóa hoặc ghi đè điểm chính thức. Còn S2.2/S4/S5, toàn gói chưa verified.

### S3.4b — Kiểm phản hồi lỗi theo đúng hợp đồng bên gọi

Execution writer1818405 từ chối khóa sai bằng SYNC_UNAUTHORIZED, không đổi 18 ô/sáu PUT. HTTP200 rỗng vẫn bị src/erp-sync.js từ chối vì thiếu JSON synced đúng attemptToken; app báo pending và collect giữ job processing rồi trả WRITING_PORTAL_SYNC_FAILED503. Cún đối chiếu native snapshot/caller, xác định điều kiện HTTP>=400 của runner là giả định transport không có trong hợp đồng, chưa phải lỗi báo thành công nghiệp vụ.

Chỉ sửa phép kiểm: ops/erp-response-proof.mjs replay phản hồi đã lưu qua chính createErpGradeSync với fetch tiêm vào, không gọi mạng; kiểm fetch thật sự được gọi một lần và có positive control ACK hợp lệ đúng token. Với ca khóa sai cũ chỉ có tín hiệu parse JSON thất bại, phải ghi representation-invalidJSON, không gọi byte-exact. Đối soát đúng snapshot1818405/candidate/hash/payload/Portal không mutation, bảo toàn receipt f5522643 và bản record gốc; không POST lại hoặc chấm lại AI. Ca mới lưu raw response để replay byte-exact.

Native fault vẫn cần nativeerror đúng mã, caller reject, đúng đích và readback; ca lost-ACK chỉ được phép ô đích đã ghi và gọi lặp không thêm PUT. Ca HTTP/PG mới trên DB diễn tập mới phải chứng minh ACK lỗi giữ job processing, /fail đưa retry_wait, không mất criteria/final/bài. Không sửa writer/backend nghiệp vụ hoặc dữ liệu sáu job đã hoàn tất. RELEASE sở hữu replay/runner và provenance; DELIVERY giữ hợp đồng synced đúng attempt, GRADING giữ job retry. Quay lại chỉ ngừng phép kiểm; writer OFF trước mọi sửa source.

### S3.3a — Hành trình HTTP trên DB diễn tập mới

test/integration.test.js mở HTTP thật của createApp với PostgreSQL thật, role k67_app và DB trống mới term_mini_k67_test_http_<mã lượt>. tools/run-vps-tests.py --http-only xác minh marker fixture gốc, tạo DB mới, áp DDL 001–005 và marker riêng; không sửa dữ liệu của DB gốc, backend chung hoặc K56. Giữ DB/bằng chứng khi kết thúc để điều tra, không drop. Server/đích nhận điểm HTTP chỉ lắng nghe localhost trong container test riêng, cùng đồng hồ VPS, hạn mức 0,5 CPU/256 MiB/100 PID.

Dữ liệu toàn bộ giả: ba đề tổng hợp, học viên và giáo viên example.test, asset tổng hợp nhỏ. Kiểm prepare/start/nháp/nộp lặp/Reading/Writing/result/review, callback đúng và sai owner/runKey, quyền lớp/cookie, nguồn ngữ cảnh lỗi vẫn lưu bài đã bắt đầu. Điểm Writing được mô phỏng qua callback; đích nhận điểm HTTP riêng đọc lại đúng attempt/lớp/học viên/thang điểm. Google identity được giả lập ở biên kiểm token. Không coi lát này là nghiệm thu Google thật, n8n/AI thật, asset live hoặc Portal writer; các biên đó còn phải kiểm riêng trước chuyển.

Module EXAM/ACCESS/GRADING/DELIVERY dùng source đã ghim; chỉ bổ sung lưới kiểm và runner RELEASE. Review Focus: HTTP thật dùng role thật; không mất/ghi đè nháp; callback không sai owner; quyền lớp; điểm gửi đúng định danh. Lỗi HTTP/DB/readback hoặc container được bảo vệ đổi đều chặn pass; không đổi nghiệp vụ để làm test xanh.

Nguồn: Đức yêu cầu “ok hãy thực hiện kế hoạch đến khi chuyển thành công, hệ thống được kiểm thử ổn định (không cần chờ bài làm thật, bạn cứ mô phỏng thôi nhé)”.
K67 phải phát hành/quay lui riêng; K56 giữ nguyên để Linh tiếp tục phát triển. Quyền này bao gồm triển khai K67, bản sao dữ liệu có đối soát, route K67, workflow K67 và phép thử mô phỏng. Không mở quyền xóa bài, đổi nghiệp vụ, sửa điểm thật, dừng backend chung, sửa K56 hoặc ghi DECISIONS. Git commit branch riêng là điểm khôi phục; quyền production không tự mở merge/push repo chung.

## Bảy vùng khám phá
- user_problem: phát hành sản phẩm chung làm chậm/chạm sản phẩm khác; ưu tiên Term/Mini K67 độc lập.
- journey: giữ các hành trình ba đề, lưu nháp, hạn thi, nộp L/R/W, xem kết quả, giáo viên xem đúng lớp và chấm/Portal. Bằng chứng mô phỏng phải đi qua HTTP, PostgreSQL, xử lý/callback và giao diện; không chờ bài thật.
- data: giữ 13 bảng Term/Mini, ID/token/điểm/hạn/lease/callback và 9 asset. Không mang năm bảng writing_test_* hoặc worker Speaking/Progress Log. K67 có DB và role riêng. Nguồn roster/quyền chung đi qua hợp đồng API chỉ đọc; SQL ở K67 chỉ đọc bản dữ liệu thuộc DB K67.
- permissions: giữ quyền Google/giảng viên/quản trị hiện hành; không tự mở lớp. Khóa dịch vụ/queue/workflow K67 riêng. Không ghi credential vào source. Dữ liệu giả có namespace và người thử riêng.
- failures_recovery: mất phản hồi/nộp lặp/callback muộn/lease hết hạn không làm trùng bài hoặc điểm. Quay lại phải giữ dữ liệu mới phát sinh. Chỉ một chủ ghi cho mỗi lượt. Không reset run lịch sử để làm đẹp trạng thái.
- acceptance: small_complete cho toàn gói chuyển; tất cả hành vi lõi, quyền, độc lập phát hành, bảo toàn dữ liệu, readback, full suite hiện hành và mô phỏng sau chuyển phải đạt. Không nhận hash/tool success là user outcome.
- constraints: K56 và luồng khác tiếp tục hoạt động; không dựng lại container của chúng. Giữ công thức/rubric. VPS/PG/n8n/AI dùng chung cần quota. Không có quyền destructive ngoài phạm vi di chuyển đã giao.

Nguồn hiện trạng: E:/Codex-Data/k67-backend-separation-20261006/KET_QUA_UU_TIEN_K67.md và các inventory JSON được dẫn trong đó. Worktree mới từ origin/main 30f68d2298950221240760643e77736e1dd4012c.

## So sánh và lựa chọn
Đổi tên bản clone cả backend dễ dựng nhưng vẫn kéo runtime/module/schema của sản phẩm khác; không đáp ứng yêu cầu. Chọn ứng dụng Term/Mini riêng, mang logic thuần đã ghim từ source live, có entrypoint/build/config/DB/queue/workflow riêng. Không tách theo màn/bài.
Các truy vấn mapping cũ chỉ được dùng với bản dữ liệu ngữ cảnh trong DB K67. Lát context sẽ đóng cách nhận roster/quyền qua API version hóa, cập nhật và fail-closed; chưa rollout trước khi kiểm contract này. Đây là việc kỹ thuật cần kiểm, không phải quyết định nghiệp vụ nhờ Đức chọn.

## Các module và lát công việc
- EXAM: đề, lượt thi, nháp, giờ và điểm L/R; sở hữu attempt/session/Mini result; HTTP Term/Mini hiện hành.
- ACCESS: đăng nhập và quyền lớp; sở hữu phiên K67, nhận snapshot roster/quyền qua API version hóa.
- GRADING: run/job/lease/criterion/final; nhận bài đã commit, nhận callback đúng nguồn; gọi bản chấm K67 đã ghim.
- DELIVERY: gửi/đối soát Portal theo attempt và chỉ ghi đúng ô; không ghi lặp; lỗi được giữ bền vững.
- RELEASE: build/DB/asset/route, giới hạn, backup/đối soát và quay lui riêng; không sở hữu điểm/bài.

S1 hiện đủ để bắt đầu: tạo package Term-only từ logic live đã kiểm, đường HTTP cũ cần giữ và native unit/database fixture tương ứng. Lệnh dựng riêng, không start worker khác. Chưa nối production.
S2: DB riêng, context API và migration diễn tập; chốt metadata/grant/trigger rồi kiểm restore, identity và quyền thật.
S3: hai đường nhận việc, 48 định nghĩa graph tĩnh/bản ghim, Registry/prompt, writer riêng; kiểm callback/retry/lease/Portal giả.
S4: tích hợp frontend và storage key; mô phỏng đủ ba đề/giáo viên, fault/recovery và độc lập K56; review độc lập trên revision hiện tại.
S5: snapshot cuối, thu việc K67 đang chạy, một chủ ghi, chuyển route/caller K67 và kiểm mô phỏng sau chuyển; chỉ hoàn tất khi checker và outcome đủ.

Mỗi lát sau phải cập nhật contract/file responsibility/task graph và bằng chứng trước phần source phụ thuộc; câu chưa rõ chỉ chặn lát đó. Mục tiêu cuối không thu nhỏ về S1.

## Thiết kế vận hành và điểm dừng
Dùng hạn mức K67 hiện tại làm nền bảo toàn: 0,5 CPU, 256 MiB, 100 PID, DB pool 5; cần đo khả năng của bản mới. Bài thi lưu nhanh, chấm dài hiển thị đang chấm. Hàng chờ bền vững, retry có giới hạn; timeout dịch vụ không mất bài.
Ngưỡng tải: chưa có số peak live đủ chắc, kiểm trước rollout bằng phiên giả từ 1 lớp, rồi số đồng thời tăng có giới hạn; không stress hệ chung không kiểm soát.
Theo dõi health/readiness/version, queue age/lease, callback lỗi và readback; log không chứa bài/token.
Dừng chuyển khi có phiên còn hạn/job chưa có ownership rõ, dữ liệu lệch, quyền sai, P0/P1 fail, lỗi restore hoặc K56 image/config/schema thay ngoài gói. Giữ source runtime cũ và bảo toàn ghi mới để quay lại.
Review Focus: không mất bài; không sai quyền/lớp; không double-owner; không sai điểm/Portal; phát hành/quay lui K67 không đổi K56.

## Trạng thái tiếp tục
Worktree đã tạo và đăng ký sản phẩm. Package Term-only đã dựng; 50 native unit/boundary đạt trên revision c01f0c17a83b9f2abf5d71ffc6bd6eedd55e137906f39ccd96a70ce4cf445c20, không fail/skip. Đây là phản hồi cục bộ, chưa nghiệm thu toàn gói hoặc triển khai. Caller Mini cũ và Registry động vẫn phải đóng trước chuyển hoặc giữ adapter tương thích có test.

## S2.1 — Dữ liệu và quyền ở môi trường diễn tập

Ngày 06/10/2026 đã đọc lại DDL PostgreSQL 16.14: 13 bảng Term/Mini, view Mini và 26 trigger lịch sử thay đổi. Trigger gọi collaboration.record_row; hàm này chỉ ghi vai trò quản trị được theo dõi, không chép giá trị bài/điểm/khóa bí mật. DB mới giữ cơ chế này cùng hàm reset chỉ cho lớp CODEXDEMO806; không tạo năm bảng Writing khác.

Chọn PostgreSQL riêng cho K67, dùng image postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777. VPS 4 CPU, RAM khả dụng khoảng 4 GB, đĩa còn khoảng 29 GB tại lúc đọc. Môi trường diễn tập dùng container term-mini-k67-postgres-fixture, cổng localhost 55467, tối đa 0,5 CPU/256 MiB/100 PID; không đổi container/role/schema hiện hành. Production sẽ có runtime DB riêng và volume riêng; quota production còn phải kiểm tải trước chốt.

DB diễn tập term_mini_k67_test_database: k67_owner sở hữu cấu trúc; k67_app chỉ CRUD bảng thi, đọc ngữ cảnh, mở/cập nhật phiên và các cột liên kết Google/last_login của tài khoản; không được sửa quyền, schema hoặc nhật ký. k67_context_sync chỉ đồng bộ bảng ngữ cảnh, không được viết bài/điểm. Mọi role chỉ tồn tại trên PostgreSQL riêng, không được dùng credential chung.

Schema mapping trong DB K67 là bộ đệm thuộc K67 cho lớp, roster và quyền đã nhận; giữ tên cột/hợp đồng SQL cũ. Không sao chép toàn database hoặc dữ liệu học viên vào Git. Nguồn ngữ cảnh tiếp theo dùng API v1 chỉ đọc, khóa riêng, allowlist lớp và timeout; phải có kiểm snapshot nguyên tử, quyền bị thu hồi và nguồn lỗi trước rollout. Các phép thử S2.1 dùng lớp/học viên giả và không phụ thuộc quyết định scope lớp live của S2.2.

S2.1 được phép bắt đầu: tạo DDL từ snapshot có hash, dựng DB fixture riêng, kiểm restore/constraint/role/history trên PostgreSQL thật. Dừng khi source thiếu dependency, actor không được ghi lịch sử, runtime đọc được role/quyền ngoài phạm vi hoặc schema phụ xuất hiện. Không dùng kết quả S2.1 để tự cho phép cutover.

## S2.2 — Nhận ngữ cảnh qua API chỉ đọc

Ngày 06/10/2026 đọc lại các lớp có roster/lượt thi/học viên tạm trong DB Term hiện hành: -8062028, 1124, 1131, 1135, 1157, 1166, 1187, 1199, 1226, 1250, 1293. Đây là phạm vi tương thích sản phẩm Term/Mini, không thu hẹp thành một lớp IC2304. Tên lớp và người được cấp quyền do nguồn hiện hành quyết định; muốn mở lớp mới cần thêm đúng ID vào allowlist đã kiểm.

Một dịch vụ nguồn riêng, pool 2, chỉ đọc năm view có whitelist cột trong namespace k67_context_api_v1. View lọc lớp thuộc allowlist và tài khoản admin/giáo viên được cấp lớp đó; role không đọc được bảng gốc. Không sửa runtime hay cấu hình backend chung. Snapshot nhất quán trong transaction REPEATABLE READ READ ONLY, API v1, product_id cố định, source_revision SHA-256 và captured_at UTC. API cần khóa riêng, timeout 5 giây, giới hạn trả về 1 MiB, không trả khóa phiên, bài thi hoặc điểm.

Một tiến trình đồng bộ riêng gọi API mỗi 30 giây và ghi transaction nguyên tử vào bộ đệm K67 bằng k67_context_sync. Snapshot quá 120 giây, ở tương lai quá 5 giây, sai product/version, duplicate ID hoặc dữ liệu ngoài scope bị từ chối; snapshot cũ hơn bản đã áp dụng không ghi đè. Roster/quyền chỉ được dùng để mở lượt mới hoặc cho giáo viên xem khi snapshot còn hạn. Các route lưu nháp/nộp/resume/result/callback theo token đã có vẫn chạy trên DB riêng khi nguồn ngữ cảnh lỗi. Không cho nguồn lỗi mở thêm quyền.

Tài khoản bị bỏ khỏi nguồn được vô hiệu hóa; đổi subject/quyền thu hồi phiên cũ. Subject NULL từ nguồn không xóa liên kết Google đã xác nhận tại K67. Role đồng bộ được đọc email phiên và cập nhật revoked_at/revoked_reason để thu hồi, không đọc token_hash, không tạo phiên, không viết bài/điểm. DB fixture bổ sung revoked_reason mà auth.logout hiện hành cần; source đang chạy đã có cột này, không phải đổi nghiệp vụ.

S2.2 được phép bắt đầu cục bộ/fixture: src/context-contract.js kiểm hợp đồng; context-source.js/server chỉ cung cấp snapshot; context-sync.js/server chỉ nhận/áp dụng; context-guard.js chặn quyền/roster hết hạn; app/server/config nối guard; db/005-context-auth.sql là delta fixture; db/006-context-source.sql định nghĩa view/grant nguồn dự kiến. Chưa chạy DDL namespace nguồn hoặc phát hành các dịch vụ trước kiểm/review. Các test native phải chứng minh snapshot nguyên tử, rollback khi sai, không resurrect phiên cũ, nguồn lỗi giữ quyền đóng nhưng bài đã bắt đầu còn lưu được.

Review Focus S2.2: không cấp quyền từ snapshot sai/cũ; không lộ token; không mất bài khi nguồn lỗi; không ghi ngoài DB K67; không sửa bảng/runtime K56.

## Môi trường kiểm tích hợp hiện hành

Ca API nguồn trên Windows bị chặn vì đồng hồ VPS đi trước khoảng 15 giây (đo hai mốc UTC trước/sau lệnh date chỉ đọc). Giữ ngưỡng tương lai 5 giây; không nới để làm xanh test. Chuyển bộ native hiện hành vào container Node riêng trên VPS, dùng cùng clock/network namespace của PostgreSQL fixture. Không dùng container backend chung để chạy test. Container test có tên riêng, 0,5 CPU/256 MiB/100 PID, tự xóa khi test kết thúc; nguồn/khóa test ở thư mục riêng đã kiểm, nguồn không chứa secret. Khóa fixture truyền env-file 0600 rồi xóa đúng file sau dùng; raw stdout/stderr và native exit được lưu local với revision. Dockerfile.test và tools/run-vps-tests.py sở hữu việc này; không chuyển route học viên hoặc sửa K56. Build ghim base image digest đã đọc từ Docker.
