# Phương án dùng database mapping chung cho bài thi K56

Trạng thái: **Đức đã chọn kho chung và chấp nhận cập nhật API K67 khi cần; chưa có mutation production**. `plan_revision=k56-shared-db-v2`. Trong cùng `mapping_db`, K67 giữ schema bài thi `assessment`, K56 dùng schema bài thi mới `assessment_k56`; cả hai đọc schema lớp `mapping` chung. Bản v2 thay thế giả định hai khóa dùng chung bảng của v1 sau khi kiểm tra quyền dữ liệu. Phương án B3–B6 trong `MAPPING-BRIDGE-PLAN.md` dựa trên database K56 riêng đã **stale** đối với hướng này; không chạy các lệnh migration/backup/compose của phương án cũ trên `mapping_db`. B1 — ERP khóa 56 `on_going` là nguồn phạm vi — vẫn dùng được, nhưng số lớp và học viên phải đọc lại sát thời điểm phát hành.

## Kết quả người dùng và phạm vi

Học viên của mọi lớp K56 còn `on_going` trên ERP thấy đúng Term Test 1, Term Test 2 và Mini Test K56; giảng viên/admin xem đúng lớp, bài Writing được chấm qua tuyến chung và bài/điểm cũ không mất. K67, Writing Test và các bài Substitute không đổi về quyền, dữ liệu hoặc hàng chờ. Không tự ghép Classroom cho IC2322/IC2326, không mở lớp lịch sử, không đổi prompt/model chấm hay điểm đã ghi. Đây là thay đổi `controlled` vì tác động kho có bài đang chấm và dữ liệu học viên.

## Bằng chứng chỉ đọc ngày 24/09/2026

`compare_database_layout.py` đọc đúng hai container API, chỉ chạy `SELECT` trong giao dịch `READ ONLY`, chỉ xuất metadata/số đếm. `bridge_dry_run.py` đọc lượt ERP mới nhất và giữ định danh học viên trong RAM; không có ghi production.

| Nội dung | `mapping_db` chung | `izone_mapping_k56_ic2264` |
| --- | ---: | ---: |
| Mapping lớp | 1.236, gồm đủ 29 lớp K56 hiện tại | 1 lớp IC2264 |
| Định nghĩa đề | 3 slug hiện hành `term-test-1`, `term-test-2`, `mini-test-lesson-5` | 3 slug K56 khác tên |
| Roster bài thi | 46 | 36, thuộc IC2264 |
| Lượt làm bài / phiên thi | 137 / 122 | 0 / 0 |
| Job Writing / kết quả Writing cuối | 257 / 72 | 0 / 0 |
| Bảng `term_test_portal_sync_state` | Chưa có | Có, 0 hàng |
| Cột của `term_test_roster` | Cùng cấu trúc cơ bản | Cùng cấu trúc cơ bản |

Lượt ERP `sync_run_id=102` có 29 lớp, 447 học viên đủ điều kiện và 510 hàng snapshot tổng. Có 1.341 hàng roster K56 cho ba đề; 36 hàng IC2264 đã có UUID riêng theo từng đề trong kho K56, nên khi chuyển phải giữ nguyên các UUID đó. Đức xác nhận IC2322/IC2326 chưa khai giảng nên thiếu Classroom là bình thường, nhưng **vẫn mở bài cho hai lớp này** theo quy tắc ERP `on_going`; dùng danh sách ERP, không tự ghép Classroom. Các số này là baseline quan sát, không phải hằng số để ép lần ghi sau.

Backup ngày 24/09 đã chụp **cả hai** database trong thư mục riêng `/opt/backups/k56-shared-cutover-e4KMSNeA` trên VPS và phục hồi thử vào hai database tạm. Bản phục hồi đọc được 1.236 mapping lớp ở kho chung và 36 roster K56 ở kho cũ; hai database tạm đã được dọn bởi script. SHA-256 archive chung `b098540963f07fc39057bbd20d0f27095ff719c1b80135926d955280f4178281`, archive K56 cũ `020507efaad2a82c9374b280c3c64c7f1d0777d0e61725ab06aa`. Chưa có migration hay dữ liệu production nào được ghi trong bước này. Trước cutover phải xác nhận backup còn tồn tại, hash khớp và chụp thêm nếu dữ liệu đã thay đổi đáng kể.

**Phát hiện chặn cắt chuyển trực tiếp:** hai API hiện dựa vào việc database tách riêng để cô lập loại đề. Bộ test profile cũ còn mong đợi API K56 nhìn thấy cả slug K67 nếu hai loại cùng có mặt trong một schema; nhiều route nhận `testSlug` nhưng chưa kiểm profile tại cửa vào. Toàn bộ bảng `assessment` của kho chung có `row_security=false`; cấp quyền bảng cho role K56 không tự giới hạn hàng K67. Chỉ đổi `DATABASE_URL` sẽ mở đường truy cập chéo và có thể khiến hai API nhận nhầm job Writing. Vì vậy bản v2 giữ cách ly bằng **schema bài thi + role**. Test local đã chứng minh cùng một database vẫn đọc đúng roster hai khóa, role K56 chỉ được cấp schema K56 và không đọc được `assessment`. Bản thử chưa chứng minh đầy đủ mọi route, job, migration hoặc hành vi production.

## Hợp đồng dữ liệu và quyền

- Nguồn lớp: `mapping.sync_run` hoàn tất mới nhất của `n8n_k56_erp_ongoing`, ghép `mapping.classroom_course_mapping` theo **ID lớp ERP**, không theo tên hiển thị.
- Nguồn học viên: hàng snapshot cùng `sync_run_id`, `source_state=active`, `registration_status=on_going`; khóa `(erp_course_class_id, erp_student_contact_id)`.
- Đích roster: `assessment_k56.term_test_roster`, khóa `(test_slug, class_id, contact_id)`; `student_ref` cũ IC2264 giữ nguyên theo từng slug. Chỉ cấp UUID cho khóa chưa tồn tại. Khi chạy lại cùng lượt không sinh bản ghi/UUID mới. Không chép thêm mapping lớp sang schema khác.
- Quyền mở bài: `(test_slug, class_id)` chỉ được bật khi đủ định nghĩa, roster, profile guard và readback. K56 mặc định đóng; các slug K67 không tham gia bảng quyền K56.
- Admin vẫn có thể thấy lớp ngoài phân công để xử lý vấn đề; quyền xem lớp này không tự cấp quyền mở bài cho học viên. Không lọc mất lớp khỏi danh sách admin chỉ vì chưa có roster hoặc chưa khai giảng.
- Ghi điểm, job chấm và Portal giữ `attempt_id`/`test_slug`; không ghép output bằng thứ tự, tên học viên hay job đầu tiên. Bộ chấm giữ cùng logic/prompt/model đã chốt nhưng mỗi API chỉ nhận việc trong schema của mình; không gộp hai hàng chờ bằng ID hay thứ tự.
- Quyền database: không dùng chung credential API K67 cho API K56. Role K56 chỉ có quyền đọc `mapping` cần thiết và quyền ghi `assessment_k56`; không có `USAGE`/quyền trên `assessment` K67. K67 tiếp tục dùng role/schema cũ, không cấp quyền mới trên `assessment_k56`. Toàn bộ SQL của K56 phải được định tuyến tới schema mới kể cả transaction, đồng bộ Portal, job chấm và truy vấn giáo viên. Nếu query lọt sang `assessment` hoặc role sai, phải lỗi đóng chứ không đọc/ghi K67. Không đưa secret, tên/ID học viên hoặc JSON đề sống vào Git/log.

## Các lát thực hiện

| ID | Consumes → produces | Kiểm chứng và điều kiện đóng | Phụ thuộc |
| --- | --- | --- | --- |
| S0 — baseline | Hai DB/API đang chạy → snapshot cấu trúc, số đếm, image và trạng thái job | Read-only; nguồn/lượt mới không tụt bất thường; xác nhận 0 bài K56 trong kho riêng trước cắt chuyển. | B1 |
| S1 — cách ly profile | Source live K67/K56 + ma trận query/route → định tuyến SQL K56 sang `assessment_k56`, giữ quyền xem mọi lớp của admin tách khỏi quyền mở bài, role/schema tách biệt, regression RED/GREEN | Test bằng role thật: K56 không thể đọc/ghi/claim K67 và ngược lại; mọi query K56 được rà, kể cả transaction/job; full suite K67, K56, Substitute và Writing không giảm; so candidate exact-source với image live. Nếu không đạt, dừng. | S0 |
| S2 — schema K56 trong kho chung | Backup + S1 → chạy migration 003 (cấu trúc, chỉ một lần), 004 (đủ điều kiện) và 005 (cổng quyền) trên `assessment_k56`; nhập 3 định nghĩa K56 và cấp role riêng; chưa nhập roster | Kiểm schema chưa tồn tại trước migration 003; nếu đã tồn tại thì dừng/readback, không chạy lại. Backup có restore drill; schema/tables/indexes/functions/grants và hash ba đề được so với nguồn; 0 bài/roster K56 sau bước này; `assessment` K67 rows/job/điểm và schema bất biến; không log nội dung đề. | S1 |
| S3 — canary không có học viên | Role/network/API K56 candidate → canary dùng kho chung nhưng chưa chuyển URL công khai | Health, quyền role, 404/403 chéo profile, lớp chưa bật vẫn đóng; K67 HTTP và job đang chạy vẫn bình thường. | S2 |
| S4 — chuyển pilot | 36 roster IC2264 từ kho riêng + canary → 36 hàng cùng UUID trong `assessment_k56`, rồi chuyển API K56 | Đối chiếu từng khóa/UUID trong RAM; không đụng `assessment` K67; thử admin/giảng viên/học viên trên IC2264; chưa mở lớp khác. | S3 |
| S5 — mở mọi lớp đang học | Snapshot ERP mới nhất + cổng quyền → đủ roster/87 cặp quyền theo phạm vi tại thời điểm chạy | 29×3 và 447×3 là số baseline; chạy lại số mới nhất, đối soát đúng từng đề/lớp, hai lớp chưa ghép Classroom vẫn được xử lý qua ERP; smoke cả ba đề và K67. | S4 |
| S6 — lượt ERP tiếp | Lượt sync mới + trạng thái kho chung → cập nhật cờ đủ điều kiện/quyền/checkpoint cùng giao dịch | Rời/quay lại lớp, out-of-order/retry/partial failure; không xóa bài/UUID; thử rollback/readback thật trước khi bật lịch; giảm phạm vi cần xem riêng. | S5 |
| S7 — vận hành | Giao diện thật + job Writing + số liệu Portal → bằng chứng kết quả người dùng | Quan sát nộp, chấm, đồng bộ điểm và quyền K56; K67/Substitute không lệch; quality gate `verified` chỉ sau đọc lại và canary người dùng. | S6 |

`decision_inputs`: một database chung nhưng hai schema bài thi, ERP `on_going` làm phạm vi, K67 phải không đổi. Nếu đổi quyết định database/schema, S1–S7 trở thành stale. Nếu nguồn ERP/định danh thay đổi, S4–S7 stale. File trách nhiệm: chọn profile/định tuyến SQL ở `backend/src/config.js`, `backend/src/db.js`, `backend/src/assessment-schema-pool.js`; lọc lớp ở `backend/src/sql.js`; migration/schema ở `backend/ops/migrations/`; công cụ preflight/cutover/rollback ở thư mục release này; fixture ở `backend/test/`; snapshot production riêng tư trên ổ E (không vào Git). `S1` là lát đầu tiên cần xây trước mọi ghi kho chung.

## Cổng phát hành, rollback và điểm dừng

1. Trước mọi ghi: khóa revision source/image, chạy `npm test` và `npm run check` trong `backend/`, regression RED/GREEN profile, kiểm manifest chất lượng trên revision cuối, backup **cả hai** database và chứng minh restore vào database tạm. Chụp số job Writing đang chạy/chờ; không dừng hoặc chiếm job hiện hữu.
2. K67 giữ nguyên schema/API nếu kiểm chứng chứng minh không cần đổi. Nếu phải phát hành một guard/cấu hình K67, làm riêng và kiểm HTTP/claim job trước khi tạo schema K56; khi K67 lệch, rollback image K67. Không phát hành hai service cùng lúc chỉ vì Đức đã cho phép cập nhật K67.
3. Tạo schema K56 bổ sung trong `mapping_db`, không `ALTER`/`DROP`/`TRUNCATE` schema `assessment` K67 và không restore toàn bộ `mapping_db` để rollback vì sẽ xóa tiến độ chấm. Sau mỗi mutation, đọc lại đúng schema/role/slug/row count trước bước sau.
4. Khi chưa có bài K56 mới trong kho chung, có thể dừng canary và giữ API K56 ở database cũ. **Sau bài K56 đầu tiên trong kho chung, không được trỏ ngược về database cũ**: sẽ làm bài mới biến mất. Khi đó rollback an toàn là đóng quyền mở lớp mới, giữ dữ liệu và dùng image có guard hoặc sửa tiến tới; mọi phương án chuyển ngược dữ liệu cần kế hoạch/duyệt riêng.
5. Dừng nếu nguồn ERP cũ/rỗng, số lượng giảm bất thường, lớp trùng mã khác ID, UUID pilot lệch, cột/role/schema thiếu, profile guard thất bại, job Writing chéo hệ, K67 HTTP khác baseline, backup/restore drill không đạt, hoặc thời gian khóa bảng vượt ngưỡng.

**Review Focus:** query K56 lọt sang schema K67; job bị nhận nhầm schema; UUID IC2264 đổi; clone schema thiếu constraint/function; rollback sau khi có bài mới làm mất dữ liệu nhìn thấy. Mỗi mục phải có test và readback ở S1–S7. Đức đã chọn phạm vi dùng `mapping_db` và chấp nhận cập nhật K67 nếu thực sự cần; mỗi bước vẫn qua cổng kỹ thuật/backup/readback riêng. Nếu kiểm chứng cách ly S1 thất bại, dừng và báo lại, không tự chuyển về phương án kho riêng hoặc trộn hai hướng trong một lần phát hành.
