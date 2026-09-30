# Speaking Homework: chọn lớp khóa 67

## Học viên sử dụng

Ba trang buổi 2, 3 và 4 dùng chung màn hình chọn lớp → chọn tên → Mở bài. Nếu đã ghi nhớ ở Progress Log, Writing hoặc Term Test trên cùng trình duyệt và website, trang lấy lại mã hồ sơ và hỏi máy chủ để chọn sẵn lớp/tên. Mã nhớ không tự tạo phiên và không thay thông tin của phiên đang mở.

CTA trong Docs giữ chính `documentId` làm đích ghi. Học viên cùng lớp có thể chọn tên khác chủ Docs như hành vi đã duyệt; đổi sang lớp khác bỏ Doc cũ, tìm duy nhất Doc của người đã chọn. Buổi 2 IC2304 vẫn là ngoại lệ `direct`: tìm Doc riêng và không sửa Docs cũ.

Chỉ lớp khóa 67 đang học, đã ghép Classroom duy nhất mới xuất hiện trong danh mục. Có lớp không đồng nghĩa đã có bài: thiếu bài/bản sao/CTA thì trang báo chưa sẵn sàng. Bài buổi 4 IC2304 đang nháp được giữ nháp.

## Hợp đồng API

Các đường mới nằm dưới `/api/speaking-homework`:

| Đường | Nhận | Trả và điều kiện |
| --- | --- | --- |
| `GET /classes` | `assignmentCode` | Mã lớp, mã nguồn lớp, trạng thái bài và `ready`; không trả tên cả khóa hoặc Docs |
| `POST /identity/resolve` | Mã bài + UUID đã nhớ | `unique`, `missing` hoặc `ambiguous`; không tạo grant |
| `POST /assignment/roster` | Mã lớp/bài, Doc tùy chọn | Tên/mã hồ sơ hợp lệ, phần bài và trạng thái |
| `POST /session/start-selected` | Mã lớp/bài/hồ sơ/Doc, `identityConfirmed:true` | Phiên khóa đúng người/lớp/Doc; kiểm lại đăng ký trên máy chủ |
| `POST /internal/classes/sync` | Snapshot đầy đủ lớp ERP course ID 5 | Đối soát lớp; lớp mất/đóng bị ngừng nhận bài |
| `POST /internal/classes/memberships-sync` | Bốn nguồn đăng ký đã kiểm đầy đủ | Cập nhật trạng thái, giữ lịch sử, đánh dấu `missing` người mất khỏi nguồn |
| `GET /internal/assignments/scopes` | Secret xử lý hiện hành | Các bài mở thuộc lớp 67 đã duyệt |
| `POST /internal/assignments/register` | Course/courseWork/mã bài/trạng thái Classroom | Đăng ký `docs_cta` mới một lần; nháp không tự mở, đã đóng không tự mở lại |

Các đường nội bộ bắt buộc `x-speaking-worker-secret`. Snapshot yêu cầu thời gian có múi giờ, không quá 24 giờ và không quá 60 giây trong tương lai. Snapshot cũ bị chặn; cùng thời điểm chỉ retry đúng nội dung. Ghi đăng ký có điều kiện theo `last_seen_at` để không đè cập nhật mới của luồng ERP khác. Không tạo hoặc tự duyệt student mapping.

CTA của bài đã đóng vẫn dùng được để luyện thêm nếu người đó đã nộp ở đúng phiên/Doc và còn đăng ký hợp lệ. Link chung không mở nhận bài mới cho lớp đã ngừng hoạt động. Buổi 3 chỉ cập nhật Bác sĩ AI phía sau; buổi 4 giữ hai bài bổ trợ khác nhau và luyện thêm. Thứ tự đề xuất/quy tắc 5 ngày không đổi.

## Nguồn và độ mới

Nguồn khóa dùng ERP `courses.id=5`, `short_name=67`, loại khóa/lớp đã xóa và chỉ kích hoạt lớp `on_going`. Snapshot `erp_class_state` của mở rộng 03/34/45 không phải nguồn khóa 67. Danh sách đăng ký dùng đủ bốn card Metabase 263–266; thiếu một phần hoặc nguồn bị cắt phải dừng trước khi đánh dấu `missing`. Timestamp ERP không có offset được hiểu đúng `+07:00`, rồi xuất UTC `Z`.

Chạy snapshot lớp trước, đăng ký sau; nếu bước đăng ký lỗi phải báo lỗi execution và giữ watermark trước. Không dùng tên gần giống để ghép học viên. Bản sao Classroom của người đã xác định nghỉ/tạm dừng được bỏ qua; hồ sơ chưa ghép/mơ hồ vẫn dừng, không âm thầm bỏ qua.

## Kiểm và phát hành

Gói API thay đúng năm module Speaking trên image live đã xác minh, giữ nguyên module xác thực, điểm danh, biến môi trường và tài nguyên container. Migration thêm hai bảng; không xóa lịch sử. Trước deploy phải kiểm lại image/digest live, backup database, đối chiếu hash cấu hình điểm danh và chạy test thời hạn phiên giảng viên với image ứng viên.

Local: `npm run check`, `npm test`. Browser: các suite Speaking hiện hữu, suite nhận diện đa lớp và shared student memory. Cổng phát hành: `quality-gate.json`; các ca chưa có readback thật vẫn để chưa xác nhận. HTTP 200 hoặc health không chứng minh đã ghi Docs/Bác sĩ AI/Portal.

Luồng sự kiện là gói riêng trong repository workflow. Không phát Classroom draft. Docs cũ thiếu CTA hoặc ô trạng thái được báo cần mẫu mới, không tự thêm phần để giả sẵn sàng. Cảnh báo thiếu Speaking chỉ xét `TURNED_IN`, gom theo đợt; lớp mới dùng mốc mở để không cảnh báo hồi tố homework lịch sử.

## Quay lại

Giữ container cũ đã dừng dưới tên backup; `deploy-api.sh` tự khôi phục nếu health thất bại. Nếu lỗi nghiệp vụ sau health, chuyển lại image/container cũ và đọc lại API, cấu hình, hàng chờ cùng outcome Portal. Không xóa migration, receipt hoặc danh sách luyện để quay lui. Pages quay revision trước; lớp lỗi có thể ngừng nhận bài riêng. Git revert không thay production n8n.

## Readback lát API — 30/09/2026

Migration `202609301329` đã áp dụng, ledger SHA-256 `78323d2174ca20be688443c15ebbfcf7551d8b8b3fdf82170fc977fcffb40112`; 3 mẫu có 2/4/2 phần, class scope vẫn trống. API đang chạy image `izone-speaking-course67:20260930-v2`, digest `sha256:7494996e41f788d6ee244f8ecca8fca886cf9522d65db1e4d06ff54c9a0e6c5f`. HTTPS catalog ba mã trả ok/danh mục trống/CORS đúng; direct IC2304 vẫn 15 học viên, 2 phần. Buổi 4 vẫn draft.

Source cuối đạt 279/279 test, không lỗi/skip. Ca PGlite/Express riêng 15/30/60 lượt login: 0 lỗi, p95 272/700/1173ms; không là đo tải production. Image ứng viên kiểm phiên giảng viên 90 ngày, trần 365 ngày, khôi phục/đăng xuất/CORS đạt. Bốn cấu hình điểm danh và ba module auth/worker/outbox giữ hash trước/sau; 102 việc attendance vẫn complete. Chưa có Portal outcome mới sau lần chuyển: lát API giữ `deployed_awaiting_validation`, không gọi điểm danh verified.

Backup database riêng đã kiểm SHA-256 và đọc catalog: mã `speaking-course67-20260930/mapping-before.dump`, 318672250 bytes. Container rollback giữ tên `mapping-review-api-before-speaking-course67-20260930`. Phần lớp/Pages/sự kiện và nộp thật lớp thứ hai còn là các lát sau, chưa được chứng minh bởi health của API.
