# Mốc image đã nhập để phát hành Writing D08

Đầu vào là ba image bất biến đang chạy và dấu kiểm từng file source. Dockerfile giữ đúng image đó để có thể khôi phục; không dựng lại từ một nhánh mới.

Commit chứa hồ sơ này là **mốc nhập artifact hiện tại**, không phải commit lịch sử đã dựng image. Commit dựng image gốc chưa xác minh và được ghi `unknown`. Adapter chỉ ánh xạ live về mốc này khi image và toàn bộ dấu kiểm source thực sự khớp. Nếu khác thì chặn chuyển bản.

Không chứa cấu hình bí mật, dữ liệu học viên hoặc bản sao cơ sở dữ liệu. Cấu hình chạy được so bằng dấu kiểm riêng; khôi phục giữ dữ liệu đã nhận, không phục hồi toàn cơ sở dữ liệu.
