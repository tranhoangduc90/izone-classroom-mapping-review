# Công nhận bài luyện Speaking — 18/10/2026

## Kết quả học viên được nhận

Một phần luyện được công nhận khi đủ tiêu chuẩn hiện hành **hoặc** chatbot thực sự xác nhận hoàn thành cả phần đó. Đường chatbot áp dụng cả khi chatbot kết thúc sớm, thiếu câu hoặc thiếu lượt nói lại. Số câu được giữ riêng; không nâng số để vượt ngưỡng.

Xong một câu hoặc một bước chưa thay cho xong cả phần. Lời hoàn thành trước phần luyện thêm tùy chọn vẫn có giá trị. Lời người học, ví dụ trong prompt và nút chưa gửi không phải lời xác nhận. Định danh, kỹ năng được chọn, link mới nhất và chống dùng lại hội thoại tiếp tục áp dụng.

## Dữ liệu và xử lý

- `speaking-completion-policy.js` chọn các đoạn lời chatbot từ Share đã đọc, giữ số tin gốc và nguyên văn. AI chọn mã ứng viên và xác định phạm vi; server kiểm lại vai trò, câu trích và chính sách trước khi tạo bằng chứng.
- Bộ kiểm tiêu chuẩn tiếp tục chạy. Khi chưa đủ hoặc lỗi phân tích, đường xác nhận hoàn thành có thể công nhận độc lập. Bất định của AI hoặc dẫn chứng sai giữ trạng thái chưa xác minh; không quy thành học viên làm thiếu.
- Worker chuyển `acceptanceBasis`, `policyVersion`, `completionEvidence`, số câu và `countVerified` qua cả hai API. Kho dữ liệu chỉ bỏ ngưỡng đếm/category khi bằng chứng chatbot hợp lệ; các khóa định danh và chống trùng vẫn được giữ.
- Migration `202610180001_speaking_completion_evidence.sql` bổ sung JSONB `evidence` cho bài bổ trợ kho cũ; không đổi trạng thái hay số câu cũ.
- Một lần kiểm có ngân sách tối đa 90 giây đọc Share, 45 giây tiêu chuẩn và 30 giây xác nhận hoàn thành. Lease độc lập bốn phút, kho cũ năm phút; giữ cơ chế thử lại hữu hạn.

## Kết quả hiển thị và phục hồi

Màn học viên nêu căn cứ được công nhận, hướng dẫn phần còn thiếu hoặc thông báo chưa xác minh. Phân tích Bác sĩ AI có trạng thái riêng. Màn giảng viên hiển thị số quan sát được cùng căn cứ chatbot, không diễn giải số chưa xác minh là hoàn thành đủ câu.

Công nhận đủ các phần làm bài sẵn sàng nộp. Học viên bấm **Nộp bài** mới tạo biên nhận. Gói phục hồi riêng khóa theo UUID bài/link/phiên bản, đọc lại Share và dấu vân tay, giữ kết quả đã nhận, lưu trạng thái trước sửa và không tự nộp hộ. Chạy lặp không tạo thêm sự kiện hoặc biên nhận.

Source của một số module Speaking được đối chiếu với runtime đang chạy trước sửa để giữ các thay đổi live chưa có trên nhánh gốc. Phát hành dùng image live đã ghim, chỉ thay file thuộc Speaking, giữ nguyên cấu hình đăng nhập, điểm danh, mount, mạng và địa chỉ IP. Giữ container trước sửa để quay lại khi cần.

Prompt và danh sách phục hồi có nội dung riêng tư được lưu ngoài Git. Đức tự thay đích chatbot theo gói bàn giao; thay đổi bộ kiểm vẫn bảo vệ các link cũ.
