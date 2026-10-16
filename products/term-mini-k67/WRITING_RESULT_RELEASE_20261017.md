# K67 — giữ bài Writing có nội dung, đủ hai Term và hai thứ tự

Đã phát hành ngày 17/10/2026. Bản sửa nghiệp vụ `484a20bd8e05f8cc5593d41eb99ea0cb040614ce` dựa trên main `419e68e123e837e3cfef32756b9692e6948c23fb` đã chứa PR #56, #57 và #58.

## Hành vi hiện hành

- Term Test 1 và Term Test 2, cả `lis_first` và `read_first`, dùng cùng bộ chọn Writing ở tổng quan/chi tiết giảng viên. Chọn lượt đã nộp có nội dung trước lượt rỗng/chỉ khoảng trắng, rồi chọn mới nhất trong nhóm đó. Nội dung Task 1 hoặc Task 2 đều hợp lệ. Nếu chỉ có bài rỗng vẫn giữ lượt và bài chấm hiện có; bài mới có nội dung đang chấm vẫn hiện đang chấm.
- Đây là sửa lựa chọn khi đọc. Không đổi bài, lần nộp, bài chấm, điểm, lịch sử hoặc phiên đã lưu. L/R vẫn chọn phiếu mới như trước. Không regrade hoặc ghi Portal.
- Luật PR #56 chặn Reading trước nối âm thầm phiên Listening cũ giữ nguyên; Mini giấy không đổi. Các module audio Pages của PR #57/#58 giữ nguyên byte trên runtime: Term 1/Mini 128 kbps, Term 2 MP3 gốc 96 kbps. Phòng chờ, tải đủ/kiểm hash, xác nhận phát, giữ bài, phục hồi và bù giờ không đổi.

## Production và quay lại

| Trường | Bản đã đọc lại |
|---|---|
| Runtime / DB | `term-mini-k67-api` / `term_mini_k67` |
| Image mới | `sha256:674229a76d9b90a07404150cfd5bfdb30a8da8046b267c74f71e1e99f72cff3e` |
| Image audio làm nền | `sha256:a32bdbee9aa29a51ab874dbb5c0a1b3e1ce8c7dacd6acdf92c65bb98c1e72b99` |
| App version | `k67-writing-nonempty-20261017` |
| `K67_BUILD_SHA` | `b709fbb95fc68b16f60109becd49b71e08d0155df2618cfbeaf7ddc0e7cb052a` — hash gói module, không phải Git SHA |
| Module duy nhất thay | `src/sql.js`, SHA-256 `051c159da63b3d1c3f2058d701f98c1a2ff3e46832c07583351622d498d54614` |
| Container quay lại | `term-mini-k67-api-before-k67-writing-nonempty-20261017` |

Chỉ hai nhãn phiên bản env đổi; cờ audio, hạn giờ, quota, mount và cấu hình còn lại giữ nguyên. Không rebuild toàn repository hoặc rollback về image trước audio. Nếu cần quay runtime, dùng container/image nền trên **cùng DB hiện hành**, giữ URL/audio đã ghim. Không restore dump, bật parent cũ hoặc ghi lại Portal.

## Kiểm chứng

- Bốn ca Writing rỗng che bài cũ thất bại đúng `4 !== 6` trước sửa. Sau sửa: 60 ca tập trung, phủ cả hai Term × hai thứ tự, Task 1/2, nháp, bài đang chấm, trùng tên/khác ID, các phiên Listening cũ; không ghi Portal.
- Full backend ghép đủ 329 ca: 60 tập trung + 234 core + 23 database/quyền + 8 HTTP integration + 4 HTTP runtime, không skip. Hai file tập trung loại khỏi nhóm core để không chạy/đếm trùng. Source ứng dụng không đổi giữa các nhóm.
- So SQL nền/ứng viên/production trên 544 kết quả học viên–test: chỉ Writing cần phục hồi đổi hiển thị; bài gốc 281 từ và toàn bộ nhận xét khớp bản lưu, trả 6.0. L/R 6.5/6.0 và Writing Portal 6.0 cùng lịch sử đọc lại nguyên vẹn. Lượt rỗng và bài chấm 4.0 vẫn giữ để đối chiếu.
- Hash/count 16 bảng giống trước/ngay sau chuyển. Runtime healthy/restart 0, public health/ready đúng build; yêu cầu xung đột trả 409. API chung, K56, n8n, Redis và context sync không đổi container/image/thời điểm chạy.
- UI live mở được bài 281 từ và bài chấm 6.0 bằng phản hồi SQL production trong Chrome cô lập; chặn mọi API ghi, không có lỗi console. Phiên đăng nhập được mô phỏng, **chưa kiểm Google giảng viên thật**. Audio giữ module và kế thừa bằng chứng Chrome/Edge của đợt PR #57/#58; không gọi lần này là chạy lại toàn bộ canary audio.

Bằng chứng riêng: `E:/Codex-Data/k67-both-terms-verification-20261017/` (TAP, backup DPAPI/dump, so SQL, Portal, ảnh và log). Một phép kiểm đầu giả định bài gốc còn là lượt mới nhất đã phát hiện lượt rỗng phát sinh sau đó; một canary helper ban đầu lỗi đường dẫn file riêng, đã sửa đường dẫn tuyệt đối rồi kiểm lại. Giữ các lỗi này, không tính là pass. Job retry lỗi lưu kết quả có trước đợt này chưa được sửa; snapshot không thay quan sát live cho lần phát hành sau.
