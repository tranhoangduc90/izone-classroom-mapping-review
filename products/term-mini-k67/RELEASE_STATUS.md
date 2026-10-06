# Trạng thái tách Term Test/Mini Test K67

Ngày 06/10/2026. **Đã chuyển K67 và kiểm hành trình bằng dữ liệu mô phỏng trên
hệ thống thật.** K56 tiếp tục dùng runtime/tuyến hiện có; không dựng lại
backend chung, không xóa bài/điểm thật hoặc chấm lại lịch sử.

## Đã kiểm bằng hệ thống thật

- Kho `term-mini-k67-postgres`, DB `term_mini_k67`, đã nhận snapshot cuối
  nhất quán mới gồm 2.353 hàng của 13 bảng, giữ ID, token, nháp, hạn và điểm.
  Hash từng bảng khớp nguồn; 15 liên kết không mồ côi, bộ đếm ID khớp và
  26 trigger lịch sử hoạt động. Không dùng snapshot diễn tập làm bản cuối.
- Runtime `term-mini-k67-api`, Redis `term-mini-k67-redis`, cấu hình và quyền
  dữ liệu riêng đang sử dụng. Role ứng dụng không ghi ngữ cảnh/DDL/quản trị;
  hàng xử lý dùng namespace `termmini:k67:*`, AOF và credential riêng.
- Dịch vụ đọc `term-mini-k67-context-source` chỉ đọc năm view được giới hạn
  11 lớp, qua role và khóa riêng. Không đọc bảng gốc, bài/điểm hoặc khóa phiên.
- API `https://ducizone.ddns.net:18869/term-mini-k67-api` đang phục vụ K67.
  Đường ngữ cảnh có khóa riêng; không khóa 401, ngoài phạm vi 404, POST 405.
  Vhost443 chỉ bổ sung include chuyển đúng API Term và POST Mini cũ, không
  chuyển toàn bộ backend chung hoặc đăng nhập sản phẩm khác. Sai khóa/chữ
  hoa-thường Mini không được chuyển đổi. Hai health chung/K56 vẫn 200.
- `term-mini-k67-context-sync` đã áp dụng hai snapshot tự động liên tiếp qua
  HTTPS vào kho K67: 11 lớp, 185 hồ sơ, 184 thành viên, 7 tài khoản, 11 quyền lớp.
  Hash nội dung khớp API; làm mới mỗi 30 giây, quyền quá hạn 120 giây bị từ
  chối. Ứng dụng K67 không đọc DB chung.
- Ảnh chạy production đã dựng từ Dockerfile, package-lock và source K67;
  kiểm hash 20 file bên trong ảnh, không dùng ảnh backend chung làm base.
- 49 workflow K67 được ghim sang API/Redis riêng; ba bản nhận bài/poll/gửi
  điểm bật, child gọi nội bộ giữ inactive. Hai parent nguồn đã dừng; writer
  Writing nguồn vẫn bật vì phục vụ luồng khác. Fence chặn ghi đúng 13 bảng
  nguồn; SELECT, 16 bảng K56 và năm bảng Writing ngoài Term không bị khóa.
- Ba học viên giả mới trong CODEXDEMO806 đã qua Term Test 1/2 và Mini Test:
  đề/audio thật, giải mã audio, nháp cũ/mới, giữ hạn và nộp lặp đều đạt.
  Ba run, sáu job, 12 tiêu chí chấm hoàn tất; hai kết quả Writing sẵn sàng
  và nhìn thấy qua API. Mỗi job chỉ xử lý một lần, không có job Portal giả.
- Sau mô phỏng, loại đúng dữ liệu giả rồi đối soát lịch sử 13 bảng vẫn khớp
  snapshot và nguồn bị fence. Không reset hoặc sửa bài thật để làm test đạt.
- Đã đổi API18869 sang runtime K67 thứ hai rồi trả bản chính trên cùng
  image/source và kho đã có bài mới. Ba kết quả không đổi; bản thử đã dừng.
  Tuyến/file K56 và backend chung giữ nguyên trong diễn tập.
- Chín trang có cấu hình/CSP riêng đã phát hành Pages. Coverage giao diện
  đủ 59 native ID không trùng trên cùng nền/cấu hình. Một ca K56 timeout
  Chrome được chạy riêng và đạt; giữ biên nhận lỗi gốc và ghép coverage.
  Chín trang live đã kiểm bằng Chrome thật: API mới, roster/CORS đọc được,
  không lỗi ứng dụng. Luồng Portal có 13 phép kiểm native với đích giả;
  backend có tám phép kiểm native PostgreSQL/HTTP lỗi và phục hồi.

Commit Pages `452651a41e7625befa8b806176cf77c5e2137776`;
[lượt phát hành 37463205021](https://github.com/tranhoangduc90/izone-ai-team-pages/actions/runs/37463205021)
đã thành công. Cookie teacher K67 có tên/path riêng; trang cũ báo tải lại.

## Biên nhận riêng tư hiện hành

Gốc bằng chứng: `E:/Codex-Data/k67-backend-separation-20261006/`.

| Phần đã kiểm | Biên nhận |
| --- | --- |
| Chép bản cuối | production-migration/deployment-f4e7bbcf15e445b78af0bf7b8bde11df.json |
| Chuyển tuyến cũ | legacy-routing/deployment-9fdd0908461f466f94bbca6941002413.json |
| Bật workflow K67 | production-activation/deployment-ee46a0aa24c045cf8c70783886b1afb8.json |
| Tương thích Mini cũ | legacy-mini-map/deployment-d3b3228b12674c35a17ce81ced35464f.json |
| Hành trình mô phỏng | production-journeys/deployment-e69ce7a2128a428c87467a200e724bab.json |
| Bảo toàn lịch sử | historical-preservation/deployment-5257c4dbb9144dc9924df1ac4258bb76.json |
| Đổi runtime rồi quay lại | release-rehearsal/deployment-fc726f552f214a229a52203fb204941d.json |
| Giữ workflow, bỏ nhãn tạm | workflow-retention/deployment-240e73fe25334ec8b7e7297ad0e9a3d1.json |
| Đọc lại trạng thái cuối | final-readiness/deployment-090788f0c3b744ca981971dbad3d33d9.json |
| Nguồn ngữ cảnh | context-source/deployment-a49966a6cf2f4e5a97e6b63613a5e25b.json |
| HTTPS API riêng | public-api-route/deployment-466b82046cd64656b0fc8d6c1ce1e28d.json |
| Đồng bộ liên tục | context-mirror/deployment-3a0c3e76f85b49ae929d4628a7b0929b.json |
| Ảnh chạy | production-image/deployment-d1df3051a94a417bb0c267b6dbc0e3d0.json |
| 59 ca giao diện | pages-verification/composed-4283fb10329a495daee3251d5f91b284.json |
| Chín trang live | pages-live/verification-1ae12912-99c6-4343-99f3-7eefdf2c8a30.json |

Ảnh chạy: `sha256:2e5b521e2d8912d273a012ae5fc72084e6adc6dc8d7da2c193bdc3c677ff4eec`;
source revision `dd7dd5e0bfd464f7f08db160233f07aa812e5e5ecbc82684d8174ebacd383b70`.

Các biên nhận lỗi cũ được giữ nguyên. Lỗi đối soát mirror do ID kiểu text của
API được so theo thứ tự số đã có kiểm RED/GREEN chỉ đọc; sửa checker, không
sửa dữ liệu hay tiến trình đồng bộ. Checker dựng lần đầu chưa phù hợp làm
monitor sau khi có liên kết Google cục bộ/tài khoản bị loại giữ disabled.

Hai lượt kiểm cuối thất bại do URL roster sai trong checker và GET `--jq`
của CLI chọn sai instance cho writer nguồn. URL được sửa theo route ứng dụng;
GET đầy đủ JSON rồi chiếu metadata đã xác nhận writer nguồn vẫn bật. Giữ
hai biên nhận lỗi gốc, không sửa runtime hoặc workflow để làm checker đạt.
Lượt đọc lại cuối kiểm đủ chín hash asset, môi trường riêng, DB/quyền, Redis,
mirror còn mới 14.973 ms, API/CORS, sáu trạng thái workflow và hai health.

## Giới hạn và vận hành tiếp

Không chờ bài thật theo yêu cầu. Đăng nhập Google đã kiểm mock/native boundary
và cấu hình audience/cookie; chưa dùng tài khoản Google thật đăng nhập K67
trong lượt nghiệm thu này. Chưa tìm đủ mọi caller Mini cũ; endpoint tương
thích được giữ. Điểm 0 có RED/GREEN; lỗi/readback Portal được mô phỏng ở đích
giả, không gửi điểm giả vào Portal thật. Đổi runtime dùng cùng nghiệp vụ
đã ghim, không chứng minh bản nghiệp vụ mới bất kỳ tương thích dữ liệu.

VPS, n8n, AI, Portal và nguồn ngữ cảnh vẫn là hạ tầng/dịch vụ chung. K67 có
runtime, đơn vị dựng, cấu hình, quyền dữ liệu và hàng xử lý riêng với giới
hạn tài nguyên; vẫn có rủi ro chung khi VPS/dịch vụ chung ngừng hoạt động.
Xem CUTOVER_PLAN.md trước phát hành tiếp. Sau khi có bài mới, luôn giữ DB K67;
không trả về dump cũ hoặc bật lại parent nguồn. Khóa audio tương thích được
ghim trong env K67, không đọc lại từ backend chung mỗi lần dựng.

Không đổi/xóa bài thật, reset lịch sử, dựng lại backend chung/K56 hoặc tự ghi
DECISIONS. Tiếp tục phát triển K56 trên nền và tuyến hiện có trong suốt đợt này.
