# Lớp demo Term/Mini 56 và 67 — 20/10/2026

## Kết quả người dùng nhận được

Mỗi khóa có 10 học viên giả và ba bài Term Test 1, Term Test 2, Mini Test. Cổng Pages `/term-tests/demo/` có chọn khóa/bài/thứ tự và reset riêng một bài hoặc cả ba bài của một người. Dashboard `/term-tests/substitute-test-1-k56-dashboard/` nối tới hai lớp demo; không mở lại dữ liệu Substitute đã dọn.

Khóa 56 dùng `CODEXDEMO56`, runtime/kho riêng; khóa 67 dùng `CODEXDEMO806` và nhánh demo sẵn có của K67. Không nhập lại bài demo lịch sử, không khôi phục dump đè dữ liệu mới. Hai lớp được cấp định danh mới cho 10 người giả; cùng người dùng cùng UUID giữa ba bài. Không tạo hồ sơ học viên thật, Google Classroom hoặc bản ghi ERP.

Đức chọn **AI chấm thật, không gửi Portal**, sau đó chọn **demo K56 xem kết quả ngay khi AI chấm**. Hai lựa chọn được xác nhận trong chat này ngày 20/10. Quy tắc lớp thật không đổi: vẫn công bố Writing sau hai giờ.

## Module phát hành

`k56-student-writing-release.mjs` nhận trạng thái chấm và mốc sẵn sàng. Bài chưa chấm giữ trạng thái chờ. Khi cả hai cấu hình `DEPLOYMENT_PROFILE=k56-demo` và `DEMO_ISOLATED_MODE=true` khớp, bản đã chấm trả nguyên điểm/nhận xét ngay. Các cấu hình khác vẫn dùng thời gian chờ hai giờ; thiếu mốc chuẩn không suy đoán thời gian công bố.

Đây là bản vá một file lên image demo hiện hành, không phải lệnh dựng toàn backend từ main. Khi dựng lại demo, phải giữ thay đổi này và đối chiếu source live trước. Snapshot và credential không nằm trong Git.

| Thành phần | Bản đã đọc lại |
|---|---|
| File trong image | `/app/src/k56-student-writing-release.mjs` |
| Image demo trước | `sha256:c596d98c830fe94caf4fc603381eb912a6aba31696f90e12a09dbd331051d196` |
| Image demo mới | `sha256:6ae5811845c3b136bdd8fc1ec19061bf71e901629e5d615a222b396b08d1d795` |
| Container quay lại | `izone-k56-demo-k56-demo-api-1-before-demo-immediate-20261020` |
| Pages | [PR #151](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/151), merge `fe456a8eaeebbfcc94543c0296b3ef55bba1e7ef` |

Image mới chỉ đổi đúng module này; source khác, cấu hình, mount và các dịch vụ khác được so giữ nguyên. Không đổi database/workflow trong bước bỏ thời gian chờ. Portal K56 demo không cấu hình đích ghi và bật chế độ cô lập; K67 bỏ qua Portal theo mã lớp demo hiện hành.

## Kiểm chứng

- Pages: 51 ca native trong phạm vi, không lỗi/bỏ qua; kiểm browser desktop/mobile bằng Edge. 24 tài nguyên public khớp byte Git, sáu roster đúng 10 người và CORS hợp lệ. API từ chối reset lớp thật.
- Module: cùng ba ca kiểm thất bại đúng hành vi mới trên bản cũ rồi đạt trên bản mới. Ba ca trong image mới đạt; kiểm lớp thật vẫn chờ hai giờ, cấu hình thiếu/sai không mở sớm và bài chưa chấm không lộ điểm.
- Hai bài giả Term 1 đi qua HTTP thật, AI thật và lưu nhận xét/điểm thật trong kho demo; cả hai nhận 4.5. K56 trước thay đổi trả `awaiting_release`; sau thay đổi trả `ready`, một Task và đủ nhận xét. K56 Portal `disabled`, K67 `not_applicable`; kho không có việc demo đã gửi Portal.
- Reset qua trang public xóa đúng lượt đã chấm của học viên 09 trong cả hai khóa; số lượng cùng hash bài/phiên của học viên đối chứng 10 giữ nguyên. Sau đó dọn đúng lượt đối chứng vừa tạo. Không reset toàn lớp hoặc học viên 01–08.
- Không phát hành lại API lớp thật K56/K67; hai image lần lượt vẫn là `8293417a…` và `5917c411…`. Không sửa n8n; đã quét 1.626 workflow để xác định đúng parent demo K56 đang bật và đọc execution hoàn tất, không lấy tên workflow cũ theo trí nhớ.

Kho bằng chứng riêng máy Đức: `E:/Codex-Data/lop-demo-cac-khoa-20261020/`, gồm `public-readback.json`, `native-final.tap`, `immediate56-image.json`, `immediate56-activation.json`, `immediate56-readback.json`, `canary67-summary.json`, `reset-before.json`, `reset-after.json` và ảnh giao diện. Kho có bản sao trước thay đổi cùng script phục hồi/tạo roster; không sao chép cả kho vào Git.

## Tiếp tục vận hành và giới hạn

Frontend đã nhập main/phát hành qua Pages PR [151](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/151), [152](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/152), [153](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/153), [154](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/154), [155](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/155). Bố cục cuối theo yêu cầu Đức: **khối demo ở cuối dashboard K56, sau Xem kết quả**; mã demo vẫn là lựa chọn đầu bộ chọn lớp khi đăng nhập. Mốc Pages cuối của task là `1d8e86154b542a160142b9513626d0b3a6732182`, run `39406008636` thành công; các PR mới hơn của task khác không thuộc gói này.

Lượt lưu Git ngày 21/10 chỉ tích hợp module đã phát hành và hồ sơ này; không gọi deploy, sửa workflow hoặc tạo/xóa bài. Source gói nằm ở thư mục `ops/releases` để giữ chính xác bản overlay đang dùng trên image demo; không suy toàn backend main tương đương image production. Giữ checkout main đang bẩn; không reset/stash để đồng bộ.

Các nhóm Pages lịch sử trong phạm vi: 55 ca ở bản phục hồi; 67 ca khi thêm lối vào dashboard; 17 ca liên quan ở bản đổi vị trí khối demo. Không cộng các nhóm chạy trùng thành tổng mới. Bản Mini giấy đã được sửa nhận lớp demo từ link và reset cổng demo xóa đúng nháp cục bộ cùng người/bài. Kiểm public 12 đường vào đủ 10 tên, 25 asset khớp trước sửa dashboard; sau đổi vị trí đã mở lại đúng URL IC2370 trên desktop/mobile, lớp thật giữ nguyên và khối demo cuối trang. Bằng chứng riêng có `native-final-v3.tap`, `dashboard-final.tap`, `dashboard-bottom.tap`, `dashboard-priority-readback.json` và ảnh `dashboard56-bottom-*.png`.

Chưa kiểm tài khoản Google giảng viên thật, không nghe hết audio bằng tai hoặc đợi hết toàn thời lượng thi. Hai canary AI là Term 1; không dùng chúng để tuyên bố đã chấm lại toàn bộ Term 2/Mini hoặc đã kiểm mọi rubric. Đề, thời lượng và bộ chấm hiện hành được giữ.

Muốn bắt đầu lại, đóng tab của học viên đó rồi bấm reset trên cổng demo. Khi mất phản hồi, đọc lại trạng thái trước khi thử lại. Bài reset đang chấm sẽ mất lượt demo tương ứng; không tự chấm lại hoặc chuyển hồ sơ sang lớp thật để khôi phục.

Quay lại thay đổi thời gian công bố bằng container demo cũ, giữ nguyên DB/volume mới. Không phục hồi nguyên database để quay lại giao diện hoặc thời gian chờ. Dừng/dọn demo hay phát hành source lên GitHub là thao tác riêng trong quyền hiện hành.
