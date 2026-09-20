# Phiên đăng nhập dài hạn cho dashboard K56

Bản lớp phủ này giữ nguyên image K56 ngày 15/09/2026 và bổ sung phiên cookie cho hai profile tách biệt:

- IC2264: `/mapping-api-k56`, database `izone_mapping_k56_ic2264`.
- Demo: `/mapping-api-demo`, database `izone_mapping_demo`.

Mỗi cookie bị giới hạn đúng path API của profile; hai database có bảng phiên và backup riêng. Image build kiểm hash source trước/sau để không ghi đè chuỗi hotfix K56. Rollback ứng dụng dùng lại `izone-k56-live-results:20260915.1` và giữ bảng phiên để điều tra.
