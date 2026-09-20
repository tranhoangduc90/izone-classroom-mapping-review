# Phiên đăng nhập dài hạn cho dashboard K56

Bản lớp phủ này giữ nguyên image K56 ngày 15/09/2026 và bổ sung phiên cookie cho hai profile tách biệt:

- IC2264: `/mapping-api-k56`, database `izone_mapping_k56_ic2264`.
- Demo: `/mapping-api-demo`, database `izone_mapping_demo`.

Mỗi cookie bị giới hạn đúng path API của profile; hai database có bảng phiên và backup riêng. Image build kiểm hash source trước/sau để không ghi đè chuỗi hotfix K56. Rollback ứng dụng dùng lại `izone-k56-live-results:20260915.1` và giữ bảng phiên để điều tra.

## Bằng chứng phát hành production ngày 20/09/2026

- Image: `izone-k56-live-results:20260920.1-teacher-session`; image ID `sha256:2a00b0bf3593ebb15214cf30d2d1b9df1d84354a541c1841c093438a51bd1f8e`.
- Demo: version `k56-demo-teacher-session-20260920.1`, profile `k56-demo`, container `healthy`, restart `0`.
- IC2264: version `k56-ic2264-teacher-session-20260920.1`, profile `k56-ic2264`, container `healthy`, restart `0`.
- E2E qua HTTPS/Nginx ở cả hai profile: khôi phục phiên `200`, đăng xuất `200`, cookie có `HttpOnly`, `Secure`, `SameSite=None`, `Partitioned`, `Max-Age` dương và đúng path API.
- Sau E2E, tài khoản và phiên QA còn lại ở mỗi database: `0|0`.

## Backup và rollback

- Demo: `/opt/backups/teacher-session-20260920/izone_mapping_demo-before-k56-session.dump`, SHA-256 `be724e7e3c046da47b6b5889aba7a6ddb4f831ad602c7b1fccd9d9b70991d99d`.
- IC2264: `/opt/backups/teacher-session-20260920/izone_mapping_k56_ic2264-before-k56-session.dump`, SHA-256 `c842b06894cca7fbc8d9b9ac319a8cb3805977c4cebb4ceaf517a5825fe4fc21`.
- Cả hai archive đã qua `pg_restore -l` trước migration.
- Rollback ứng dụng: gỡ lớp phủ Compose của release này và tạo lại service bằng image `izone-k56-live-results:20260915.1`. Không xóa bảng `mapping.reviewer_session` trong lúc rollback; dữ liệu này không ảnh hưởng code cũ và cần được giữ để điều tra.
