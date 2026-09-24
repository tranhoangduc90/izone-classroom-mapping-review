# Trạng thái thực tế của cổng bài thi khóa 56 ngày 24/09/2026

Tài liệu này là ảnh chụp vận hành lúc 13:15 giờ Việt Nam ngày 24/09/2026, **không phải giấy nghiệm thu toàn bộ plan**. Khi cần thao tác, đọc lại production và không suy trạng thái hiện tại từ số liệu dưới đây. Các phần cũ trong `README.md`, `MAPPING-BRIDGE-PLAN.md` và một số quality gate mô tả phương án kho riêng hoặc trạng thái trước cắt chuyển; không dùng chúng làm lệnh phát hành hiện hành.

## Điều đã triển khai và đọc lại

| Thành phần | Kết quả đã xác nhận |
| --- | --- |
| Nguồn lớp | Workflow ERP độc lập `e7Decjrz6jzBMSLF` đang bật, có lịch 04:30 giờ Việt Nam. Lần chạy thủ công production `sync_run_id=105` trả 29 lớp khóa 56 `on_going`, 447 học viên đủ điều kiện, 0 xung đột. Nhánh ghi K56 của workflow Classroom cũ đã bỏ; K67/Classroom giữ nguyên. |
| Database | K56 ở schema `assessment_k56` trong `mapping_db` chung, role API K56 không có quyền dùng schema `assessment` của K67. Có 1.341 hàng roster và 87 cặp quyền lớp–đề; UUID của 36 hàng IC2264 cũ được giữ. Không có bài K56 đã nộp hay job Writing K56 tại thời điểm kiểm. |
| API | K56 chạy image `izone-k56-live-results:20260924.4-roster-reconcile`, ID `sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956`, source SHA `fac908296e735a3f5dee6722a3a592eb573659ef5772d33238cb9d193dde452a`. API K56 và K67 đều healthy, restart 0; image K67 không đổi. |
| Cập nhật lớp tiếp theo | API K56 đã bật bộ đối soát roster mỗi 5 phút. Bộ này chỉ đọc lượt ERP hoàn tất mới nhất, ghi roster/quyền K56 và checkpoint trong một giao dịch sau khi đối soát; không tự đóng quyền khi số học viên hoặc lớp giảm. Checkpoint đã ghi lượt 105. |
| Giao diện | Trang Pages đã phát hành bản sửa định tuyến, không đẩy lớp K56 thật sang API demo. IC2322, IC2326 và IC2264 trả đúng roster qua các đường bài đã kiểm. Hai lớp đầu không cần Google Classroom để được mở theo phạm vi ERP. |

Backup hai kho trước chuyển đổi đã được restore drill; bản K56 riêng cũ được giữ cho mục đích khôi phục có kiểm soát. **Không trỏ API về kho riêng cũ sau khi kho chung có bài K56 mới**, vì việc đó có thể giấu bài mới khỏi người dùng. Nếu gặp bất thường, trước hết giữ dữ liệu, kiểm đúng lớp–đề và cô lập đường ghi có lỗi; chỉ chọn rollback image/schema sau khi đọc lại số bài mới và có kế hoạch không mất dữ liệu.

**Cập nhật sau ảnh chụp trên:** khoảng 13:31 giờ Việt Nam cùng ngày, container K67 được tạo lại từ image `izone-term-test-backend:20260924.3-progress-log-feedback-lock` bởi một đợt phát hành khác. Lúc đọc lại, K67 vẫn healthy, restart 0 và có 46 hàng roster; không coi image K67 cũ trong bằng chứng cắt chuyển là baseline hiện hành cho các lượt kiểm sau. Không quy thay đổi này cho đợt K56 hoặc tự hoàn tác nó.

## Kiểm thử đã đạt

- Backend trên branch: `npm test` đạt 225/225, không skip; `npm run check` đạt. Bộ Python K56 đạt 27/27 khi gọi từ cả gốc repository lẫn thư mục `backend`.
- Stage dựng từ đúng image K56 đang chạy đạt 225/225, không skip, 10/10 ca SQL; source SHA trong stage trùng image production. Đây là phép kiểm source/hợp đồng, không tạo bài nộp.
- Canary production chỉ đọc và thử giao dịch rollback đã xác nhận lượt ERP 105, 29 lớp, 447 học viên; không ghi bài hoặc điểm. Một lỗi sắp xếp ID lượt nguồn theo chữ (`98` vượt `105`) đã được test RED/GREEN và sửa trước image `.4`.
- Sau phát hành, API K56/K67 healthy, restart 0, checkpoint 105, roster/quyền đúng các số trên, không có error event trong cửa sổ kiểm. Lệnh kiểm `audit_roster_worker.py` chỉ xuất số đếm và trạng thái, không xuất hồ sơ học viên.

## Chưa nghiệm thu

1. Lịch 04:30 mới chưa tới lần chạy tự nhiên đầu tiên sau chuyển production. Cần xem execution theo lịch, `sync_run_id` mới, rồi xác nhận bộ đối soát API đi theo lượt đó; lần chạy thủ công 105 không chứng minh lịch tự chạy.
2. K56 chưa có bài nộp thật ở kho chung. Chưa thể tuyên bố đường Writing → kết quả trên trang → Portal đã hoạt động end-to-end. Cần kiểm một lượt nộp hợp lệ khi có bài thật, theo dõi attempt/job/result/điểm bằng ID kỹ thuật tối thiểu, không chép bài hoặc danh tính ra Git.
3. Substitute Test 1/2 K56 đang dùng hai gateway public riêng và hai workflow chấm riêng được các workflow nhận bài active gọi. Kiểm giao diện đã chặn feedback thiếu Task, nhưng **chưa có bằng chứng Substitute đã chuyển sang cùng bộ chấm backend Term/Mini**. Không gộp phạm vi này với hệ Writing từ Google Docs/Classroom, vốn là sản phẩm khác.
4. Các quality gate cũ trong thư mục release và Pages có bằng chứng lịch sử nhưng một số câu trạng thái trước cắt chuyển đã lỗi thời. Chỉ cập nhật thành `verified` sau khi mục 1–3 có readback và kiểm hồi quy đầy đủ.

## Hướng dẫn kiểm lại an toàn

Chạy các lệnh sau từ thư mục `backend` của worktree tương ứng. Chúng đọc metadata tổng hợp; không cần nhập mã học viên và không ghi production.

| Lệnh | Đọc vào và cách xử lý | Kết quả cần xem; khi lỗi |
| --- | --- | --- |
| `python ops/releases/k56-class-access-20260924/audit_roster_worker.py` | Đọc image/health API và số hàng trong hai schema, rồi tóm tắt log bộ đối soát. | K56/K67 healthy, restart 0; số roster/quyền/checkpoint phù hợp lượt ERP mới. Nếu `toolOutcome` lỗi hoặc `errorEvents` tăng, dừng kết luận và điều tra. |
| `python ops/releases/k56-class-access-20260924/bridge_dry_run.py --audit-eligibility` | Đọc snapshot ERP mới nhất cùng roster/quyền K56, tính chênh lệch trong RAM. | `productionWrites=0`, không có lớp/học viên xung đột. Chênh lệch giảm phạm vi cần xét riêng, không tự xóa bài hay tắt lớp. |
| `python ops/releases/k56-class-access-20260924/stage_live_gate.py --from-current-live --unified-candidate --full-suite` | Đọc source từ image K56 hiện hành, dựng bản sao tạm và chạy regression/SQL smoke. | 225 test và 10 SQL smoke đạt trên image đã ghim. Nếu image thay đổi, script dừng `LIVE_IMAGE_OR_PACKAGE_UNEXPECTED`; phải kiểm revision mới, không sửa hằng số để bỏ qua cổng. |
| `npm test` và `npm run check` | Chạy regression và kiểm cú pháp trên source local. | Không fail/skip. Kết quả local không thay thế bằng chứng image live hoặc bài nộp thật. |

Việc kiểm workflow n8n cần dùng công cụ và quy trình trong `n8n-workflows/AGENTS.md`: xác nhận workflow `e7Decjrz6jzBMSLF` active, ba chính sách lưu execution, lịch 04:30 và một execution **do Schedule Trigger tạo** sau mốc chuyển. Không chạy lại thủ công chỉ để chứng minh lịch. Nếu lượt mới làm số lớp/học viên giảm, bộ đối soát K56 phải dừng ở trạng thái cần xem riêng; giữ bài cũ và kiểm ERP trước mọi sửa production.
