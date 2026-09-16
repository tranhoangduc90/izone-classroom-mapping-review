# Kiểm thử tải `mapping_db` lúc 03:00 ngày 25/08/2026

Updated: 2026-09-17
Status: **Lượt 26/08 dừng ở nấc 150% do guard load VPS; cảnh báo đỏ cho mở rộng**Audience: Đức, agent kỹ thuật và người vận hành

## 1. Mục tiêu dễ hiểu

Bài test trả lời hai câu hỏi:

1. PostgreSQL hiện tại xử lý được bao nhiêu giao dịch khi số kết nối tăng gấp đôi mức API đang cho phép?
2. Khi database bận hơn, n8n và hai API production có tiếp tục khỏe hay không?

Test không gửi bài, không sửa điểm, không gọi workflow và không ghi vào `mapping_db` thật.

```text
Backup VERIFIED gần nhất
        ↓
PostgreSQL tạm, không có mạng ngoài
        ↓
13 kết nối → 20 kết nối → 26 kết nối
        ↓
Đo TPS, độ trễ, CPU/RAM và sức khỏe production
        ↓
Xóa container + volume tạm, giữ báo cáo tổng hợp
```

## 2. Phạm vi và giới hạn

| Hạng mục | Cấu hình |
| --- | --- |
| Thời điểm | 03:00, ngày 25/08/2026, giờ Việt Nam |
| Số lần | Một lần; timer không lặp hằng ngày |
| Dữ liệu | Restore từ backup có cờ `VERIFIED` vào container tạm |
| Production | Chỉ đọc health/metrics; không chạy pgbench vào database thật |
| CPU container test | Tối đa 0,75 CPU |
| RAM container test | 768 MiB, tối đa gồm swap 1 GiB |
| Mạng container test | `none`; không nhận kết nối bên ngoài |
| Bài test | pgbench mixed read/write trên bảng riêng trong database tạm |
| Nấc tải | 13, 20 và 26 connection; mỗi nấc 60 giây |

Đây là bài kiểm tra sức chịu đựng của PostgreSQL/VPS, không phải mô phỏng đầy đủ AI, trình duyệt, API và n8n từ đầu đến cuối.

## 3. Cổng tự dừng

Bài test tự dừng và dọn môi trường tạm nếu xuất hiện một trong các điều kiện:

- Mapping API hoặc Writing API không còn `healthy`.
- n8n vượt 70% CPU hoặc n8n Dispatcher vượt 50% CPU tại lần lấy mẫu.
- Load trung bình một phút của VPS vượt 3,5.
- RAM khả dụng dưới 768 MiB.
- Connection của PostgreSQL production vượt 70/100.
- Backup đang chạy, dung lượng trống dưới 8 GiB, backup không có checksum hợp lệ hoặc PostgreSQL tạm không khởi động được.

## 4. Tiêu chí đọc kết quả

| Kết quả | Cách hiểu | Hành động |
| --- | --- | --- |
| Hoàn thành cả ba nấc, production luôn healthy | Nền tảng đủ khoảng trống cho giai đoạn mở rộng gần | Giữ phần cứng; rollout field/sản phẩm từng bước |
| Dừng ở 200%, hai nấc trước ổn | Có thể mở rộng nhưng chưa nên gấp đôi toàn bộ tải cùng lúc | Giới hạn pool và rollout theo nhóm |
| Dừng ở 100% hoặc 150% | VPS chung n8n/PostgreSQL là giới hạn đáng kể | Tối ưu query thực tế, sau đó cân nhắc nâng/tách máy |
| API mất healthy hoặc invariant sai sau test | Không đạt | Dừng rollout và điều tra trước mọi mở rộng |

Không kết luận chỉ bằng TPS cao. Điều kiện quan trọng nhất là production không suy giảm, không có lỗi giao dịch và invariant sau test vẫn `ok=true`.

## 5. File và nơi đọc kết quả

- Script: `backend/ops/load-test-mapping-db.sh`.
- Lịch systemd: `mapping-db-load-test-20260825.timer`.
- Báo cáo VPS: `/opt/backups/mapping-db-load-tests/<run-id>/`.
- Script đọc an toàn: `backend/scripts/read-mapping-db-load-test.ps1`.
- Báo cáo chỉ gồm state, TPS, latency, CPU/RAM, health và số connection; không chứa dòng dữ liệu thật.

## 6. Readback bắt buộc sau bài test

1. Đọc state/summary/metrics và log systemd.
2. Chạy `check-production-invariants.ps1`; phải trả `ok=true`.
3. Kiểm hai API `healthy`, n8n đang chạy và không có backlog mới quá hạn.
4. Xác nhận container/volume tạm đã bị xóa.
5. Cập nhật tài liệu này bằng kết quả thật và khuyến nghị phần cứng/query.

## 7. Kết quả readback ngày 25/08/2026

### 7.1. Kết luận ngắn

**Mức cảnh báo cho quyết định mở rộng: ĐỎ - chưa có bằng chứng kiểm thử tải.** Timer đã kích hoạt đúng lúc `03:00:09` giờ Việt Nam, nhưng service kết thúc ngay với mã `3` và state `skipped_no_verified_backup`. Không chạy hoặc retry lại bài test trong lượt readback này.

Nguyên nhân đã xác minh là mẫu tên thư mục trong script dùng `20????????T??????Z`, trong khi thư mục backup thật dùng dạng `YYYYMMDDTHHMMSSZ`. VPS có ba backup mang cờ `VERIFIED` khi kiểm bằng mẫu đúng, nhưng mẫu trong script tìm thấy `0`. Cùng lỗi mẫu tên khiến script đọc an toàn ban đầu trả `NO_REPORT`; báo cáo thật nằm ở run `20260824T200009Z`.

### 7.2. Kết quả từng nấc

| Nấc dự kiến | Connection | Trạng thái | TPS | Latency | Tải n8n/VPS trong nấc | Guard |
| --- | ---: | --- | ---: | ---: | --- | --- |
| 100% | 13 | Không chạy | Không có | Không có | Không có mẫu | Chưa được đánh giá |
| 150% | 20 | Không chạy | Không có | Không có | Không có mẫu | Chưa được đánh giá |
| 200% | 26 | Không chạy | Không có | Không có | Không có mẫu | Chưa được đánh giá |

File metrics chỉ có dòng tiêu đề. Guard theo CPU/RAM/API/connection không kích hoạt vì lượt chạy dừng ở cổng tìm backup trước khi lấy mẫu preflight và trước khi tạo tải.

### 7.3. Sức khỏe production sau thời điểm dự kiến chạy

Readback lúc khoảng `03:21-03:23` giờ Việt Nam:

- `check-production-invariants.ps1`: `ok=true`; không có identity trùng hoặc lệch thời điểm, Writing Portal có `52 synced/0 error`, không có job `ready` quá 10 phút, index/constraint hợp lệ và Lark replica gần nhất `completed`.
- Mapping API và Writing API: container `running`, health `healthy`, restart count `0`.
- PostgreSQL: container `running`, restart count `0`, `pg_isready` xác nhận đang nhận kết nối; snapshot có `10` connection production.
- n8n và n8n Dispatcher: container `running`, restart count `0`. Snapshot hiện thời: n8n `0,31% CPU / 469 MiB RAM`; Dispatcher `0,27% CPU / 313,9 MiB RAM`.
- VPS tại snapshot: load 1 phút `0,02`; RAM khả dụng `2.305.224 KiB` (khoảng `2,20 GiB`). Đây là trạng thái sau test, không phải tải đo trong ba nấc.
- Container tạm khớp `mapping-db-loadtest-*`: `0`; volume tạm khớp `mapping_db_loadtest_*`: `0`. Summary cũng ghi `temporary_container_removed=true` và `temporary_volume_removed=true`; do lượt chạy dừng sớm, môi trường tải nhiều khả năng chưa được tạo.

### 7.4. Khuyến nghị

- Không dùng lượt này để kết luận giữ, nâng hay tách phần cứng theo năng lực tải.
- Tạm giữ nguyên hạ tầng chỉ để bảo toàn production hiện tại; **dừng mọi rollout hoặc đề xuất mở rộng dựa trên bài test này**.
- Đức đã duyệt sửa lỗi và lên lịch mới; trạng thái triển khai được ghi ở mục 8. Bài test không được chạy sớm trong lúc sửa.

## 8. Lịch chạy lại đã duyệt

Ngày 25/08/2026, mẫu nhận diện backup/report đã được sửa từ `20????????T??????Z` thành `20??????T??????Z`, khớp run ID dạng `YYYYMMDDTHHMMSSZ`. Script đọc báo cáo đã đọc lại được report cũ thay vì trả `NO_REPORT`.

Lịch mới là **03:00 ngày 26/08/2026, giờ Việt Nam**, chạy đúng một lần bằng:

- Timer: `mapping-db-load-test-20260826.timer`.
- Service: `mapping-db-load-test-20260826.service`.

Readback sau triển khai:

- Timer `loaded`, `active`, `waiting`, `enabled`; lần chạy kế tiếp là `2026-08-25 20:00:00 UTC`, tương ứng 03:00 ngày 26/08 giờ Việt Nam.
- Service `inactive/dead`, chưa có `ExecMainStartTimestamp`; bài test không bị chạy sớm.
- Checksum SHA-256 của script local và bản đã cài trên VPS trùng nhau.
- Script đã cài có một mẫu đúng và không còn mẫu sai trong bước tìm backup; VPS hiện nhận diện được ba backup `VERIFIED`.
- Hai API vẫn `running/healthy`; PostgreSQL, n8n và n8n Dispatcher vẫn `running`.
- Không có container hoặc volume `mapping-db-loadtest` tạm tại thời điểm readback.

Việc đọc kết quả sau 03:00 ngày 26/08 vẫn phải tuân thủ mục 6 và không tự retry nếu lượt chạy dừng.

## 9. Kết quả lịch chạy lại 03:00 ngày 26/08 và readback 17/09

### 9.1. Kết quả tải đã lưu

Nguồn: `read-mapping-db-load-test.ps1`, report `20260825T200009Z` trên VPS. Thời điểm bắt đầu thật `2026-08-25T20:00:13Z` là 03:00:13 ngày 26/08 giờ Việt Nam. Trường `scheduled_for_local=2026-08-25T03:00:00+07:00` trong summary lệch một ngày so với thời điểm bắt đầu thật; cần sửa metadata ở lần thiết kế test sau, không dùng trường đó để xác định giờ chạy. State nghiệp vụ là `failed`, dù systemd ghi `Result=success` vì script kết thúc có kiểm soát sau khi guard dừng.

| Nấc | Kết quả | Giao dịch/TPS | Latency | Tải n8n/VPS | Guard |
| --- | --- | --- | --- | --- | --- |
| 100%: 13 kết nối, 60 giây | Hoàn thành | 36.152 giao dịch; 603,63 TPS | 21,015 ms | Trong nấc: n8n 1,97–7,90% CPU; load VPS tối đa 2,14; RAM khả dụng thấp nhất 1.936.224 KiB | Không kích hoạt |
| 150%: 20 kết nối | Dừng giữa nấc, không có tổng kết hiệu năng | Không có TPS đủ nấc | Không có latency đủ nấc | Trong nấc: n8n 0,38–5,35% CPU; load VPS đạt 5,28; RAM khả dụng thấp nhất 1.947.228 KiB | `host_load_high`, vượt ngưỡng 3,5 |
| 200%: 26 kết nối | Không chạy | Không có | Không có | Không có mẫu | Không đánh giá |

Trong các mẫu tải, Dispatcher cũ dùng 0,20–0,52% CPU; hai API đều `healthy`, connection PostgreSQL production 9–10, RAM luôn trên ngưỡng dừng. Guard kích hoạt do **load VPS**, không phải ngưỡng CPU n8n, Dispatcher, RAM, connection hay health API. `source_database_touched=false`; summary ghi đã xóa container và volume tạm.

### 9.2. Production tại readback ngày 17/09/2026

- `check-production-invariants.ps1` trả `ok=true`: không có identity duyệt trùng/lệch thời điểm, 0 job `ready` quá 10 phút, 0 index/constraint sai, Writing Portal 52 `synced`/0 `error`.
- Mapping API và Writing API hiện `running/healthy`, restart count 0. PostgreSQL `mapping-postgres` đang chạy và `pg_isready` báo nhận kết nối. n8n đang chạy, `/healthz` trả HTTP 200.
- Bản sao mapping sang Lark **không khỏe đầy đủ**: lần gần nhất có `latest_status=failed`, mã `ANOMALOUS_CHANGE_VOLUME`, kết thúc `2026-09-16T22:30:13Z`. Checker tổng thể vẫn trả `ok=true`, vì vậy phải xem riêng trạng thái bản sao thay vì chỉ dựa vào cờ đó.
- Dispatcher đã được thu hồi từ 06/09 theo kiến trúc hiện hành; việc không còn container `n8n-dispatcher` là trạng thái dự kiến, không coi là lỗi của test 26/08. Container `mapping-db-loadtest-*` và volume `mapping_db_loadtest_*` đều còn 0 ở lần kiểm hiện tại.

### 9.3. Kết luận và giới hạn

**Cảnh báo ĐỎ cho mở rộng.** Bài test hoàn thành 100% nhưng guard dừng ở 150%, không có bằng chứng cho 200%. Kết quả ngày 26/08 cũng đã cũ so với việc n8n chuyển PostgreSQL và thu hồi Dispatcher từ 06/09. Giữ hạ tầng hiện tại để bảo toàn production; dừng đề xuất tăng tải, rollout hoặc quyết định giữ/nâng/tách phần cứng dựa trên bài test này. Cần điều tra lỗi bản sao Lark và nguyên nhân load VPS vượt ngưỡng, rồi thiết kế lại phép đo phù hợp kiến trúc hiện hành và xin duyệt riêng trước bất kỳ test mới nào. Lượt đọc này không chạy hoặc retry kiểm thử tải, không sửa production.