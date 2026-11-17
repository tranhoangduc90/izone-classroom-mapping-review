# Term Test 1 K56: tiếp tục bài chính thức qua hồ sơ khác

Gói dựng từ chính overlay K56 build `4d29ffa2` đang phục vụ. Không rebuild backend từ main. `stage.py` thêm capability Term 1 và giữ core skill-grant/hold; `parallel-attempts.sql` thêm cờ/trigger, giữ hai loại parallel entry khỏi unique index của lượt cũ. Một lần báo gián đoạn chưa giữ chỗ bài chính thức. Seal hợp lệ đầu tiên giữ bài, nội dung đã seal bất biến; kỹ năng còn lại có thể được nhận từ hồ sơ khác cùng danh tính/thế hệ.

`stage-journal.py` sửa phép nối biên nhận Writing: grading run ở bài chính thức phải tìm được thao tác đã nhận từ hồ sơ nộp thực tế. Kiểm đúng người, lớp, đề, thế hệ, session, Task 2/Task 1 và nội dung essay. Giữ nguyên Mini và nhánh online hold. Test `writing-receipt-link.test.mjs` dùng HTTP/SQL cách ly, RED trên helper phục vụ, GREEN cho cả hai Term và từ chối sai task/generation/người.

`deploy.py` chạy trên VPS theo từng bước `inspect`, `stage`, `migrate`, `switch`, `rollback`; manifest và payload nguồn ở thư mục release riêng tư `/opt/izone-term1-k56-parallel-entry-20261118`. Stage clone đúng image, command, env, mount của container hiện hành; chỉ thêm mode Term 1 và bốn module đã kiểm, loopback 19807. Migration chờ khóa tối đa 5 giây, câu lệnh tối đa 30 giây, đối chiếu dấu vân tay cả bảng attempt/session trong giao dịch trước commit. Không ghi lại payload/biên nhận/điểm cũ. Chỉ chuyển proxy khi idle và loopback đã đạt; tự trả proxy cũ nếu readback thất bại.

Quay API về container build `4d29ffa2` ở 19806; giữ schema additive và dữ liệu đã nhận, không restore dump hoặc reset lượt mới. Giữ bản cũ sẵn sàng cho rollback. Term 2 cloud và các mount/cờ khác không đổi. Pages companion là PR #730. Nguồn cloud native mới của Term 1 là bước riêng, chưa được bật bởi gói này.

Bằng chứng riêng tư trong kế hoạch GOAL Test ngày 18/11: hai ca browser ghép API native thật/SQL cách ly cho hai thứ tự, Task 2 và mất ACK; ca metadata qua owner/context/collect thật vào kho mã hóa cách ly. Không chạy AI hoặc ghi Portal thật và không coi các ca ngắn là nghe đủ thời lượng/kiểm thiết bị thật.
