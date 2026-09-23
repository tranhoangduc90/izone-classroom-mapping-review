# Đưa snapshot K56 từ mapping chung vào kho bài thi riêng

Trạng thái 24/09/2026: **B1/B2 đã có công cụ xem trước chỉ đọc; chưa nhập roster hoặc mở lớp mới**. Nguồn chung đã đối soát 29 lớp/447 học viên `on_going`; kho bài thi K56 chỉ có IC2264, 28 lớp còn thiếu. Hai kho PostgreSQL và hai API ở hai mạng Docker khác nhau; không đổi `DATABASE_URL` hoặc nối mạng production chỉ để giải quyết việc này.

Lệnh xem trước trên máy Đức: `python backend/ops/releases/k56-class-access-20260924/bridge_dry_run.py`. Công cụ lấy thông tin kết nối từ container đang chạy qua SSH, chỉ thực thi `SELECT`, giữ hồ sơ học viên trong RAM và chỉ in số đếm. Lượt live `sync_run_id=102` trả 29 lớp, 447 học viên, ba đề, 28 mapping lớp cần thêm, 1.305 hàng roster cần thêm, 36 hàng roster cũ cần giữ, 0 tên cũ đổi, 0 hàng cũ ngoài phạm vi và 2 lớp chưa ghép Classroom; **productionWrites=0**. Đây là kết quả xem trước, không phải bằng chứng đã mở bài cho 28 lớp.

## Kết quả cần đạt

Học viên của mọi lớp khóa 56 đang học thấy đúng ba bài K56 khi được mở, không thấy lớp khác. Giảng viên/admin thấy đúng roster và bài đã nộp vẫn giữ nguyên. Lớp chưa có Classroom roster (IC2322/IC2326) vẫn lấy danh sách từ ERP qua mapping chung, nhưng không bị tự ghép tài khoản Classroom. K67 và các sản phẩm khác không đổi.

Phạm vi chưa làm: không thay prompt/model chấm Writing, không di chuyển bài nộp, không sửa điểm Portal, không mở 271 lớp lịch sử và không thêm quyền cho lớp hết `on_going`.

## Contract giữa hai kho

| Dữ liệu nguồn | Đích K56 | Quy tắc |
| --- | --- | --- |
| Lớp trong `mapping.sync_run` K56 hoàn tất mới nhất + `classroom_course_mapping` | `mapping.classroom_course_mapping` | Khóa ID lớp ERP; mã trùng nhưng ID khác phải dừng. Lớp Classroom `pending_review` không bị tự duyệt. |
| `erp_class_membership_snapshot` có `source_state=active`, `registration_status=on_going` | `assessment.term_test_roster` cho ba slug K56 | Khóa `(test_slug, class_id, contact_id)`; giữ `student_ref` có sẵn, chỉ tạo UUID cho hàng mới. |
| Đủ ba định nghĩa đề, cột Portal hai Term và quyết định mở lớp | `assessment.term_test_class_access` | Chỉ bật sau khi migration, image có cổng quyền và roster đọc lại khớp; bản ghi mặc định đóng. |

Mỗi lượt chuyển có `sync_run_id` nguồn; chạy lại cùng lượt không được nhân đôi roster hoặc đổi UUID. Không dùng tên, email hay thứ tự dòng làm khóa. Không đưa hồ sơ học viên vào Git, log hoặc báo cáo.

Audit backend hiện có 12 học viên IC2264 dùng `student_ref` khác nhau giữa ba đề; đây là identity theo **từng đề**, không phải lỗi cần “sửa đồng nhất”. Tuyến mới phải giữ nguyên cả ba UUID cũ cho đúng `(test_slug, class_id, contact_id)` và chỉ cấp UUID mới cho bản ghi chưa có.

Hai contract định danh kèm theo tách đích ghi roster (`identity-contract.json`, khóa `roster_row_key = test_slug:class_id:contact_id`) khỏi đích bật quyền (`identity-contract-access.json`, khóa `class_test_key = test_slug:class_id`). Checker contract đã đạt; cảnh báo về `test_slug` sinh ở bước tách phải được đóng bằng fixture duy nhất theo từng khóa khi xây tuyến thực tế.

## Các lát thực hiện

| ID | Đầu vào → đầu ra | Điều kiện đóng |
| --- | --- | --- |
| B1 — đã làm | Snapshot chung mới nhất → gói đọc trong bộ nhớ, có khóa/lượt nguồn | Công cụ chặn nguồn cũ/rỗng, nguồn giảm bất thường, mã/ID mâu thuẫn, sai database; 9 regression fixture đạt. |
| B2 — đã làm | Gói B1 → kế hoạch ghi K56 `dry-run` | Chỉ xuất số đếm, không chứa tên/email/UUID; đọc live giữ 36 UUID theo từng đề và không ghi production. |
| B3 | Migration cổng quyền + image backend có cổng quyền → kho K56 vẫn chỉ mở IC2264 | Staging và full suite đạt; readback production đúng ba hàng quyền IC2264, lớp khác đóng. Không nhập roster trước B3. |
| B4 — lõi local đã chuẩn bị, chưa chạy live | B1/B2 sau khi B3 đạt → nhập một chiều theo giao dịch | Backup hai kho và image; đọc lại 29 lớp, 447 học viên `on_going` cho mỗi đề, UUID cũ nguyên vẹn; lỗi một lớp không báo xanh cả lô. |
| B5 | Roster B4 + phạm vi ERP mới nhất → bật cặp lớp–đề | Đúng 29 × 3 cặp `enabled`, lớp ngoài phạm vi đóng; smoke HTTP đủ ba đề/K56 và K67 không đổi. |
| B6 | Lượt đồng bộ tiếp theo → quan sát và quyết định nhịp tự động | Chỉ lên lịch khi đã có khóa chạy trùng, cảnh báo nguồn cũ/giảm số lượng và rollback đã thử; không coi một lượt nhập thủ công là đồng bộ lâu dài. |

Kiểm B3 sâu hơn trên source K56 production bằng `stage_live_gate.py`: lớp vá hẹp sáu file có 10/10 ca SQL nhưng chỉ đạt 6/7 test backend tập trung. Source live chưa tự suy quyền mọi lớp từ `role=admin` và chưa trả `accessMode` ở danh sách lớp kiểu K56; **không hạ bộ test để phát hành bản vá hẹp**. Bản ứng viên hợp nhất dùng source live làm nền, áp cổng quyền và hòa giải các module từ branch đã đối chiếu; lệnh `--unified-candidate --full-suite` đạt 178/178 test backend, 10/10 ca SQL, không skip và không ghi production. Dấu SHA-256 của cây `src` ứng viên đã thử là `7f13defc697bbc48e070b1f4dd00f390d72bc844b07acefb1e036d98bb303f90`; lần build phải tái tạo đúng dấu này hoặc kiểm thử lại từ đầu. Audit hai profile thấy 30 module JS ở K56 live, 37 ở K67 live; so với branch, 10 module khớp cả hai, 1 khớp riêng K56, 18 khớp riêng K67 và 8 khác cả hai, cần review theo hợp đồng trước khi đóng B3. Kết quả thử trong thư mục tạm **không phải image đã build/deploy hoặc xác nhận giao diện**. B3 vẫn `not_ready` cho đến khi có bản phát hành exact-source, backup/restore, kiểm thử live và phê duyệt production. Tùy chọn `--compat-k56-live` chỉ dùng để chẩn đoán khác biệt API cũ, không phải cách bỏ qua blocker.

`plan_revision=k56-mapping-bridge-v1`. Nếu chọn kết nối trực tiếp hai mạng/DB thay cho snapshot một chiều, B1–B6 trở thành stale và phải rà lại bảo mật, quyền, rollback trước build.

Quan hệ phụ thuộc: `B1 → B2`; `B2` và `B3` phải cùng xong trước `B4`; `B4 → B5 → B6`. B1 nhận quyết định “ERP/mapping chung là nguồn chuẩn” và làm B2/B4/B5 stale nếu đổi. B3 nhận quyết định “K56 giữ database riêng, gate bật trước roster” và làm B4/B5/B6 stale nếu đổi. B4 quyết định cách đồng bộ một chiều, làm B5/B6 stale nếu đổi. Các lát tạo artifact dự kiến: bộ đọc snapshot và phép so chênh lệch trong `backend/ops/releases/k56-class-access-20260924/`; kiểm thử fixture/PGlite trong `backend/test/`; migration/gate hiện có trong `backend/ops/migrations/` và `backend/src/`; bằng chứng phát hành, backup và readback nằm ngoài Git. Không tạo bảng hoặc endpoint mới cho sản phẩm khác.

## Kiểm thử và điểm dừng

- Cùng regression phải RED trên backend chưa có tuyến nhập, GREEN trên bản mới: lớp K56 thứ hai không có roster/không mở bài trước B4–B5; sau đó có đúng roster và chỉ mở đề đã bật.
- Test identity: lớp cùng tên/khác ID, học viên cùng tên/khác contact ID, đổi trạng thái, dữ liệu đảo thứ tự, lặp `sync_run_id`, thiếu một học viên, hai lớp xen kẽ, lỗi ở giữa lô; readback đúng target và lớp ngoài phạm vi nguyên vẹn.
- Test quyền/riêng tư: user thường không thể gọi tuyến nhập; output/log không có tên, email, credential; hai lớp chưa ghép Classroom vẫn fail closed ở chức năng Classroom nhưng không bị loại khỏi roster bài thi.
- Test hồi phục: tắt quyền mới trước khi dừng tuyến nhập; không rollback image về bản thiếu cổng quyền khi mapping/roster mới còn tồn tại. Giữ migration additive, không xóa bài hoặc điểm.
- Mọi lần ghi production cần xác nhận đúng database `izone_mapping_k56_ic2264`, backup/restore drill, ngưỡng số lượng và readback. Tool `success` không thay thế bằng chứng người dùng mở đúng lớp/đề.

Review Focus: nhầm ID học viên; mở lớp trước khi có gate; mất UUID bài cũ; snapshot cũ/thiếu được báo thành công; rollback image làm lớp mở ngoài ý muốn.

Lõi B4 trên branch gồm `prepare_import_payload` (chỉ tạo hàng mới trong RAM) và `roster_import.mjs` (đối chiếu lại toàn bộ đích dưới khóa bảng, nhập trong một giao dịch và đọc lại trước commit). Hàng cũ không bị cập nhật; lớp mới chỉ có ID/mã ERP, mặc định `pending_review`, không gán Classroom. Kiểm live phát hiện `row_count=510` của lượt nguồn đếm toàn bộ snapshot, còn 447 hàng `on_going` mới đủ điều kiện; bộ đọc nay đối chiếu cả tổng 510 lẫn 447 riêng, không loại sai 63 hàng ngoài phạm vi. 14 fixture Python và 9 ca PostgreSQL trong RAM đạt, gồm chạy lại, đích đổi sau preview, thiếu cổng quyền và lỗi ở giữa lô rollback toàn bộ. Full suite backend và bản stage ghép source live đều đạt 187/187, 0 skip; 10/10 ca SQL cổng quyền vẫn đạt. Đây **chưa** là lệnh chạy production: còn cần gói thực thi kiểm image có cổng quyền, snapshot nguồn mới nhất, backup/restore drill và phê duyệt riêng. Không gọi B4 `done` chỉ vì lõi local qua test.

Lệnh nền hiện tại: 14 test Python của tuyến xem trước/lập hàng nhập và 4 fixture cổng quyền đạt; bản stage hợp nhất và `npm test` trong `backend/` đạt 187/187; `npm run check` đạt. `python tools/writing-benchmark/audit-k56-cohort-readiness.py` hiện trả `not_ready`, 1/29 mapping, 1/29 roster theo đề, bảng quyền chưa có. Sau B4/B5, cùng lệnh audit phải trả `ready` với 29/29, 447 lượt đang học và ba đề đủ quyền. Trước mỗi release còn phải chạy full suite trên commit cuối, quality-gate checker của lát backend, HTTP smoke K56/K67 và đối chiếu số lượng/UUID ở database đích.
