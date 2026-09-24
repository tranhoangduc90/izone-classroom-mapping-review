# Phương án dùng database mapping chung cho bài thi K56

Trạng thái: **Đức đã chọn kho chung và chấp nhận cập nhật API K67; chưa có mutation production**. `plan_revision=k56-shared-db-v1`. Phương án B3–B6 trong `MAPPING-BRIDGE-PLAN.md` dựa trên kho K56 riêng đã **stale** đối với hướng này; không chạy các lệnh migration/backup/compose của phương án cũ như một đợt phát hành kho chung. B1 — ERP khóa 56 `on_going` là nguồn phạm vi — vẫn dùng được, nhưng số lớp và học viên phải đọc lại sát thời điểm phát hành.

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

Lượt ERP `sync_run_id=102` có 29 lớp, 447 học viên đủ điều kiện và 510 hàng snapshot tổng. Có 1.341 hàng roster K56 cho ba đề; 36 hàng IC2264 đã có UUID riêng theo từng đề trong kho K56, nên khi chuyển phải giữ nguyên các UUID đó. Hai lớp IC2322/IC2326 chưa ghép Classroom nhưng có danh sách ERP. Các số này là baseline quan sát, không phải hằng số để ép lần ghi sau.

**Phát hiện chặn cắt chuyển trực tiếp:** hai API hiện dựa vào việc database tách riêng để cô lập loại đề. Bộ test `production-profiles.test.js` hiện còn mong đợi API K56 nhìn thấy cả slug K67 nếu hai loại cùng có mặt trong một database; nhiều route nhận `testSlug` nhưng chưa kiểm profile tại cửa vào. Test đó đã chạy lại ngày 24/09 và đạt 2/2, xác nhận hành vi hiện tại chứ **không** chứng minh an toàn dùng chung. Toàn bộ bảng `assessment` của kho chung có `row_security=false`; cấp quyền bảng cho role K56 không tự giới hạn các hàng K67. Chỉ đổi `DATABASE_URL` sẽ mở đường truy cập chéo K56/K67 và có thể khiến hai API nhận nhầm job Writing. Vì vậy phải chứng minh cách ly tại API **và** lớp dữ liệu, test RED/GREEN, rồi phát hành lớp bảo vệ cho API K67 **trước khi** nạp định nghĩa K56 vào kho chung. Đây là thay đổi bổ sung ở hệ thống đang chấm, chưa thuộc quyền duyệt phát hành kho K56 riêng trước đó.

## Hợp đồng dữ liệu và quyền

- Nguồn lớp: `mapping.sync_run` hoàn tất mới nhất của `n8n_k56_erp_ongoing`, ghép `mapping.classroom_course_mapping` theo **ID lớp ERP**, không theo tên hiển thị.
- Nguồn học viên: hàng snapshot cùng `sync_run_id`, `source_state=active`, `registration_status=on_going`; khóa `(erp_course_class_id, erp_student_contact_id)`.
- Đích roster: khóa `(test_slug, class_id, contact_id)`; `student_ref` cũ IC2264 giữ nguyên theo từng slug. Chỉ cấp UUID cho khóa chưa tồn tại. Khi chạy lại cùng lượt không sinh bản ghi/UUID mới.
- Quyền mở bài: `(test_slug, class_id)` chỉ được bật khi đủ định nghĩa, roster, profile guard và readback. K56 mặc định đóng; các slug K67 không tham gia bảng quyền K56.
- Ghi điểm, job chấm và Portal giữ `attempt_id`/`test_slug`; không ghép output bằng thứ tự, tên học viên hay job đầu tiên. API K56 và K67 phải từ chối slug của profile kia ở cả đường đọc, ghi, giáo viên và claim job.
- Quyền database: không dùng chung credential API K67 cho API K56. Cấp role K56 riêng với quyền tối thiểu; vì các bảng hiện không có row-level security, S1 phải chọn và thử cơ chế cách ly hàng K56/K67 thực sự (ví dụ chính sách theo hàng hoặc hàm ghi có ràng buộc), không coi quyền `GRANT` cấp bảng hay middleware là đủ. Nếu không thể chứng minh role không đọc/ghi chéo mà vẫn giữ K67 hoạt động, **không chuyển sang kho chung**. Không đưa secret, tên/ID học viên hoặc JSON đề sống vào Git/log.

## Các lát thực hiện

| ID | Consumes → produces | Kiểm chứng và điều kiện đóng | Phụ thuộc |
| --- | --- | --- | --- |
| S0 — baseline | Hai DB/API đang chạy → snapshot cấu trúc, số đếm, image và trạng thái job | Read-only; nguồn/lượt mới không tụt bất thường; xác nhận 0 bài K56 trong kho riêng trước cắt chuyển. | B1 |
| S1 — cách ly profile | Source live K67/K56 + ma trận route → guard API và database ở mọi đường đọc/ghi/job, bộ regression RED trên base, GREEN trên head | Test bằng role thật: K56 không thể đọc/ghi/claim K67 và ngược lại; full suite K67, K56, Substitute và Writing không giảm; so candidate exact-source với image live. Nếu không đạt, dừng phương án kho chung. | S0 |
| S2 — kho chung chỉ bổ sung | Backup + S1 → bảng trạng thái Portal còn thiếu, cột đủ điều kiện, bảng quyền, 3 định nghĩa K56 ở trạng thái chưa mở, role riêng | Backup có restore drill; migration idempotent; K67 rows/job/điểm bất biến; schema/hash đề K56 khớp nguồn riêng, không log nội dung đề. | S1 |
| S3 — canary không có học viên | Role/network/API K56 candidate → canary dùng kho chung nhưng chưa chuyển URL công khai | Health, quyền role, 404/403 chéo profile, lớp chưa bật vẫn đóng; K67 HTTP và job đang chạy vẫn bình thường. | S2 |
| S4 — chuyển pilot | 36 roster IC2264 + canary → 36 hàng cùng UUID trong kho chung, rồi chuyển API K56 | Đối chiếu từng khóa/UUID trong RAM; không đụng 46 roster và 137 attempt cũ; thử admin/giảng viên/học viên trên IC2264; chưa mở lớp khác. | S3 |
| S5 — mở mọi lớp đang học | Snapshot ERP mới nhất + cổng quyền → đủ roster/87 cặp quyền theo phạm vi tại thời điểm chạy | 29×3 và 447×3 là số baseline; chạy lại số mới nhất, đối soát đúng từng đề/lớp, hai lớp chưa ghép Classroom vẫn được xử lý qua ERP; smoke cả ba đề và K67. | S4 |
| S6 — lượt ERP tiếp | Lượt sync mới + trạng thái kho chung → cập nhật cờ đủ điều kiện/quyền/checkpoint cùng giao dịch | Rời/quay lại lớp, out-of-order/retry/partial failure; không xóa bài/UUID; thử rollback/readback thật trước khi bật lịch; giảm phạm vi cần xem riêng. | S5 |
| S7 — vận hành | Giao diện thật + job Writing + số liệu Portal → bằng chứng kết quả người dùng | Quan sát nộp, chấm, đồng bộ điểm và quyền K56; K67/Substitute không lệch; quality gate `verified` chỉ sau đọc lại và canary người dùng. | S6 |

`decision_inputs`: dùng chung kho bài thi, ERP `on_going` làm phạm vi, K67 phải không đổi. Nếu đổi quyết định database, S1–S7 trở thành stale. Nếu nguồn ERP/định danh thay đổi, S4–S7 stale. File trách nhiệm: guard ở `backend/src/`, migration ở `backend/ops/migrations/`, công cụ preflight/cutover/rollback ở thư mục release này, fixture ở `backend/test/`, snapshot production riêng tư trên ổ E (không vào Git). `S1` là lát đầu tiên cần xây trước mọi ghi kho chung.

## Cổng phát hành, rollback và điểm dừng

1. Trước mọi ghi: khóa revision source/image, chạy `npm test` và `npm run check` trong `backend/`, regression RED/GREEN profile, kiểm manifest chất lượng trên revision cuối, backup **cả hai** database và chứng minh restore vào database tạm. Chụp số job Writing đang chạy/chờ; không dừng hoặc chiếm job hiện hữu.
2. Phát hành guard K67 riêng, kiểm HTTP và việc claim job trước khi thêm slug K56. Nếu K67 lệch, rollback image K67 khi kho chung **chưa** chứa K56. Không phát hành hai service cùng lúc.
3. Migration kho chung chỉ additive với timeout khóa ngắn, không `DROP`, không `TRUNCATE`, không restore toàn bộ `mapping_db` để rollback vì sẽ xóa tiến độ chấm K67. Sau mỗi mutation, đọc lại đúng bảng/role/slug/row count trước bước sau.
4. Khi chưa có bài K56 mới trong kho chung, có thể dừng canary và giữ API K56 ở database cũ. **Sau bài K56 đầu tiên trong kho chung, không được trỏ ngược về database cũ**: sẽ làm bài mới biến mất. Khi đó rollback an toàn là đóng quyền mở lớp mới, giữ dữ liệu và dùng image có guard hoặc sửa tiến tới; mọi phương án chuyển ngược dữ liệu cần kế hoạch/duyệt riêng.
5. Dừng nếu nguồn ERP cũ/rỗng, số lượng giảm bất thường, lớp trùng mã khác ID, UUID pilot lệch, cột/role/schema thiếu, profile guard thất bại, job Writing chéo hệ, K67 HTTP khác baseline, backup/restore drill không đạt, hoặc thời gian khóa bảng vượt ngưỡng.

**Review Focus:** route K56 đi vào đề K67; worker nhận nhầm job; UUID IC2264 đổi; migration giữ khóa bảng làm gián đoạn chấm; rollback sau khi có bài mới làm mất dữ liệu nhìn thấy. Mỗi mục phải có test và readback ở S1–S7. Đức đã chọn phạm vi mới gồm cập nhật API K67 và dùng `mapping_db`; mỗi bước vẫn phải qua cổng kỹ thuật/backup/readback riêng, không coi quyền duyệt B3 cũ là bằng chứng bước mới đã an toàn. Nếu kiểm chứng cách ly S1 thất bại, dừng và báo lại, không tự chuyển về phương án kho riêng hoặc trộn hai hướng trong một lần phát hành.
