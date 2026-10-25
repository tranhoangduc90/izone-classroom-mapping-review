# Speaking Lesson 2–11: xác nhận và tiến độ Docs — 25/10/2026

Trạng thái đã quan sát: phát hành trên cả Mapping và Speaking độc lập; hai dịch vụ healthy. Đây là hồ sơ phát hành hẹp, không phải hướng dẫn rebuild toàn main. Các overlay lịch sử của hai runtime vẫn khác nhau và phải được giữ.

## Hành vi phải giữ

- Lời chatbot xác nhận hoàn thành đúng cả bài được công nhận theo chính sách hiện hành, kể cả thiếu số câu; xác nhận một bước giữa trong khi còn thực hành bắt buộc không phải hoàn thành toàn bài. Không dùng lời học viên, ví dụ hoặc code block làm bằng chứng.
- `speaking-completion-policy.js` giữ policy `speaking-fairness-2026-10-18-v1`, recognizer mới `scope-recognition-20261025-v3`. Bộ lọc trước AI và validator cùng chặn mốc trung gian có bước bắt buộc tiếp theo; lời kết thúc cả bài trước phần luyện thêm tùy chọn vẫn có giá trị.
- Snapshot và Doctor dùng giới hạn chung 160.000 ký tự lời thoại, giữ toàn bộ nội dung và fingerprint. Lỗi cũ: hội thoại khoảng 95.000 ký tự được nhận diện xong nhưng vượt giới hạn lưu 80.000, làm kết quả trả thành lỗi kiểm dịch vụ.
- Hàng `doc_progress` của mỗi schema nhận snapshot mới nhất ngay khi từng phần thay đổi; worker ghi đúng Doc/tab/mã bài, chỉ ô tình trạng Speaking, khóa revision, đọc lại text và hyperlink trước `verified`. Tiến độ không có receipt không được báo đã nộp.
- Bổ trợ chỉ ghi “Bổ trợ 1”, “Bổ trợ 2”; không đưa tên bài chi tiết vào Docs. Không thêm dòng giải thích dưới CTA, không chỉnh Docs mẫu khi chỉ nâng cấp webapp.
- Lần đồng bộ đầu với trạng thái nhập tay chỉ nhận whitelist hẹp, nguyên văn text/link đã được operator đối chiếu và ghi vào metadata máy chủ. Metadata mặc định không tự cho phép ghi đè. Khi đã quản lý hoặc đã có receipt, ngoại lệ này không áp dụng.

## Nguồn và kiểm

Frontend trước đó: commit `45b160134a117a09418ad51df027baf0b4381963`, Pages PR290. Backend nền tiến độ: `60251ad3c5c885e8308610d9fd0e43c0f33bbee4`, PR102. Bản khôi phục/nhận diện: `78c3b656963956cd3fdbceed704935f3a7cb2d24`. Migration `202610250930/931` đã chạy trong đợt đầu; đợt khôi phục không chạy migration mới.

- 180/180 test Speaking: 76 trên Mapping, 104 trên runtime độc lập; 15 test trọng tâm cùng fixture tái hiện lỗi ở bản cũ và đạt ở bản sửa. Không cộng số lần chạy lặp vào coverage.
- Bốn hội thoại thật được kiểm trước ghi: ba ca pass, ca hoàn thành ba bước đầu nhưng còn Part 3 bị giữ chưa đạt. Ca này kiểm thêm hai lần vẫn chưa đạt.
- Ba lượt mới đã accepted qua worker thật ngay lần đầu; ba kết luận từ chối cũ giữ nguyên. Snapshot dài thực tế lưu đủ 94.963 ký tự.
- 21 hồ sơ của 10 học viên được đồng bộ bằng worker webapp, gồm năm ô nhập tay được đối chiếu. Đọc lại 95/95 Docs khớp text/link: 73 có receipt, 22 có tiến độ chưa nộp. Một hồ sơ vừa tự nộp được loại khỏi đợt ghi. Không tạo receipt hoặc nộp/chấm thay học viên; phần bài/receipt của 73 lượt đã nộp và các phần không thuộc sửa giữ nguyên.
- 10 trang public Lesson 2–11 nối `presentation.js` → ba engine `lesson-2/3/4-live.js` → `docs-progress.js`. Bộ nạp/cấu hình mã bài và HTTP assets được đọc lại; không coi kiểm asset là nghiệm thu toàn bộ thao tác học viên trên mọi lớp/thiết bị.

Nguồn kết quả riêng và hồ sơ đầy đủ nằm tại workspace chính `docs/SPEAKING67_XAC_NHAN_VA_TIEN_DO_2026-10-25.md` cùng thư mục bị Git bỏ qua `private-deployments/speaking-progress-recovery-20261025/`. Không đưa hội thoại, tên học viên, Doc ID, token hoặc dump vào repo public này.

## Runtime, lưu trữ và tiếp tục

| Dịch vụ | Image đã kiểm | Build đã phát |
| --- | --- | --- |
| `mapping-review-api` | `sha256:b00ef88d4485c973c6ae05c76ea3199eb5834336f03a002a88716225d37ef23c` | `78c3b656963956cd3fdbceed704935f3a7cb2d24` |
| `speaking67-independent-api` | `sha256:a42f0b634b8bf42ce3809fc7348c6d028a058031b39a43b0b033593301b681c1` | `78c3b656963956cd3fdbceed704935f3a7cb2d24` |

Năm module overlay: completion policy, conversation snapshot, Doctor worker, progress Docs và independent status. Giữ toàn bộ env/mount/network/quyền từ container đã đối chiếu; đợt chuyển chỉ đổi image và `BUILD_SHA`. Giữ `SPEAKING_PROGRESS_DOCS_ENABLED=true` và đường credential hiện hành, không lưu giá trị bí mật vào Git. Doctor worker trong gói bảo toàn các sửa live trước đó về snapshot, Unicode và chẩn đoán; không thay bằng bản main cũ.

Kho VPS riêng: `/opt/izone-speaking-progress-20261025/` (đợt đầu) và `/opt/izone-speaking-recovery-20261025/` (khôi phục). Có dump/schema, inspect cấu hình, kết quả kiểm, backup ô Docs và readback. Hai container `*-before-recovery-20261025` giữ bản quay lui; không restore dump cũ để quay code vì sẽ mất tiến độ mới. Chỉ khôi phục runtime/config tương thích sau kiểm nguồn mới và trong quyền riêng; Git merge không phải thao tác rollback production.

`backend/ops/recover-speaking-progress-20261025.mjs` là công cụ operator **chỉ chạy trong container** với input allowlist riêng đã được duyệt. Nó kiểm owner/Doc/mã/trạng thái draft/receipt, tạo revision + check job mới hoặc enqueue worker tiến độ. Không gọi submit/grade hoặc ghi Docs trực tiếp. Không chạy lại từ hồ sơ này khi chỉ lưu bộ nhớ; cần đọc trạng thái hiện hành và quyền tác vụ mới.

Mốc lỗi/giới hạn ở hồ sơ Lesson 11 cũ vẫn là lịch sử của đợt đó. Kết quả 180 test ở đây chỉ chứng minh gói/runtime/fixture Speaking của ngày 25/10, không chứng minh toàn backend hay mọi lớp đã được giao bài.
