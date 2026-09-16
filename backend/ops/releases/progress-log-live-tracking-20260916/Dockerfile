FROM izone-term-test-backend:20260916.2-progress-log-attendance

# Nhận vào ba module Progress Log đã qua test; các route Term Test và cấu hình khác giữ nguyên.
# Việc chính: thêm job Portal cho xác nhận có mặt thủ công và trạng thái đồng bộ vào dashboard.
# Kết quả: image mới có thể hoàn nguyên bằng image nền nếu health/readback thất bại.
COPY src/learning-attendance-sync.js /app/src/learning-attendance-sync.js
COPY src/learning-service.js /app/src/learning-service.js
COPY src/learning-sql.js /app/src/learning-sql.js
