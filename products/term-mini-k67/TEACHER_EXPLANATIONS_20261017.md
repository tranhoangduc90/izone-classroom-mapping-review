# Lời giải giảng viên và sửa bảng kết quả K67

Trạng thái: đã được Đức duyệt và phát hành ngày 17/10/2026. Đăng nhập Google thật trên trình duyệt chưa kiểm trực tiếp; các kiểm chứng có phạm vi cụ thể bên dưới.

## Thay đổi

- Trang giảng viên Term 1/Mini dùng cùng cửa sổ lời giải với học viên, giữ skin Reading xám sáng–đỏ đã có. Nút Xem giải thích dùng màu xanh, chữ trắng như Reading/Listening thực chiến.
- Sửa dải trắng trong cột Kết quả của cả hai bản: khi thêm nút cao hơn, `td` dùng flex không phủ đủ chiều cao hàng. Bản sửa giữ ô là table-cell và căn giữa biểu tượng/nội dung. Chỉ áp dụng bảng đã gắn cột lời giải, không đổi bảng của sản phẩm khác.
- Giảng viên tải lời giải qua GET `/api/term-tests/teacher/explanations`, với cookie/Google auth và guard nguồn quyền hiện hành. Dùng lại cùng `listTermTestTeacherResultsSql` để giữ đúng phạm vi lớp và đúng kết quả đang hiện, kể cả Mini cũ.
- Không dùng hoặc trả token lượt thi học viên. Đối chiếu mã học viên, lớp, đề, thời điểm và chi tiết kết quả. Không chấm lại hoặc ghi điểm.
- Cache riêng từng học viên/kết quả; đổi lớp/đề/học viên hoặc đăng xuất sẽ xóa dữ liệu và bỏ phản hồi đến muộn. Làm mới cùng kết quả không đóng cửa sổ đang đọc.

## Kiểm chứng

- Tái hiện RED trên Pages hiện hành bằng cùng kiểm hình học các ô: ô Kết quả thấp hơn hàng. GREEN sau sửa; nút khớp màu `#152b4e`/chữ trắng của mẫu thực chiến.
- Hai bản học viên Term 1 và Mini: 80/33 nút, mở lời giải, desktop/mobile không tràn khung hoặc lỗi JavaScript; giữ tải lười và một lần đọc mỗi lượt.
- Giảng viên: mở đủ 113 câu; đổi học viên trùng tên vẫn dùng mã riêng, giữ cache đúng chủ, làm mới nền không đóng cửa sổ, phản hồi sau đăng xuất không dựng lại dữ liệu. Desktop/mobile giữ bố cục và skin Reading.
- 43 ca backend liên quan đạt, gồm API mới qua middleware auth thật với DB giả, chặn thiếu quyền/sai lớp/sai mã/chưa nộp đủ/kết quả đã đổi/nguồn lệch phiên bản; route chấm và nguồn quyền cũ. Ba ca phiên giảng viên đạt.
- Đọc SQL chỉ đọc đúng học viên Mini trong link IC2238 đã cung cấp: đủ 20 câu nghe + 13 câu đọc, cả 33 đáp án khớp gói nguồn. Không ghi dữ liệu hoặc gọi Portal.

Chứng cứ riêng: `E:/Codex-Data/k67-teacher-explanations-20261017/`. Chỉ ảnh có học viên mô phỏng được dùng cho QA. Đăng nhập Google thật trên trình duyệt chưa kiểm trong phần bổ sung; browser dùng phiên/API giả, middleware và quyền API được kiểm riêng.

## Phát hành và quay lại

Backend đã thêm `teacher-answer-explanations.js` và hai dòng nối route trong `app.js`, dựa trên image K67 đã có lời giải học viên `sha256:3a38f916280bf3babea68e714dca9c361b8400b89dbd6565367cce38a0d81bcb`. Không đổi SQL hiện hành, cấu hình, database, audio, n8n hoặc các gói nguồn đáp án. Sao lưu, kiểm không có lượt thi đang chạy, canary chỉ đọc và đọc lại sau chuyển.

Pages thay module/CSS lời giải dùng chung, bảng giảng viên và mã phiên bản tải của bốn trang học viên. Hai repo có branch/worktree riêng. Giữ image/container và revision Pages trước đó để quay lại trên cùng database; không restore bài/điểm.

## Đọc lại sau phát hành

- Backend PR #63 đã tích hợp tại `fb200e43ebefc3d4e23c942ac3a5e26e2c6334e9`; image `sha256:5091292cfa65e080edbea8908f9c58031a5655dfe1316df26f3b1de4e98c1d69`, giữ nguyên mọi source khác ngoài hai module nêu trên.
- Canary chỉ đọc trên image ứng viên và container thật đều đạt: đủ 80 câu Term 1 và 33 câu Mini, có đối chiếu gói nguồn. Đây là kiểm SQL/loader, không giả mạo cookie Google để gọi API production.
- 16 bảng bài thi có hash/count trước–sau giống nhau; chỉ đổi nhãn phiên bản/build, các runtime được bảo vệ không đổi. Bản trước ở container `term-mini-k67-api-before-k67-teacher-explanations-20261017`.
- API công khai `/ready` và roster IC2238 trả 200; route lời giải giảng viên thiếu đăng nhập trả 401; CORS đúng Pages.
- Pages PR #120 đã tích hợp tại `b74ae68000f295b2f850216a97b085bde8f1f860`, build thành công; cả tám file công khai khớp nội dung sau chuẩn hóa CRLF/LF của Git.
- Kiểm trên Pages công khai sau build: cả hai bản học viên đạt hình học ô/nút xanh/desktop/mobile; bản giảng viên mở đủ 113 câu, đổi học viên và đăng xuất an toàn. API/phiên trong browser là mô phỏng, không có thao tác ghi dữ liệu thật.
