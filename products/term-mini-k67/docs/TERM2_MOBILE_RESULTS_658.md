# Term Test 2 K67 · Xem kết quả từ link thi

Pilot của [#658](https://github.com/tranhoangduc90/izone-AI-team/issues/658). Phạm vi là trang Term 2 K67 thi máy dùng journey hiện hành. Học viên lấy link xem cá nhân từ kết quả trên máy tính đã thi. Mở link để xem ngay, không nhập mã. Link giữ địa chỉ và tham số của trang thi, thêm quyền chỉ xem trong phần fragment. Quyền hết hạn sau 24 giờ. Link lớp dùng chung vẫn hướng dẫn thi trên máy tính hoặc mở link cá nhân.

API dùng quyền journey và proof của thiết bị để cấp mã. Mã chỉ dùng trên hai endpoint đọc mới, không chứa token thi có thể dùng lại. Hai endpoint kiểm bài, lớp nếu có trên link, thứ tự nếu có trên link, lượt, generation, mốc nộp, trạng thái thay thế và hạn mã. Điểm Listening/Reading dùng dữ liệu đã chốt sau nộp đủ. Writing đọc trạng thái chấm đã lưu. Lời giải qua bộ kiểm phiên bản đề/đáp án/audio sẵn có. Cấu hình `K67_TERM2_MOBILE_RESULTS_ENABLED` mặc định tắt. Khi tắt, endpoint trả 404. Giữ nguyên chính sách thi và các API cũ.

Dùng môi trường thử cách ly, dữ liệu đề và học viên mô phỏng. Từ thư mục backend `products/term-mini-k67`, chạy `npm ci` và `node --test test/term2-cbt-journey.test.js test/answer-explanations.test.js`. Từ Pages đặt `K67_BACKEND` thành đường dẫn tuyệt đối tới thư mục backend này, `K67_JOURNEY_TERM2=1` và `K67_JOURNEY_TERM2_MOBILE_RESULTS=1`, rồi chạy `node --test tests/mini-k67-journey-browser.mjs`. Có thể đặt `K67_JOURNEY_ORDER` thành `lis_first` hoặc `read_first` để chạy một ca.

Ca trình duyệt mô phỏng điện thoại trong context riêng, dùng URL giống hệt máy tính. Bộ thử dùng API ứng viên với PostgreSQL nhúng, thời gian thi rút ngắn và gói lời giải mô phỏng. Cần kiểm iPhone/Android thật với URL truy cập được trên thiết bị trước khi bật cho học viên.

Log `term_test_reliability`, sự kiện `mobile_result_access`, có thao tác `issue/result/explanations`, mã kết quả, thời gian và correlation đã băm. Truy vấn lọc theo sự kiện, thao tác và outcome để phân biệt được cấp mã, chưa công bố, từ chối và đọc thành công. Token, proof, mã xem và nội dung bài không được ghi. Khi cần dừng pilot, tắt cờ backend và quay gói Pages của riêng Term 2.
