# Bộ nhớ phát hành Progress Log — 01/10/2026

## Phạm vi và trạng thái hiện hành

- Người dùng đã cho phép thử PostgreSQL riêng và triển khai gói nâng cấp khi cổng kỹ thuật đạt. API, demo và Pages đã chuyển bản; nghiệm thu toàn bộ còn chờ kết quả điểm danh mới đọc lại từ Portal và kiểm dashboard trong phiên giảng viên thật. Trạng thái là `deployed_awaiting_validation`, chưa `verified`.
- Pilot IC2305 = ERP **1294**, 18 học viên, **31 buổi**. Journey nằm trong phiếu Progress Log và giữ cách chọn tên; không có link Journey riêng. Test/không có phiếu không được coi là vắng. Nộp đủ Progress Log mới kích hoạt điểm danh Portal.
- Đã phát hành dấu tải/thử lại/quay lại Journey; chọn lịch ERP bằng một ô thứ/ngày/số buổi, đọc lịch khi mở và nút đọc lại; đề xuất có mốc giữ nguyên, giảng viên xác nhận; Hành trình lớp/chi tiết; phân tích lỗi; soạn/copy/nhập/xem thử/lưu nháp/duyệt/phát phiếu.
- Chỉ tám nhóm hiện có, đã đối chiếu sáu phiếu/57 câu/14 ô gapfill. Không nối Đức Anh/Firebase, không bài luyện thêm, dạng mới hay AI chấm. Reading/Listening hoàn tất tự hiện; Writing chờ rồi cập nhật muộn.

## Mã nguồn và Git

- Revision ứng dụng/schema/tests đã kiểm: `source-sha256:f6d173b0f900d9f4a49014a49733ce2f0c5afd548a9c2ed695764035d2dacea0` (176 file, chuẩn hóa CRLF).
- Backend ứng viên `2aaf16f69ffbd66300cf6fb40171788725eb73ee`, base `4a2ae8f281892d34229149904747cc3c33b98149`. Cập nhật tài liệu phát hành sau đó không đổi revision ứng dụng đã kiểm.
- Pages ứng viên `5304a36d700fe43d023523a8f64f4c4e99bccb2f`, PR42 đã merge thành `83c5ba272a6de48658b24d9e8fd67fe291f3bb7e`; Pages build36820483113 success.
- Không dựng toàn bộ API từ main local cũ. Image mới là overlay 14 file Learning trên API live, giữ module Speaking/Term Test/auth và cấu hình khác. Đã đọc lại hash 14 file khớp ứng viên.

## Production và điểm khôi phục

| Thành phần | Bản hiện hành | Bản quay lui giữ lại |
|---|---|---|
| API `mapping-review-api` | `izone-progress-log-upgrade:20261001-candidate` | `izone-speaking-course67:20260930-v2` |
| Demo `progress-log-demo-api` | `izone-progress-log-demo:20261001-upgrade` | `izone-progress-log-demo:20260929.1` |
| Pages | merge `83c5ba2` | base `6e82084` |

API image ID `sha256:1a0d5f0e9028cfb37397981ef697276ce7ed35fd05efc688dddd5e18f2f597cf`; demo `sha256:fd08c2eb2d62bc48f052debba66f452f9fd526fe990857d229c7983f9c4c948d`. Hai container healthy, env và cấu hình Docker đã đối chiếu giữ nguyên. Consumer điểm danh có mặt, poll2000ms; đích điểm danh không đổi. Phiên giảng viên 90 ngày không hoạt động/tối đa365 ngày vẫn giữ.

- Hai container cũ dừng, giữ với hậu tố `-before-progress-log-upgrade-20261001`, restart=no. Không xóa trước khi nghiệm thu xong.
- Backup PostgreSQL **20261001T050225Z**, VERIFIED: VPS `/opt/backups/mapping-db-daily/20261001T050225Z/`; bản riêng tư local `E:/Codex-Private/mapping-db-backups/20261001T050225Z/`. Dump322239638byte,1645entry, SHA256 `6258d3633a460d7ca1d8946798512a482a749d06c0488fce104fbf3fb3ea7e02`.
- Backup demo nhất quán `demo-volume-before-verified.tar`, hash `24ac051b941b0cad41f8256c49927a120a42064e4802fa9540ab41a1d4642865`; đã so tất cả file sau phục hồi và thử image mới/cũ healthy trên bản copy.
- Migration **202610010001_progress_log_form_drafts.sql** đã áp bằng runner transaction/ledger, checksum `cdc8fd2c844f17184d80aa508a2160f962be541e56989f30fadb9f7d3900a841`, ledger37 dòng. Hai bảng/five triggers; learning_api SELECT/INSERT/UPDATE, không DELETE. Không backfill hay xóa bài.
- Hai lần chuyển đầu lỗi đối chiếu SecurityOpt/VolumeOptions; script quay về cả hai image cũ và đọc lại healthy. Sửa cách giữ cấu hình/so sánh, preflight rồi lần3 chuyển thành công. Giữ log lỗi và bằng chứng rollback; không ghi thành ba lần thành công.
- Quay lui code giữ schema mới tương thích, nháp/version/assignment/bài/điểm đã nhận. Không DROP, gỡ guard hoặc hoàn nguyên Portal. Operator đã kiểm ở VPS `/opt/izone-progress-log-upgrade-20261001/deploy-containers.py`; chứng cứ riêng ở thư mục cùng tên local.

## Bằng chứng đã đạt

- Backend303/303; Pages38/38; callback Chrome2/2; Chrome→API→DB1/1; cùng test loading/date picker RED base/GREEN head.
- PostgreSQL16 riêng6/6: nhiều connection chờ khóa, publisher cũ/mới, retry cùng operation, replacement/ID guard, rollback và replay migration.
- Phục hồi backup thật vào DB riêng: 113 bài/19 phiếu, số lượng dữ liệu nghiệp vụ không đổi; API mới bằng learning_api và API cũ trên schema mới đều đạt. Không gọi ghi ERP/Portal từ môi trường thử.
- Test auth trên image cuối1/1; HTTPS health/ready/401/CORS và bảy asset Pages khớp source:14 kiểm đạt. 401 chỉ chứng minh ranh giới chưa đăng nhập.
- Pages thật trên Chrome mobile: IC2305 roster18/Journey31, spinner trước response, quay lại, không tràn ngang/console error; không bắt đầu/nộp bài. Nút Hành trình lớp có trên dashboard; chưa thay bằng chứng phiên giảng viên thật.
- API thật đọc IC2305:31 buổi/18 người/4 assignment/67 bài hoàn tất, Overview/analytics/draft routes đọc được. Harness nội bộ dùng middleware thử cho contract, không chứng minh đăng nhập HTTP thật.

## Còn phải xác minh

1. Phiên Chrome đang đăng nhập: tải lại dashboard, Hành trình lớp, chi tiết, đọc lịch và bộ soạn; kiểm giữ phiên. Công cụ CUA lỗi khởi tạo kernel assets, không lấy được phiên của người dùng. Không tạo cookie giả hay tuyên bố đã kiểm phiên đó.
2. Bài nộp thật hợp lệ sau chuyển API → consumer → Portal readback. Hàng đợi đọc lúc `2026-10-01T05:48:51.017Z`:102 complete,0 stale; chưa có việc mới nên không đủ kết luận điểm danh sau chuyển bản. Không nộp giả IC2305 hay requeue/force Portal chỉ để có test xanh.
3. Checker toàn gói giữ phần chưa đạt; không thu nhỏ `small_complete`, không xóa G03/rủi ro Portal để đóng task.

Trùng assignment lịch sử: IC2174/ERP1159/buổi1 có5 phiếu active trước migration, bản restore cũng có. IC2305 không trùng. Không tự xóa dữ liệu lịch sử này. Lark replica lỗi giới hạn biến động từ29/09 là trạng thái có trước, không thuộc phát hành này.

## Nơi đọc tiếp

- [Runbook](PROGRESS_LOG_UPGRADE_20261001_RUNBOOK.md), [manifest](PROGRESS_LOG_UPGRADE_20261001_QUALITY_GATE.json), [hồ sơ phát hành](PROGRESS_LOG_UPGRADE_20261001_RELEASE_CANDIDATE.md).
- Bằng chứng riêng: `E:/Codex-Data/progress-log-plans/2026-09-30/`; ledger `E:/Codex-Projects/ielts-worktrees/ledger/progress-log-upgrade-20261001.json`. Không đưa dump, token, key hoặc bài học viên vào Git.
