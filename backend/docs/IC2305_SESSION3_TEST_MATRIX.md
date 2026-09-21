# Ma trận kiểm thử Progress Log IC2305 — Buổi 3

## Phạm vi

Ma trận này kiểm riêng nội dung buổi 3 và chạy hồi quy toàn hệ thống Progress Log. Dữ liệu trình duyệt là dữ liệu giả, không kết nối học viên thật, database production hoặc Portal.

## Ca kiểm thử tự động

| Nhóm | Ca chính | Kết quả |
| --- | --- | --- |
| Nội dung | Đúng 3 phần, 8 câu logic, số câu bắt đầu lại theo từng phần | Đạt |
| Chấm điểm | Writing = B; Listening = C/B; chỉ 3 câu khách quan có điểm | Đạt |
| Trường tự luận | Ô giữa chuỗi lập luận chỉ cần có nội dung; 15/50 cần đủ 2 ý | Đạt |
| Trường tùy chọn | Nhận xét giáo viên được phép để trống | Đạt |
| Nhánh “Vấn đề khác” | Chọn OTHER thì bắt buộc nêu rõ; đổi lựa chọn thì xóa dữ liệu phụ | Đạt |
| Contract sai | Chặn dependency không tồn tại, nằm sau câu phụ hoặc tham chiếu option lạ | Đạt |
| Dữ liệu thừa | Backend từ chối câu trả lời phụ không còn áp dụng | Đạt |
| Điểm tự khai | Chặn số âm, số lớn hơn 6 và cấu trúc sai | Đạt |
| Riêng tư | Definition và bundle công khai không chứa grading key/đáp án chuẩn | Đạt |
| Hồi quy | Buổi 2, buổi 4, ghi nhớ tên, checkpoint, điểm danh, Portal và dashboard | Đạt |
| Đồng thời/idempotency | Nộp lặp không tạo bài trùng; draft cũ bị chặn; outbox giữ đúng identity | Đạt |
| Lỗi hệ thống ngoài | Portal lỗi tạm thời không làm mất bài; job được retry an toàn | Đạt |

## Ca kiểm thử trình duyệt cô lập

| Tình huống người dùng | Điều phải quan sát | Kết quả |
| --- | --- | --- |
| Chọn tên và xác nhận | Đúng IC2305, buổi 3, khóa 56 | Đạt |
| MCQ bằng bàn phím | Space chọn được đáp án và giữ focus | Đạt |
| Chuỗi lập luận dài | Ô tự tăng chiều cao, đọc đủ nội dung, không có thanh cuộn ngang | Đạt |
| Responsive | 390 px, 768 px và 1440 px không tràn ngang | Đạt |
| OTHER bỏ trống | Không được qua phần tiếp theo | Đạt |
| OTHER rồi đổi lựa chọn | Ô phụ biến mất và dữ liệu cũ không còn trong draft cục bộ | Đạt |
| Điểm `/6` là 7 | Browser và ứng dụng chặn nộp | Đạt |
| Điểm `/6` là 5 | Nộp thành công | Đạt |
| Mất mạng khi đang gõ | Dữ liệu vẫn nằm trên máy; sau khi có mạng và xác nhận lại thì khôi phục | Đạt |
| Link sai | Hiện màn lỗi rõ ràng, không mở nhầm phiếu | Đạt |
| Màn hoàn tất | Hiện đã nhận phiếu/điểm danh; không có “Việc tiếp theo” | Đạt |
| Dashboard | Tab Theo dõi lớp đứng trước; thấy 3 phần và trạng thái đang gõ | Đạt |
| Xem bản nháp | Hiện đúng Câu 1/2 theo phần và đúng nội dung “Vấn đề khác” | Đạt |
| Cập nhật lớp | Dashboard gọi lại dữ liệu mỗi 8 giây và không trộn assignment | Đạt |

## Bằng chứng chạy

- Backend full suite: `152/152` đạt, `0` fail, `0` skip.
- Pages full Progress Log suite: `18/18` đạt, `0` fail, `0` skip.
- Pages browser regression: `1/1` hành trình đạt, gồm 8 assertion người dùng, `0` fail.
- Backend syntax/check: đạt.
- Pages syntax: đạt.
- Publish plan: đúng template `k56.entrance.listening1-speaking2.v1`, session `3`, 3 block, 9 data item, 3 scored item, answer release `hidden`.

Lệnh browser regression: phục vụ Pages trên `127.0.0.1:4188`, rồi chạy `node tests/run-memory-browser.cjs tests/progress-log-session3-ui.cjs http://127.0.0.1:4188/progress-log/index.html`.

## Giới hạn và cổng trước production

- Đây là kiểm thử build cục bộ bằng dữ liệu giả; chưa ghi assignment buổi 3 lên production.
- Thay đổi không sửa critical path nộp bài, pool database hay worker Portal. Bài kiểm tải production trước đây không bị thay thế bởi ma trận này.
- Trước khi phát hành production vẫn phải: chạy plan/readback trên database thật, được phê duyệt cổng production, phát hành assignment, mở bằng tài khoản giảng viên đúng quyền và kiểm một hành trình có kiểm soát.
